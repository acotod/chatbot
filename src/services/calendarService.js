'use strict';
/**
 * Calendar Service — domain logic for calendars, slot generation, and appointments.
 *
 * Responsibilities:
 *   - Generate time slots from a calendar's working_hours config
 *   - Return available slots for a given date range
 *   - Book a slot atomically (SELECT FOR UPDATE to prevent double-booking)
 *   - Cancel / reschedule appointments (restores slot availability)
 *   - Cache available slots in Redis (60s TTL, invalidated on booking)
 *
 * Concurrency guarantee:
 *   bookSlot() wraps the slot update in a raw SQL transaction using
 *   SELECT ... FOR UPDATE NOWAIT. If two requests arrive simultaneously,
 *   the second will receive a PrismaClientKnownRequestError (P2034 or native
 *   lock error) which is caught and returned as { error: 'SLOT_TAKEN' }.
 *
 * External providers (Google / Outlook) are supported via the providerAdapter
 *   map at the bottom of this file. Internal calendars are fully self-contained.
 */

const { PrismaClient } = require('@prisma/client');
const crypto           = require('crypto');
const logger           = require('../utils/logger');

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// Redis cache helpers (lazy-required to avoid circular deps)
// ─────────────────────────────────────────────────────────────────────────────
let _redis = null;
function getRedis() {
  if (!_redis) {
    try { _redis = require('./redis'); } catch (_) { /* redis optional */ }
  }
  return _redis;
}

const SLOT_CACHE_TTL_SEC = 60;
const CONFIG_SECRET_PREFIX = 'encv1';

const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function cacheGet(key) {
  try {
    const r = getRedis();
    if (!r) return null;
    const val = await r.get(key);
    return val ? JSON.parse(val) : null;
  } catch (_) { return null; }
}

async function cacheSet(key, value) {
  try {
    const r = getRedis();
    if (!r) return;
    await r.setex(key, SLOT_CACHE_TTL_SEC, JSON.stringify(value));
  } catch (_) { /* best-effort */ }
}

