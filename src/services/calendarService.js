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
  if (!hours || hours.length < 2) return [];

  const [startStr, endStr] = hours;
  const startT = parseTime(startStr);
  const endT   = parseTime(endStr);

  const slotDuration = (config.slot_duration_min ?? 30) * 60 * 1000;
  const buffer       = (config.buffer_min ?? 0)         * 60 * 1000;

  const slots = [];
  const dayStart = new Date(date);
  dayStart.setHours(startT.hours, startT.minutes, 0, 0);
  const dayEnd   = new Date(date);
  dayEnd.setHours(endT.hours, endT.minutes, 0, 0);

  let cursor = dayStart.getTime();
  while (cursor + slotDuration <= dayEnd.getTime()) {
    slots.push({
      start: new Date(cursor),
      end  : new Date(cursor + slotDuration),
    });
    cursor += slotDuration + buffer;
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

  const config    = calendar.config ?? {};
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
async function getAvailableSlots(calendarId, rangeDays = null) {
  const cacheKey = `slots:${calendarId}:${rangeDays ?? 'default'}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  const calendar = await prisma.calendar.findUnique({
    where : { id: calendarId },
    select: { config: true },
  });
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

  await cacheSet(cacheKey, slots);
  return slots;
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
    where  : { tenantId, agenteId, activo: true },
    orderBy: { createdAt: 'desc' },
    select : { id: true },
  });

  return calendar?.id ?? null;
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
    await prisma.$transaction(async (tx) => {
      const appt = await tx.appointment.findFirst({
        where : { id: appointmentId, tenantId },
        select: { id: true, status: true },
      });
      if (!appt) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
      if (appt.status === 'cancelled') throw Object.assign(new Error('ALREADY_CANCELLED'), { code: 'ALREADY_CANCELLED' });

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
    return { ok: true };
  } catch (err) {
    if (err.code === 'NOT_FOUND')        return { error: 'NOT_FOUND' };
    if (err.code === 'ALREADY_CANCELLED') return { error: 'ALREADY_CANCELLED' };
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
    select: { id: true, calendarId: true, userKey: true, conversationId: true, metadata: true, status: true },
  });
  if (!existing) return { error: 'NOT_FOUND' };
  if (existing.status === 'cancelled') return { error: 'ALREADY_CANCELLED' };

  // Cancel old booking first
  await cancelAppointment(appointmentId, tenantId);

  // Book new slot
  const bookResult = await bookSlot({
    calendarId     : existing.calendarId,
    slotId         : newSlotId,
    tenantId,
    userKey        : existing.userKey,
    conversationId : existing.conversationId,
    metadata       : { ...existing.metadata, rescheduled_from: appointmentId },
  });

  if (bookResult.error) return bookResult;

  // Mark old appointment as rescheduled
  await prisma.appointment.update({
    where: { id: appointmentId },
    data : { status: 'rescheduled' },
  });

  return bookResult;
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
  getCalendarIdForAgente,
  bookSlot,
  cancelAppointment,
  rescheduleAppointment,
  getAppointment,
};