async function cacheDel(key) {
  try {
    const r = getRedis();
    if (!r) return;
    await r.del(key);
  } catch (_) { /* best-effort */ }
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function toDateOnlyKey(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function normalizeBlockedDates(rawDates) {
  if (!Array.isArray(rawDates)) return [];
  const uniq = new Set();
  for (const item of rawDates) {
    const key = toDateOnlyKey(item);
    if (key) uniq.add(key);
  }
  return Array.from(uniq).sort();
}

function getCalendarBlockedDates(config) {
  return normalizeBlockedDates(config?.blocked_dates || config?.blockedDates || []);
}

function formatDateKeyInTimeZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(date);
}

async function clearSlotCachesForCalendar(calendarId) {
  await cacheDel(`slots:${calendarId}:default`);
  await cacheDel(`slots:${calendarId}:5`);

  const redis = getRedis();
  if (!redis || typeof redis.keys !== 'function') return;

  try {
    const keys = await redis.keys(`slots:${calendarId}:*`);
    if (Array.isArray(keys) && keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (_) {
    // best-effort cache cleanup
  }
}

function normalizeAgendaWorkingHours(raw) {
  if (!raw || typeof raw !== 'object') return {};

  const dayAliases = {
    mon: ['mon', 'monday', 'lun', 'lunes'],
    tue: ['tue', 'tuesday', 'mar', 'martes'],
    wed: ['wed', 'wednesday', 'mie', 'miercoles', 'miércoles'],
    thu: ['thu', 'thursday', 'jue', 'jueves'],
    fri: ['fri', 'friday', 'vie', 'viernes'],
    sat: ['sat', 'saturday', 'sab', 'sabado', 'sábado'],
    sun: ['sun', 'sunday', 'dom', 'domingo'],
  };

  const normalized = {};
  for (const [targetDay, aliases] of Object.entries(dayAliases)) {
    const sourceKey = Object.keys(raw).find((candidate) => aliases.includes(String(candidate || '').toLowerCase()));
    if (!sourceKey) continue;

    const value = raw[sourceKey];
    if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string' && typeof value[1] === 'string') {
      normalized[targetDay] = [[String(value[0]), String(value[1])]];
      continue;
    }

    if (Array.isArray(value) && value.every((range) => Array.isArray(range) && range.length >= 2)) {
      normalized[targetDay] = value.map((range) => [String(range[0]), String(range[1])]);
    }
  }

  return normalized;
}

function hasWorkingHours(workingHours) {
  if (!workingHours || typeof workingHours !== 'object') return false;
  return Object.values(workingHours).some((ranges) => Array.isArray(ranges) && ranges.length > 0);
}

async function ensureCalendarConfigForSlotDuration({ calendarId, tenantId, slotDurationMin, rangeDays = null }) {
  const requestedDuration = parsePositiveInteger(slotDurationMin);
  if (!calendarId || !requestedDuration) return;

  const calendar = await prisma.calendar.findUnique({
    where: { id: calendarId },
    select: { id: true, tenantId: true, timezone: true, config: true },
  });
  if (!calendar) return;

  const config = {
    ...(calendar.config ?? {}),
    timezone: String(calendar?.config?.timezone || calendar?.timezone || 'UTC'),
  };

  let changed = false;

  if (parsePositiveInteger(config.slot_duration_min) !== requestedDuration) {
    config.slot_duration_min = requestedDuration;
    changed = true;
  }

  if (!hasWorkingHours(config.working_hours)) {
    const agendaSettings = await prisma.configuracion.findUnique({
      where: {
        tenantId_clave: {
          tenantId: tenantId || calendar.tenantId,
          clave: 'agenda_settings',
        },
      },
      select: { valor: true },
    });

    const rawWorkingHours = agendaSettings?.valor?.workingHours ?? agendaSettings?.valor?.working_hours ?? null;
    const normalizedWorkingHours = normalizeAgendaWorkingHours(rawWorkingHours);
    if (hasWorkingHours(normalizedWorkingHours)) {
      config.working_hours = normalizedWorkingHours;
      changed = true;
    }

    const agendaTimeZone = String(agendaSettings?.valor?.timeZone || agendaSettings?.valor?.timezone || '').trim();
    if (agendaTimeZone && config.timezone !== agendaTimeZone) {
      config.timezone = agendaTimeZone;
      changed = true;
    }
  }

  if (!changed) return;

  await prisma.calendar.update({
    where: { id: calendarId },
    data: {
      timezone: String(config.timezone || calendar.timezone || 'UTC'),
      config,
      updatedAt: new Date(),
    },
  });

  await prisma.calendarSlot.deleteMany({
    where: {
      calendarId,
      status: 'available',
      startTime: { gte: new Date() },
    },
  });

  await cacheDel(`slots:${calendarId}:default`);
  if (rangeDays !== null && rangeDays !== undefined) {
    await cacheDel(`slots:${calendarId}:${rangeDays}`);
  }

  await generateSlots(calendarId, rangeDays);
}

function getUtcRangeForDateKey(dateKey, timeZone) {
  const [yearStr, monthStr, dayStr] = String(dateKey).split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  const startUtc = zonedDateTimeToUtc({ year, month, day, hour: 0, minute: 0 }, timeZone);
  const endDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const endUtc = zonedDateTimeToUtc(
    {
      year: endDate.getUTCFullYear(),
      month: endDate.getUTCMonth() + 1,
      day: endDate.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    timeZone
  );

  return { startUtc, endUtc };
}

async function setCalendarDayOff({ calendarId, tenantId, date, blocked }) {
  const dateKey = toDateOnlyKey(date);
  if (!dateKey) return { error: 'INVALID_DATE' };

  const calendar = await prisma.calendar.findFirst({
    where: { id: calendarId, tenantId },
    select: { id: true, config: true, timezone: true },
  });
  if (!calendar) return { error: 'NOT_FOUND' };

  const config = asObject(calendar.config);
  const blockedDates = new Set(getCalendarBlockedDates(config));
  const shouldBlock = Boolean(blocked);
  let changed = false;

  if (shouldBlock && !blockedDates.has(dateKey)) {
    blockedDates.add(dateKey);
    changed = true;
  }
  if (!shouldBlock && blockedDates.has(dateKey)) {
    blockedDates.delete(dateKey);
    changed = true;
  }

  const nextBlockedDates = Array.from(blockedDates).sort();
  if (changed) {
    await prisma.calendar.update({
      where: { id: calendarId },
      data: {
        config: {
          ...config,
          blocked_dates: nextBlockedDates,
        },
        updatedAt: new Date(),
      },
    });
  }

  const calendarTimeZone = String(config.timezone || calendar.timezone || 'UTC');
  const { startUtc, endUtc } = getUtcRangeForDateKey(dateKey, calendarTimeZone);

  if (shouldBlock) {
    await prisma.calendarSlot.deleteMany({
      where: {
        calendarId,
        status: 'available',
        startTime: { gte: startUtc, lt: endUtc },
      },
    });
  } else {
    const now = new Date();
    const daysAhead = Math.ceil((startUtc.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    if (daysAhead >= 0) {
      await generateSlots(calendarId, Math.max(daysAhead + 1, 1));
    }
  }

  await clearSlotCachesForCalendar(calendarId);

  return {
    ok: true,
    date: dateKey,
    blocked: shouldBlock,
    blockedDates: nextBlockedDates,
  };
}

async function getCalendarDayOffDates({ calendarId, tenantId }) {
  const calendar = await prisma.calendar.findFirst({
    where: { id: calendarId, tenantId },
    select: { id: true, config: true },
  });
  if (!calendar) return { error: 'NOT_FOUND' };

  const config = asObject(calendar.config);
  return {
    calendarId,
    blockedDates: getCalendarBlockedDates(config),
  };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getConfigEncryptionKey() {
  const configuredKey = process.env.CONFIG_ENCRYPTION_KEY || process.env.WA_TOKEN_ENCRYPTION_KEY;
  const fallbackKey = process.env.JWT_SECRET;
  const secret = configuredKey || fallbackKey || 'dev-secret';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function decryptConfigSecret(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!raw.startsWith(`${CONFIG_SECRET_PREFIX}:`)) return raw;

  const parts = raw.split(':');
  if (parts.length !== 4) return '';

  try {
    const [, ivB64, authTagB64, encryptedB64] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getConfigEncryptionKey(),
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedB64, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8').trim();
  } catch (_) {
    return '';
  }
}

function getCalendarProviderConfig(calendar) {
  const config = asObject(calendar?.config);
  const provider = String(config.provider || 'internal').toLowerCase();
  const credentials = asObject(config.provider_credentials || config.providerCredentials);

  return {
    provider,
    syncEnabled: config.sync !== false,
    accessToken: decryptConfigSecret(credentials.access_token || credentials.accessToken || null) || null,
    refreshToken: decryptConfigSecret(credentials.refresh_token || credentials.refreshToken || null) || null,
    tokenUri: credentials.token_uri || credentials.tokenUri || GOOGLE_OAUTH_TOKEN_URL,
    clientId:
      credentials.client_id ||
      credentials.clientId ||
      process.env.GOOGLE_CLIENT_ID ||
      process.env.GOOGLE_OAUTH_CLIENT_ID ||
      null,
    clientSecret:
      credentials.client_secret ||
      credentials.clientSecret ||
      process.env.GOOGLE_CLIENT_SECRET ||
      process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
      null,
    calendarExternalId:
      credentials.calendar_id ||
      credentials.calendarId ||
      config.calendar_external_id ||
      config.external_calendar_id ||
      config.google_calendar_id ||
      'primary',
  };
}

async function persistGoogleAccessToken(calendarId, newAccessToken, expiresInSec = null) {
  const calendar = await prisma.calendar.findUnique({
    where: { id: calendarId },
    select: { config: true },
  });
  if (!calendar) return;

  const config = asObject(calendar.config);
  const providerCredentials = asObject(config.provider_credentials || config.providerCredentials);
  const nextProviderCredentials = {
    ...providerCredentials,
    access_token: newAccessToken,
  };

  if (Number.isFinite(expiresInSec) && Number(expiresInSec) > 0) {
    const expiresAtIso = new Date(Date.now() + Number(expiresInSec) * 1000).toISOString();
    nextProviderCredentials.expires_at = expiresAtIso;
  }

  await prisma.calendar.update({
    where: { id: calendarId },
    data: {
      config: {
        ...config,
        provider_credentials: nextProviderCredentials,
      },
    },
  });
}

async function refreshGoogleAccessToken(calendar) {
  const providerCfg = getCalendarProviderConfig(calendar);
  if (providerCfg.provider !== 'google' || !providerCfg.syncEnabled) return null;

  if (!providerCfg.refreshToken || !providerCfg.clientId || !providerCfg.clientSecret) {
    logger.warn(
      {
        calendarId: calendar.id,
        hasRefreshToken: Boolean(providerCfg.refreshToken),
        hasClientId: Boolean(providerCfg.clientId),
        hasClientSecret: Boolean(providerCfg.clientSecret),
      },
      'calendarService.google refresh skipped: missing oauth credentials'
    );
    return null;
  }

  const tokenEndpoint = providerCfg.tokenUri || GOOGLE_OAUTH_TOKEN_URL;
  const body = new URLSearchParams({
    client_id: providerCfg.clientId,
    client_secret: providerCfg.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: providerCfg.refreshToken,
  });

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    throw new Error(`google_refresh_token_failed:${resp.status}:${JSON.stringify(json).slice(0, 400)}`);
  }

  await persistGoogleAccessToken(calendar.id, json.access_token, json.expires_in);
  return json.access_token;
}

async function googleRequestWithRefresh({ calendar, method, path, body, metadata }) {
  const providerCfg = getCalendarProviderConfig(calendar);
  if (providerCfg.provider !== 'google' || !providerCfg.syncEnabled) return null;
  if (!providerCfg.accessToken) {
    logger.warn({ calendarId: calendar.id, path }, 'calendarService.google request skipped: missing access token');
    return { ok: false, skipped: true, status: 0, bodyText: '' };
  }

  const makeRequest = async (token) => {
    const resp = await fetch(`${GOOGLE_CALENDAR_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, bodyText: text };
  };

  let result = await makeRequest(providerCfg.accessToken);
  if (result.ok) return result;

  const shouldRetry = result.status === 401 || result.status === 403;
  if (!shouldRetry) return result;

  try {
    const refreshedToken = await refreshGoogleAccessToken(calendar);
    if (!refreshedToken) return result;
    result = await makeRequest(refreshedToken);
    if (!result.ok) {
      logger.warn(
        {
          calendarId: calendar.id,
          path,
          status: result.status,
          response: result.bodyText.slice(0, 400),
          metadata,
        },
        'calendarService.google request failed after token refresh'
      );
    }
    return result;
  } catch (refreshErr) {
    logger.error(
      {
        calendarId: calendar.id,
        path,
        message: refreshErr.message,
        metadata,
      },
      'calendarService.google token refresh failed'
    );
    return result;
  }
}

function getExternalEventId(metadata) {
  const m = asObject(metadata);
  return m.external_event_id || m.google_event_id || null;
}

function withExternalEventId(metadata, eventId) {
  const m = asObject(metadata);
  return {
    ...m,
    external_event_id: eventId,
    google_event_id: eventId,
  };
}

/**
 * Look up an already-created Google Calendar event for this appointment before
 * creating a new one. Guards against duplicate/orphan events when a previous
 * attempt succeeded on Google's side but crashed before persisting
 * `external_event_id` locally (e.g. process restart between the two steps).
 */
async function findExistingGoogleCalendarEvent({ calendar, appointment, providerCfg }) {
  const timeMin = new Date(appointment.startTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(appointment.endTime.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const marker = `Appointment ID: ${appointment.id}`;
  const query = new URLSearchParams({ q: marker, timeMin, timeMax, singleEvents: 'true' });

  const response = await googleRequestWithRefresh({
    calendar,
    method: 'GET',
    path: `/calendars/${encodeURIComponent(providerCfg.calendarExternalId)}/events?${query.toString()}`,
    metadata: { appointmentId: appointment.id, operation: 'find_existing_event' },
  });
  if (!response || response.skipped || !response.ok) return null;

  try {
    const json = JSON.parse(response.bodyText || '{}');
    const items = Array.isArray(json.items) ? json.items : [];
    const match = items.find((item) => String(item?.description || '').includes(marker));
    return match?.id || null;
  } catch (_) {
    return null;
  }
}

async function createGoogleCalendarEvent({ calendar, appointment }) {
  const providerCfg = getCalendarProviderConfig(calendar);
  if (providerCfg.provider !== 'google' || !providerCfg.syncEnabled) return null;

  const existingEventId = await findExistingGoogleCalendarEvent({ calendar, appointment, providerCfg }).catch(() => null);
  if (existingEventId) return existingEventId;

  const eventPayload = {
    summary: `Cita ${appointment?.metadata?.user_name ? `- ${appointment.metadata.user_name}` : ''}`.trim(),
    description: [
      `Appointment ID: ${appointment.id}`,
      `User: ${appointment.userKey}`,
      appointment.conversationId ? `Conversation: ${appointment.conversationId}` : null,
    ].filter(Boolean).join('\n'),
    start: {
      dateTime: appointment.startTime.toISOString(),
      timeZone: calendar.timezone || 'UTC',
    },
    end: {
      dateTime: appointment.endTime.toISOString(),
      timeZone: calendar.timezone || 'UTC',
    },
  };

  const response = await googleRequestWithRefresh({
    calendar,
    method: 'POST',
    path: `/calendars/${encodeURIComponent(providerCfg.calendarExternalId)}/events`,
    body: eventPayload,
    metadata: { appointmentId: appointment.id, operation: 'create_event' },
  });

  if (!response || response.skipped) return null;
  if (!response.ok) {
    throw new Error(`google_create_event_failed:${response.status}:${response.bodyText.slice(0, 400)}`);
  }

  let json = {};
  try {
    json = JSON.parse(response.bodyText || '{}');
  } catch (_) {
    json = {};
  }
  return json?.id || null;
}

async function cancelGoogleCalendarEvent({ calendar, metadata }) {
  const providerCfg = getCalendarProviderConfig(calendar);
  if (providerCfg.provider !== 'google' || !providerCfg.syncEnabled) return;

  const externalEventId = getExternalEventId(metadata);
  if (!externalEventId) return;

  const response = await googleRequestWithRefresh({
    calendar,
    method: 'DELETE',
    path: `/calendars/${encodeURIComponent(providerCfg.calendarExternalId)}/events/${encodeURIComponent(externalEventId)}`,
    metadata: { externalEventId, operation: 'cancel_event' },
  });

  if (!response || response.skipped) return;
  if (response.status === 404 || response.status === 410) return;
  if (!response.ok) {
    throw new Error(`google_cancel_event_failed:${response.status}:${response.bodyText.slice(0, 400)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot generation helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Parse "HH:MM" into { hours, minutes }.
 */
function parseTime(str) {
  const [h, m] = str.split(':').map(Number);
  return { hours: h, minutes: m };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = localAsUtc;

  for (let i = 0; i < 3; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(guess), timeZone);
    const next = localAsUtc - offset;
    if (next === guess) break;
    guess = next;
  }

  return new Date(guess);
}

function normalizeWorkingHourRanges(hours) {
  // Backward-compatible: ['09:00','18:00']
  if (Array.isArray(hours) && hours.length >= 2 && typeof hours[0] === 'string' && typeof hours[1] === 'string') {
    return [[hours[0], hours[1]]];
  }

  // New format: [['08:00','10:00'], ['14:00','16:00']]
  if (Array.isArray(hours)) {
    return hours
      .filter((range) => Array.isArray(range) && range.length >= 2)
      .map((range) => [String(range[0]), String(range[1])]);
  }

  return [];
}

/**
 * Generate slot start/end pairs for a single day based on working_hours config.
 *
 * @param {Date}   date             Day to generate slots for (UTC midnight)
 * @param {object} config           Calendar config JSONB
 * @param {string} config.timezone  e.g. "America/Mexico_City"
 * @param {object} config.working_hours  { mon: ["09:00","18:00"], ... }
 * @param {number} config.slot_duration_min  e.g. 30
 * @param {number} config.buffer_min  e.g. 5
 * @returns {{ start: Date, end: Date }[]}
 */
function generateSlotsForDay(date, config) {
  const dayName = DAY_NAMES[date.getDay()];
  const hours   = config.working_hours?.[dayName];
  const ranges = normalizeWorkingHourRanges(hours);
  if (ranges.length === 0) return [];
  const timeZone = String(config.timezone || 'UTC');
  const blockedDates = new Set(getCalendarBlockedDates(config));
  const dayKey = formatDateKeyInTimeZone(date, timeZone);
  if (blockedDates.has(dayKey)) return [];
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  const slotDuration = (config.slot_duration_min ?? 30) * 60 * 1000;
  const buffer       = (config.buffer_min ?? 0)         * 60 * 1000;

  const slots = [];
  for (const [startStr, endStr] of ranges) {
    const startT = parseTime(startStr);
    const endT   = parseTime(endStr);

    const dayStart = zonedDateTimeToUtc(
      { year, month, day, hour: startT.hours, minute: startT.minutes },
      timeZone
    );
    const dayEnd = zonedDateTimeToUtc(
      { year, month, day, hour: endT.hours, minute: endT.minutes },
      timeZone
    );

    let cursor = dayStart.getTime();
    while (cursor + slotDuration <= dayEnd.getTime()) {
      slots.push({
        start: new Date(cursor),
        end  : new Date(cursor + slotDuration),
      });
      cursor += slotDuration + buffer;
    }
  }

  return slots;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure slots exist for the next N days for a calendar.
 * Idempotent — skips ranges already present.
 *
 * @param {string} calendarId  UUID
 * @param {number} days        Number of days ahead to generate (default: from config)
 * @returns {Promise<number>}  Count of slots created
 */
async function generateSlots(calendarId, days = null) {
  const calendar = await prisma.calendar.findUnique({
    where : { id: calendarId },
    select: { config: true, timezone: true },
  });
  if (!calendar) throw new Error(`Calendar ${calendarId} not found`);

  const config    = {
    ...(calendar.config ?? {}),
    timezone: String(calendar?.config?.timezone || calendar?.timezone || 'UTC'),
  };
  const rangeDays = days ?? config.advance_days ?? 14;
  const maxPerDay = config.max_per_day ?? 999;

  const now   = new Date();
  const slots = [];

  for (let d = 0; d < rangeDays; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    day.setHours(0, 0, 0, 0);

    const daySlots = generateSlotsForDay(day, config).slice(0, maxPerDay);

    for (const { start, end } of daySlots) {
      // Skip past slots
      if (start <= now) continue;

      // Check if slot already exists
      const exists = await prisma.calendarSlot.findFirst({
        where : { calendarId, startTime: start },
        select: { id: true },
      });
      if (!exists) {
        slots.push({ calendarId, startTime: start, endTime: end });
      }
    }
  }

  if (slots.length > 0) {
    await prisma.calendarSlot.createMany({ data: slots, skipDuplicates: true });
  }

  return slots.length;
}

/**
 * Get available slots for a calendar in the next N days.
 * Results are cached in Redis for SLOT_CACHE_TTL_SEC seconds.
 *
 * @param {string} calendarId
 * @param {number} rangeDays  (default from calendar config)
 * @returns {Promise<{ id, startTime, endTime }[]>}
 */
async function getAvailableSlots(calendarId, rangeDays = null, options = {}) {
  const requestedDuration = parsePositiveInteger(options?.slotDurationMin);
  if (requestedDuration) {
    await ensureCalendarConfigForSlotDuration({
      calendarId,
      tenantId: options?.tenantId,
      slotDurationMin: requestedDuration,
      rangeDays,
    });
  }

  const cacheKey = `slots:${calendarId}:${rangeDays ?? 'default'}:${requestedDuration ?? 'default'}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  const calendar = await prisma.calendar.findUnique({
    where : { id: calendarId },
    select: { config: true, timezone: true },
  });
  const calendarTimeZone = String(calendar?.config?.timezone || calendar?.timezone || 'UTC');
  const blockedDates = new Set(getCalendarBlockedDates(calendar?.config || {}));
  const days = rangeDays ?? calendar?.config?.range_days ?? calendar?.config?.advance_days ?? 5;

  const from = new Date();
  const to   = new Date();
  to.setDate(to.getDate() + days);

  // Auto-generate if no slots exist yet for this range
  const existingCount = await prisma.calendarSlot.count({
    where: { calendarId, status: 'available', startTime: { gte: from, lte: to } },
  });
  if (existingCount === 0) {
    await generateSlots(calendarId, days);
  }

  const slots = await prisma.calendarSlot.findMany({
    where  : { calendarId, status: 'available', startTime: { gte: from, lte: to } },
    orderBy: { startTime: 'asc' },
    select : { id: true, startTime: true, endTime: true },
  });

  const slotsWithTimeZone = slots.map((slot) => ({
    ...slot,
    timezone: calendarTimeZone,
  })).filter((slot) => !blockedDates.has(formatDateKeyInTimeZone(new Date(slot.startTime), calendarTimeZone)));

  await cacheSet(cacheKey, slotsWithTimeZone);
  return slotsWithTimeZone;
}

/**
 * Prisma `where` fragment for an Agente that may currently receive new bookings.
 * Kept separate from `estado` (employment status) so a temporary leave does not
 * require deactivating the agente account everywhere else (solicitudes, CRM, etc).
 */
function agenteBookableWhereFragment(now = new Date()) {
  return {
    estado: 'activo',
    disponibleParaCitas: true,
    OR: [{ ausenteHasta: null }, { ausenteHasta: { lt: now } }],
  };
}

/**
 * Single source of truth for "can this agente be booked right now?" — used by
 * both the direct agente_id path and the puesto-based resolution path, which
 * previously disagreed (only the latter checked agente state).
 *
 * @param {string} tenantId
 * @param {number} agenteId
 * @returns {Promise<boolean>}
 */
async function isAgenteBookable(tenantId, agenteId) {
  if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) return false;

  const agente = await prisma.agente.findFirst({
    where : { id: agenteId, tenantId, ...agenteBookableWhereFragment() },
    select: { id: true },
  });

  return Boolean(agente);
}

/**
 * Resolve an active calendar id assigned to an agente within a tenant.
 *
 * @param {string} tenantId
 * @param {number} agenteId
 * @returns {Promise<string|null>}
 */
async function getCalendarIdForAgente(tenantId, agenteId) {
  if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) return null;

  const calendar = await prisma.calendar.findFirst({
    where  : {
      tenantId,
      agenteId,
      activo: true,
      agente: { is: agenteBookableWhereFragment() },
    },
    orderBy: { createdAt: 'desc' },
    select : { id: true },
  });

  return calendar?.id ?? null;
}

/**
 * Resolve calendar + assigned agent metadata for downstream task routing.
 *
 * @param {string} calendarId
 * @param {string} tenantId
 * @returns {Promise<{ calendarId: string, calendarName: string|null, agenteId: number|null, agenteNombre: string|null }|null>}
 */
async function getCalendarAssignmentContext(calendarId, tenantId) {
  if (!calendarId || !tenantId) return null;

  const calendar = await prisma.calendar.findFirst({
    where: { id: calendarId, tenantId, activo: true },
    select: {
      id: true,
      name: true,
      timezone: true,
      config: true,
      agenteId: true,
      agente: {
        select: { id: true, nombre: true, estado: true },
      },
    },
  });

  if (!calendar) return null;

  const isAgentActive = String(calendar.agente?.estado || '').toLowerCase() === 'activo';
  return {
    calendarId: calendar.id,
    calendarName: calendar.name ?? null,
    timezone: String(calendar?.config?.timezone || calendar?.timezone || 'UTC'),
    agenteId: isAgentActive ? Number(calendar.agente?.id ?? calendar.agenteId ?? 0) || null : null,
    agenteNombre: isAgentActive ? (calendar.agente?.nombre ?? null) : null,
  };
}

function buildPuestoToken({ puestoId = null, puestoNombre = null }) {
  const safePuestoId = Number.isInteger(puestoId) && puestoId > 0 ? String(puestoId) : '';
  const safePuestoNombre = String(puestoNombre || '').trim().toLowerCase();
  return safePuestoId || safePuestoNombre || 'unknown';
}

function buildPuestoCursorKey({ tenantId, puestoId = null, puestoNombre = null }) {
  const safeTenant = String(tenantId || '').trim();
  return `calendar:rr:${safeTenant}:${buildPuestoToken({ puestoId, puestoNombre })}`;
}

// Durable fallback for the round-robin cursor so a Redis outage degrades to
// "keep rotating from the last known pointer", not to random selection.
async function getPersistedRoundRobinCursor(tenantId, puestoToken) {
  try {
    const row = await prisma.configuracion.findUnique({
      where: { tenantId_clave: { tenantId, clave: `calendar_rr_last_${puestoToken}` } },
      select: { valor: true },
    });
    return row?.valor?.lastCalendarId ?? null;
  } catch (_) {
    return null;
  }
}

async function setPersistedRoundRobinCursor(tenantId, puestoToken, calendarId) {
  try {
    await prisma.configuracion.upsert({
      where: { tenantId_clave: { tenantId, clave: `calendar_rr_last_${puestoToken}` } },
      update: { valor: { lastCalendarId: calendarId } },
      create: { tenantId, clave: `calendar_rr_last_${puestoToken}`, valor: { lastCalendarId: calendarId } },
    });
  } catch (_) {
    // best-effort; Redis pointer still covers the common case
  }
}

/**
 * Pick the calendar immediately after `lastCalendarId` in a stable, sorted list.
 * Unlike an INCR-based index, this survives additions/removals in the roster:
 * if the last-assigned calendar is gone, rotation simply restarts at index 0
 * instead of skipping or repeating entries.
 */
function pickNextInRotation(calendars, lastCalendarId) {
  if (!Array.isArray(calendars) || calendars.length === 0) return null;
  if (!lastCalendarId) return calendars[0]?.id ?? null;
  const lastIndex = calendars.findIndex((c) => c.id === lastCalendarId);
  const nextIndex = lastIndex === -1 ? 0 : (lastIndex + 1) % calendars.length;
  return calendars[nextIndex]?.id ?? null;
}

async function chooseCalendarByRoundRobin(calendars, { tenantId, puestoId = null, puestoNombre = null }) {
  if (!Array.isArray(calendars) || calendars.length === 0) return null;

  const puestoToken = buildPuestoToken({ puestoId, puestoNombre });
  const redisKey = buildPuestoCursorKey({ tenantId, puestoId, puestoNombre });
  const redis = getRedis();

  let lastCalendarId = null;
  if (redis) {
    try {
      lastCalendarId = await redis.get(redisKey);
    } catch (_) {
      lastCalendarId = null;
    }
  }
  if (!lastCalendarId) {
    lastCalendarId = await getPersistedRoundRobinCursor(tenantId, puestoToken);
  }

  const nextCalendarId = pickNextInRotation(calendars, lastCalendarId);
  if (!nextCalendarId) return null;

  if (redis) {
    try {
      // Keep a bounded TTL so stale puesto keys disappear automatically.
      await redis.set(redisKey, nextCalendarId, 'EX', 60 * 60 * 24 * 30);
    } catch (_) {
      // falls through to the persisted fallback below
    }
  }
  await setPersistedRoundRobinCursor(tenantId, puestoToken, nextCalendarId);

  return nextCalendarId;
}

/**
 * Pick the calendar whose agente currently has the fewest active appointments
 * in the given window — a workload-aware alternative to random/round-robin.
 */
async function chooseCalendarByLeastBusy(calendars, { windowDays = 7 } = {}) {
  if (!Array.isArray(calendars) || calendars.length === 0) return null;

  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const counts = await Promise.all(
    calendars.map((calendar) =>
      prisma.appointment.count({
        where: {
          calendarId: calendar.id,
          status: { in: ['scheduled', 'rescheduled'] },
          startTime: { gte: now, lte: windowEnd },
        },
      })
    )
  );

  let bestIndex = 0;
  for (let i = 1; i < calendars.length; i += 1) {
    if (counts[i] < counts[bestIndex]) bestIndex = i;
  }
  return calendars[bestIndex]?.id ?? null;
}

async function getCalendarsForPuesto(tenantId, { puestoId = null, puestoNombre = null } = {}) {
  if (!tenantId) return [];

  const hasPuestoId = Number.isInteger(puestoId) && puestoId > 0;
  const normalizedPuestoNombre = String(puestoNombre || '').trim();
  const hasPuestoNombre = normalizedPuestoNombre.length > 0;
  if (!hasPuestoId && !hasPuestoNombre) return [];

  const calendars = await prisma.calendar.findMany({
    where: {
      tenantId,
      activo: true,
      agente: {
        is: {
          tenantId,
          ...agenteBookableWhereFragment(),
          ...(hasPuestoId
            ? { puestoId }
            : {
                puesto: {
                  is: {
                    nombre: {
                      equals: normalizedPuestoNombre,
                      mode: 'insensitive',
                    },
                  },
                },
              }),
        },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      agenteId: true,
      agente: {
        select: { id: true, nombre: true },
      },
    },
  });

  return calendars.map((calendar) => ({
    id: calendar.id,
    name: calendar.name ?? null,
    agenteId: Number(calendar.agente?.id ?? calendar.agenteId ?? 0) || null,
    agenteNombre: calendar.agente?.nombre ?? null,
  }));
}

/**
 * Resolve an active calendar for agents matching a puesto in a tenant.
 * Strategy can be random (default) or round_robin.
 *
 * @param {string} tenantId
 * @param {{ puestoId?: number|null, puestoNombre?: string|null, strategy?: string|null }} opts
 * @returns {Promise<string|null>}
 */
async function getCalendarIdForPuesto(tenantId, { puestoId = null, puestoNombre = null, strategy = 'random', workloadWindowDays = 7 } = {}) {
  if (!tenantId) return null;

  const normalizedPuestoNombre = String(puestoNombre || '').trim();
  const calendars = await getCalendarsForPuesto(tenantId, {
    puestoId,
    puestoNombre: normalizedPuestoNombre,
  });

  if (!calendars.length) return null;

  const normalizedStrategy = String(strategy || 'random').trim().toLowerCase();
  if (normalizedStrategy === 'round_robin' || normalizedStrategy === 'roundrobin') {
    return chooseCalendarByRoundRobin(calendars, { tenantId, puestoId, puestoNombre: normalizedPuestoNombre });
  }
  if (normalizedStrategy === 'least_busy' || normalizedStrategy === 'leastbusy') {
    return chooseCalendarByLeastBusy(calendars, { windowDays: workloadWindowDays });
  }

  const randomIndex = Math.floor(Math.random() * calendars.length);
  return calendars[randomIndex]?.id ?? null;
}

/**
 * Resolve a random active calendar for agents matching a puesto in a tenant.
 *
 * @param {string} tenantId
 * @param {{ puestoId?: number|null, puestoNombre?: string|null }} opts
 * @returns {Promise<string|null>}
 */
async function getRandomCalendarIdForPuesto(tenantId, { puestoId = null, puestoNombre = null } = {}) {
  return getCalendarIdForPuesto(tenantId, { puestoId, puestoNombre, strategy: 'random' });
}

/**
 * Book a slot atomically.
 * Uses SELECT FOR UPDATE NOWAIT inside a transaction to prevent double-booking.
 *
 * @param {object} opts
 * @param {string} opts.calendarId
 * @param {string} opts.slotId         UUID of the chosen CalendarSlot
 * @param {string} opts.tenantId
 * @param {string} opts.userKey        Phone number or session identifier
 * @param {string} [opts.conversationId]
 * @param {object} [opts.metadata]     e.g. { user_name, notes }
 *
 * @returns {Promise<{ appointment: object } | { error: 'SLOT_TAKEN' | 'SLOT_NOT_FOUND' }>}
 */
async function bookSlot({ calendarId, slotId, tenantId, userKey, conversationId, metadata = {} }) {
  try {
    const targetCalendar = await prisma.calendar.findUnique({
      where: { id: calendarId },
      select: { agenteId: true },
    });
    if (targetCalendar?.agenteId) {
      const slot = await prisma.calendarSlot.findUnique({
        where: { id: slotId },
        select: { startTime: true, endTime: true },
      });
      if (slot) {
        const { checkAgenteScheduleConflict } = require('./scheduleConflictService');
        const { hasConflict } = await checkAgenteScheduleConflict({
          tenantId,
          agenteId: targetCalendar.agenteId,
          startAt: slot.startTime,
          endAt: slot.endTime,
        });
        if (hasConflict) {
          return { error: 'AGENT_BUSY' };
        }
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // Lock the slot row — NOWAIT raises immediately if locked by another transaction
      const rows = await tx.$queryRaw`
        SELECT id, start_time, end_time, status
        FROM calendar_slots
        WHERE id = ${slotId}::uuid
          AND calendar_id = ${calendarId}::uuid
          AND status = 'available'
        FOR UPDATE NOWAIT
      `;

      if (!rows || rows.length === 0) {
        throw Object.assign(new Error('SLOT_NOT_AVAILABLE'), { code: 'SLOT_NOT_AVAILABLE' });
      }

      const slot = rows[0];

      // Create appointment
      const appointment = await tx.appointment.create({
        data: {
          tenantId,
          conversationId: conversationId ?? null,
          userKey,
          calendarId,
          startTime: slot.start_time,
          endTime  : slot.end_time,
          status   : 'scheduled',
          metadata,
        },
      });

      // Mark slot as booked
      await tx.$executeRaw`
        UPDATE calendar_slots
        SET status = 'booked', appointment_id = ${appointment.id}::uuid, updated_at = NOW()
        WHERE id = ${slotId}::uuid
      `;

      return appointment;
    });

    const calendar = await prisma.calendar.findFirst({
      where: { id: calendarId, tenantId },
      select: { id: true, name: true, timezone: true, config: true },
    });

    if (calendar) {
      try {
        const externalEventId = await createGoogleCalendarEvent({ calendar, appointment: result });
        if (externalEventId) {
          const updatedMetadata = withExternalEventId(result.metadata, externalEventId);
          const updatedAppointment = await prisma.appointment.update({
            where: { id: result.id },
            data: { metadata: updatedMetadata },
          });
          result.metadata = updatedAppointment.metadata;
        }
      } catch (syncErr) {
        logger.error(
          {
            calendarId,
            appointmentId: result.id,
            message: syncErr.message,
          },
          'calendarService.bookSlot google sync failed'
        );
      }
    }

    // Invalidate availability cache for this calendar
    await cacheDel(`slots:${calendarId}:default`);
    await cacheDel(`slots:${calendarId}:5`);

    return { appointment: result };
  } catch (err) {
    if (err.code === 'SLOT_NOT_AVAILABLE') {
      return { error: 'SLOT_NOT_FOUND' };
    }
    // PostgreSQL lock_not_available error code
    if (err.message?.includes('could not obtain lock') || err.code === '55P03') {
      return { error: 'SLOT_TAKEN' };
    }
    logger.error({ calendarId, slotId, message: err.message }, 'calendarService.bookSlot failed');
    throw err;
  }
}

/**
 * Cancel an appointment and restore the slot to 'available'.
 *
 * @param {string} appointmentId  UUID
 * @param {string} tenantId       For scoping (prevents cross-tenant cancel)
 * @returns {Promise<{ ok: true } | { error: string }>}
 */
async function cancelAppointment(appointmentId, tenantId) {
  try {
    const existing = await prisma.appointment.findFirst({
      where: { id: appointmentId, tenantId },
      select: {
        id: true,
        status: true,
        metadata: true,
        calendar: {
          select: {
            id: true,
            name: true,
            timezone: true,
            config: true,
          },
        },
      },
    });

    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.status === 'cancelled') return { error: 'ALREADY_CANCELLED' };

    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({
        where: { id: appointmentId },
        data : { status: 'cancelled', updatedAt: new Date() },
      });

      // Restore slot
      await tx.$executeRaw`
        UPDATE calendar_slots
        SET status = 'available', appointment_id = NULL, updated_at = NOW()
        WHERE appointment_id = ${appointmentId}::uuid
      `;
    });

    try {
      await cancelGoogleCalendarEvent({ calendar: existing.calendar, metadata: existing.metadata });
    } catch (syncErr) {
      logger.error(
        {
          appointmentId,
          calendarId: existing.calendar?.id,
          message: syncErr.message,
        },
        'calendarService.cancelAppointment google sync failed'
      );
    }

    return { ok: true };
  } catch (err) {
    logger.error({ appointmentId, message: err.message }, 'calendarService.cancelAppointment failed');
    throw err;
  }
}

/**
 * Reschedule an appointment to a new slot.
 * Cancels the original slot, books the new one atomically.
 *
 * @param {string} appointmentId
 * @param {string} newSlotId
 * @param {string} tenantId
 * @returns {Promise<{ appointment: object } | { error: string }>}
 */
async function rescheduleAppointment(appointmentId, newSlotId, tenantId) {
  // Load current appointment
  const existing = await prisma.appointment.findFirst({
    where : { id: appointmentId, tenantId },
    select: {
      id: true,
      calendarId: true,
      userKey: true,
      conversationId: true,
      metadata: true,
      status: true,
      calendar: {
        select: {
          id: true,
          name: true,
          timezone: true,
          config: true,
        },
      },
    },
  });
  if (!existing) return { error: 'NOT_FOUND' };
  if (existing.status === 'cancelled') return { error: 'ALREADY_CANCELLED' };

  // Book the new slot first to avoid leaving the user without appointment
  // when the target slot is no longer available.
  const bookResult = await bookSlot({
    calendarId     : existing.calendarId,
    slotId         : newSlotId,
    tenantId,
    userKey        : existing.userKey,
    conversationId : existing.conversationId,
    metadata       : { ...existing.metadata, rescheduled_from: appointmentId },
  });

  if (bookResult.error) return bookResult;

  // Once the new booking is secured, release the old slot and mark old
  // appointment as rescheduled in one DB transaction.
  await prisma.$transaction(async (tx) => {
    await tx.appointment.update({
      where: { id: appointmentId },
      data : { status: 'rescheduled', updatedAt: new Date() },
    });

    await tx.$executeRaw`
      UPDATE calendar_slots
      SET status = 'available', appointment_id = NULL, updated_at = NOW()
      WHERE appointment_id = ${appointmentId}::uuid
    `;
  });

  try {
    await cancelGoogleCalendarEvent({ calendar: existing.calendar, metadata: existing.metadata });
  } catch (syncErr) {
    logger.error(
      {
        appointmentId,
        calendarId: existing.calendar?.id,
        message: syncErr.message,
      },
      'calendarService.rescheduleAppointment google cancel sync failed'
    );
  }

  return bookResult;
}

const APPOINTMENT_STATUS_TRANSITIONS = {
  scheduled: ['completed', 'no_show', 'cancelled'],
  rescheduled: ['completed', 'no_show', 'cancelled'],
};

/**
 * Mark an appointment as completed or no-show (post-hoc attendance tracking).
 * Cancellation keeps going through cancelAppointment (restores the slot).
 *
 * @param {string} appointmentId
 * @param {string} tenantId
 * @param {'completed'|'no_show'} status
 * @returns {Promise<{ appointment: object } | { error: string }>}
 */
async function updateAppointmentStatus(appointmentId, tenantId, status) {
  if (!['completed', 'no_show'].includes(status)) {
    return { error: 'INVALID_STATUS' };
  }

  const existing = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    select: { id: true, status: true },
  });
  if (!existing) return { error: 'NOT_FOUND' };

  const allowedNext = APPOINTMENT_STATUS_TRANSITIONS[existing.status] || [];
  if (!allowedNext.includes(status)) {
    return { error: 'INVALID_TRANSITION' };
  }

  const appointment = await prisma.appointment.update({
    where: { id: appointmentId },
    data: { status, updatedAt: new Date() },
  });

  return { appointment };
}

/**
 * Retry Google Calendar event creation for appointments that got booked
 * locally but never received an `external_event_id` (process crash/timeout
 * between the Google API call and persisting the reference). Safe to call
 * repeatedly: createGoogleCalendarEvent looks up an existing event first.
 *
 * @param {{ olderThanMinutes?: number }} opts
 * @returns {Promise<{ scanned: number, reconciled: number }>}
 */
async function reconcileOrphanedGoogleEvents({ olderThanMinutes = 5 } = {}) {
  const activeCalendars = await prisma.calendar.findMany({
    where: { activo: true },
    select: { id: true, name: true, timezone: true, config: true },
  });
  const googleCalendarById = new Map(
    activeCalendars
      .filter((c) => String(c?.config?.provider || '').toLowerCase() === 'google')
      .map((c) => [c.id, c])
  );
  if (googleCalendarById.size === 0) return { scanned: 0, reconciled: 0 };

  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  const candidates = await prisma.appointment.findMany({
    where: {
      status: { in: ['scheduled', 'rescheduled'] },
      createdAt: { lte: cutoff },
      calendarId: { in: [...googleCalendarById.keys()] },
    },
    take: 200,
  });

  let reconciled = 0;
  for (const appointment of candidates) {
    if (getExternalEventId(appointment.metadata)) continue;
    const calendar = googleCalendarById.get(appointment.calendarId);
    if (!calendar) continue;

    try {
      const externalEventId = await createGoogleCalendarEvent({ calendar, appointment });
      if (externalEventId) {
        const updatedMetadata = withExternalEventId(appointment.metadata, externalEventId);
        await prisma.appointment.update({ where: { id: appointment.id }, data: { metadata: updatedMetadata } });
        reconciled += 1;
      }
    } catch (err) {
      logger.error(
        { appointmentId: appointment.id, message: err.message },
        'calendarService.reconcileOrphanedGoogleEvents failed'
      );
    }
  }

  return { scanned: candidates.length, reconciled };
}

/**
 * Get a single appointment with its calendar.
 */
async function getAppointment(appointmentId, tenantId) {
  return prisma.appointment.findFirst({
    where  : { id: appointmentId, tenantId },
    include: { calendar: { select: { id: true, name: true, timezone: true } } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  generateSlots,
  getAvailableSlots,
  getCalendarDayOffDates,
  setCalendarDayOff,
  getCalendarIdForAgente,
  getCalendarAssignmentContext,
  getCalendarsForPuesto,
  getCalendarIdForPuesto,
  getRandomCalendarIdForPuesto,
  isAgenteBookable,
  bookSlot,
  cancelAppointment,
  rescheduleAppointment,
  getAppointment,
  updateAppointmentStatus,
  reconcileOrphanedGoogleEvents,
};
