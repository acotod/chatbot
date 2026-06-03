const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const db = require('../services/database');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const { audit } = require('../services/audit');
const socketService = require('../services/socketService');
const wa = require('../services/whatsapp');
const convLogger = require('../engine/conversationLogger');
const { generatePortalToken } = require('../services/portalAccess');
const { WEBHOOK_EVENTS, dispatchSolicitudesWebhookEvent } = require('../services/solicitudesWebhooks');
const lockoutPolicy = require('../services/lockoutPolicy');
const { createAdminNotification, serializeNotification } = require('../services/adminNotifications');
const calendarService = require('../services/calendarService');

// Multer: store logos under /app/uploads/logos (persisted volume in prod)
const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'logos');

// Validate real image type via magic bytes (defends against MIME spoofing)
function validateImageMagicBytes(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;                    // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true; // GIF
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true; // WebP
  const start = buf.slice(0, 200).toString('utf8').trimStart();
  if (start.startsWith('<svg') || start.startsWith('<?xml')) return true; // SVG
  return false;
}
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_) { /* pre-created in Docker image */ }

const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.slug}-${Date.now()}${ext}`);
  },
});

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (png, jpg, gif, webp, svg)'));
    }
  },
});

const prisma = new PrismaClient();
const router = express.Router();
const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const CONFIG_SECRET_PREFIX = 'encv1';
const GOOGLE_CALENDAR_SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
];

function persistEnvVariable(key, rawValue) {
    const envPath = path.join(process.cwd(), '.env');
    const safeValue = String(rawValue ?? '').replace(/[\r\n]/g, '').trim();
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linePattern = new RegExp(`^${escapedKey}=.*$`, 'm');

    let currentContent = '';
    try {
        currentContent = fs.readFileSync(envPath, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }

    const nextLine = `${key}=${safeValue}`;
    const hasTrailingNewline = currentContent.endsWith('\n') || currentContent.length === 0;
    const nextContent = linePattern.test(currentContent)
        ? currentContent.replace(linePattern, nextLine)
        : `${currentContent}${hasTrailingNewline ? '' : '\n'}${nextLine}\n`;

    fs.writeFileSync(envPath, nextContent, 'utf8');
    process.env[key] = safeValue;
}

// All admin routes require a valid JWT (issued by POST /auth/login)
router.use(requireJwt);

// Guard: after resolving a tenant, ensure the caller may access it
function denyIfWrongTenant(req, res, tenantId) {
  if (req.admin.superAdmin) return false; // false = no denial
  if (req.admin.tenantId && req.admin.tenantId !== tenantId) {
    res.status(403).json({ error: 'Acceso denegado' });
    return true; // true = denied, caller should return
  }
  return false;
}

const AGENDA_TYPES = new Set(['reunion', 'tarea', 'automatizacion', 'webhook']);
const AGENDA_STATES = new Set(['pendiente', 'en_progreso', 'completado']);
const SOLICITUD_STATES = new Set(db.SOLICITUD_STATUS_VALUES);

function queueSolicitudWebhook({ tenant, req, event, solicitudId, payload }) {
    dispatchSolicitudesWebhookEvent({ tenant, req, event, solicitudId, payload }).catch(() => {});
}

function normalizeOptionalHttpUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return { value: null };
    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { error: 'calendarLink must be a valid http(s) URL' };
        }
        return { value: parsed.toString() };
    } catch (_err) {
        return { error: 'calendarLink must be a valid URL' };
    }
}

function normalizeWhatsappRecipient(value) {
    const digits = String(value || '').replace(/\D+/g, '');
    return digits || null;
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

function encryptConfigSecret(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getConfigEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${CONFIG_SECRET_PREFIX}:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
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
    } catch (_err) {
        return '';
    }
}

function b64urlEncode(input) {
    return Buffer.from(input, 'utf8').toString('base64url');
}

function b64urlDecode(input) {
    return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function getOauthStateSigningSecret() {
    return String(process.env.JWT_SECRET || process.env.ADMIN_API_KEY || 'oauth-dev-secret');
}

function buildSignedOauthState(payload) {
    const encoded = b64urlEncode(JSON.stringify(payload));
    const signature = crypto
        .createHmac('sha256', getOauthStateSigningSecret())
        .update(encoded)
        .digest('base64url');
    return `${encoded}.${signature}`;
}

function parseSignedOauthState(state) {
    const raw = String(state || '');
    const [encoded, signature] = raw.split('.');
    if (!encoded || !signature) return null;

    const expected = crypto
        .createHmac('sha256', getOauthStateSigningSecret())
        .update(encoded)
        .digest('base64url');

    const providedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return null;

    try {
        const payload = JSON.parse(b64urlDecode(encoded));
        if (!payload || typeof payload !== 'object') return null;
        if (!payload.exp || Date.now() > Number(payload.exp)) return null;
        return payload;
    } catch (_err) {
        return null;
    }
}

function getApiOrigin(req) {
    const fromEnv = String(process.env.API_BASE_URL || '').trim().replace(/\/$/, '');
    if (fromEnv) return fromEnv;

    const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const protocol = protoHeader || req.protocol || 'http';
    return `${protocol}://${hostHeader}`.replace(/\/$/, '');
}

function getGoogleOauthClientConfig(req) {
    const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const explicitRedirectUri = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
    const redirectUri = explicitRedirectUri
        || `${getApiOrigin(req)}/admin/tenants/${encodeURIComponent(req.params.slug)}/calendars/${encodeURIComponent(req.params.calendarId)}/google/oauth/callback`;

    return {
        clientId,
        clientSecret,
        redirectUri,
    };
}

function getGoogleTokenEndpoint(credentials = {}) {
    const tokenUri = String(credentials.token_uri || credentials.tokenUri || GOOGLE_OAUTH_TOKEN_URL || '').trim();
    return tokenUri || GOOGLE_OAUTH_TOKEN_URL;
}

function getDecryptedGoogleCredentials(config = {}) {
    const cfg = asObject(config);
    const credentials = asObject(cfg.provider_credentials || cfg.providerCredentials);

    return {
        accessToken: decryptConfigSecret(credentials.access_token || credentials.accessToken || ''),
        refreshToken: decryptConfigSecret(credentials.refresh_token || credentials.refreshToken || ''),
        tokenUri: String(credentials.token_uri || credentials.tokenUri || GOOGLE_OAUTH_TOKEN_URL),
        expiresAt: String(credentials.expires_at || credentials.expiresAt || ''),
    };
}

async function persistGoogleCredentialsOnCalendar({ calendar, nextAccessToken, nextRefreshToken, expiresInSec, nextCalendarExternalId }) {
    const config = asObject(calendar.config);
    const currentCredentials = asObject(config.provider_credentials || config.providerCredentials);

    const mergedCredentials = {
        ...currentCredentials,
        access_token: nextAccessToken ? encryptConfigSecret(nextAccessToken) : String(currentCredentials.access_token || ''),
        refresh_token: nextRefreshToken
            ? encryptConfigSecret(nextRefreshToken)
            : String(currentCredentials.refresh_token || ''),
        token_uri: String(currentCredentials.token_uri || GOOGLE_OAUTH_TOKEN_URL),
    };

    if (Number.isFinite(expiresInSec) && Number(expiresInSec) > 0) {
        mergedCredentials.expires_at = new Date(Date.now() + Number(expiresInSec) * 1000).toISOString();
    }

    const nextConfig = {
        ...config,
        provider: 'google',
        sync: true,
        provider_credentials: mergedCredentials,
        ...(nextCalendarExternalId ? { calendar_external_id: String(nextCalendarExternalId).trim() } : {}),
    };

    return prisma.calendar.update({
        where: { id: calendar.id },
        data: { config: nextConfig },
        select: { id: true, config: true },
    });
}

async function refreshGoogleAccessTokenForCalendar({ calendar, req }) {
    const config = asObject(calendar.config);
    const credentials = getDecryptedGoogleCredentials(config);
    const { clientId, clientSecret } = getGoogleOauthClientConfig(req);
    if (!credentials.refreshToken || !clientId || !clientSecret) return null;

    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
    });

    const tokenResp = await fetch(getGoogleTokenEndpoint(credentials), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const tokenJson = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenJson.access_token) return null;

    const updated = await persistGoogleCredentialsOnCalendar({
        calendar,
        nextAccessToken: tokenJson.access_token,
        nextRefreshToken: credentials.refreshToken,
        expiresInSec: tokenJson.expires_in,
    });

    return getDecryptedGoogleCredentials(updated.config).accessToken;
}

async function buildAgentSolicitudesUrl(tenantId) {
    const path = `/agente/login?next=${encodeURIComponent('/solicitudes')}`;
    const emailSettings = tenantId ? await db.getEmailSettings(tenantId) : null;
    const origin = String(
        emailSettings?.adminBaseUrl
        || process.env.AGENT_PORTAL_BASE_URL
        || process.env.ADMIN_BASE_URL
        || process.env.CUSTOMER_PORTAL_BASE_URL
        || ''
    ).trim().replace(/\/$/, '');
    return origin ? `${origin}${path}` : path;
}

function buildAgentAssignmentWhatsappText({ solicitudId, agenteNombre, tenantNombre, loginUrl }) {
    const safeAgenteNombre = String(agenteNombre || 'agente').trim();
    const safeTenantNombre = String(tenantNombre || 'tu empresa').trim();
    return [
        `Hola ${safeAgenteNombre}, se te asigno la solicitud #${solicitudId} en ${safeTenantNombre}.`,
        'Ingresa al portal de agente para responder:',
        loginUrl,
    ].join('\n');
}

function parseCalendarSelection(value) {
    if (value === undefined) return { provided: false, clear: false, calendarId: null };
    if (value === null) return { provided: true, clear: true, calendarId: null };
    const raw = String(value).trim();
    if (!raw) return { provided: true, clear: true, calendarId: null };
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(raw);
    if (!isUuid) return { error: 'calendarId must be a UUID' };
    return { provided: true, clear: false, calendarId: raw };
}

function buildDefaultInternalCalendarConfig() {
    return {
        working_hours: {
            mon: ['09:00', '17:00'],
            tue: ['09:00', '17:00'],
            wed: ['09:00', '17:00'],
            thu: ['09:00', '17:00'],
            fri: ['09:00', '17:00'],
        },
        slot_duration_min: 15,
        advance_days: 14,
        provider: 'internal',
        sync: false,
    };
}

function normalizeCalendarNameBase({ agenteNombre, agenteEmail, agenteId }) {
    const nameSource = String(agenteNombre || '').trim() || String(agenteEmail || '').trim() || `Agente ${agenteId}`;
    const collapsed = nameSource.replace(/\s+/g, ' ').trim();
    const maxLabelLength = 170; // Keep room for suffixes under varchar(200).
    return `Agenda ${collapsed.slice(0, maxLabelLength)}`;
}

async function findAvailableCalendarName(tenantId, baseName) {
    for (let idx = 0; idx < 500; idx += 1) {
        const suffix = idx === 0 ? '' : ` (${idx + 1})`;
        const candidate = `${baseName}${suffix}`;
        const exists = await prisma.calendar.findFirst({
            where: { tenantId, name: candidate },
            select: { id: true },
        });
        if (!exists) return candidate;
    }
    return `${baseName} ${Date.now()}`;
}

async function ensureInternalCalendarForAgente({ tenantId, agenteId, agenteNombre, agenteEmail }) {
    const existing = await prisma.calendar.findFirst({
        where: { tenantId, agenteId, activo: true },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
    });
    if (existing?.id) return existing.id;

    const baseName = normalizeCalendarNameBase({ agenteNombre, agenteEmail, agenteId });
    const uniqueName = await findAvailableCalendarName(tenantId, baseName);

    const created = await prisma.calendar.create({
        data: {
            tenantId,
            agenteId,
            name: uniqueName,
            config: buildDefaultInternalCalendarConfig(),
        },
        select: { id: true },
    });

    return created.id;
}

async function assignCalendarToAgente({ tenantId, agenteId, calendarId }) {
    await prisma.calendar.updateMany({
        where: { tenantId, agenteId },
        data: { agenteId: null },
    });

    if (!calendarId) return null;

    const calendar = await prisma.calendar.findFirst({
        where: { id: calendarId, tenantId },
        select: { id: true },
    });
    if (!calendar) return null;

    await prisma.calendar.update({
        where: { id: calendar.id },
        data: { agenteId },
    });
    return calendar.id;
}

function serializeAgendaEvent(event) {
    return {
        ...event,
        source: 'agenda',
        assignments: (event.assignments || []).map((a) => ({
            agenteId: a.agenteId,
            nombre: a.agente?.nombre ?? null,
            email: a.agente?.email ?? null,
            estado: a.agente?.estado ?? null,
        })),
    };
}

function mapAppointmentStatusToAgendaStatus(status) {
    if (status === 'completed') return 'completado';
    if (status === 'scheduled' || status === 'rescheduled') return 'pendiente';
    return 'en_progreso';
}

function pickFirstNonEmpty(...values) {
    for (const value of values) {
        const normalized = String(value ?? '').trim();
        if (normalized) return normalized;
    }
    return '';
}

function buildAppointmentDetails(appointment) {
    const meta = asObject(appointment?.metadata);
    const nombre = pickFirstNonEmpty(
        meta.user_name,
        meta.nombre,
        meta.cliente_nombre,
        meta.customer_name
    );
    const cedula = pickFirstNonEmpty(
        meta.appointment_customer_cedula,
        meta.cliente_cedula,
        meta.cedula,
        meta.identificacion,
        meta.identification
    );
    const telefono = pickFirstNonEmpty(
        meta.user_phone,
        meta.telefono,
        meta.cliente_telefono,
        meta.phone,
        appointment?.userKey
    );
    const comentarios = pickFirstNonEmpty(
        meta.appointment_notes_summary,
        meta.customer_notes,
        meta.notes,
        meta.comentarios,
        meta.comments
    );

    const descripcion = [
        `Nombre: ${nombre || '-'}`,
        `Cedula: ${cedula || '-'}`,
        `Telefono: ${telefono || '-'}`,
        `Comentarios: ${comentarios || '-'}`,
    ].join('\n');

    return {
        nombre,
        telefono,
        descripcion,
    };
}

function normalizeHexColor(value, fallback = '#0EA5E9') {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalized) ? normalized : fallback;
}

const AGENDA_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function normalizeTimeZone(value, fallback = 'America/Costa_Rica') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    try {
        Intl.DateTimeFormat('en-US', { timeZone: raw }).format(new Date());
        return raw;
    } catch (_err) {
        return fallback;
    }
}

function normalizeTimeString(value) {
    const raw = String(value || '').trim();
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(raw) ? raw : null;
}

function normalizeWorkingHoursByDay(value) {
    const source = asObject(value);
    const result = {
        sun: [],
        mon: [],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
    };

    for (const day of AGENDA_DAY_KEYS) {
        const dayValue = source[day];
        if (!Array.isArray(dayValue)) continue;

        // Backward compatible: ["09:00", "17:00"]
        if (
            dayValue.length >= 2
            && typeof dayValue[0] === 'string'
            && typeof dayValue[1] === 'string'
        ) {
            const start = normalizeTimeString(dayValue[0]);
            const end = normalizeTimeString(dayValue[1]);
            if (start && end && start < end) {
                result[day] = [[start, end]];
            }
            continue;
        }

        // New format: [["08:00", "10:00"], ["14:00", "16:00"]]
        const ranges = [];
        for (const range of dayValue) {
            if (!Array.isArray(range) || range.length < 2) continue;
            const start = normalizeTimeString(range[0]);
            const end = normalizeTimeString(range[1]);
            if (!start || !end || start >= end) continue;
            ranges.push([start, end]);
        }
        result[day] = ranges;
    }

    return result;
}

function normalizeAgentColorMap(value) {
    const source = asObject(value);
    const result = {};
    for (const [key, color] of Object.entries(source)) {
        const agenteId = Number(key);
        if (!Number.isInteger(agenteId) || agenteId <= 0) continue;
        result[String(agenteId)] = normalizeHexColor(color, '#0EA5E9');
    }
    return result;
}

function resolveAppointmentColor(agendaSettingsValue, agenteId) {
    const fallback = normalizeHexColor(agendaSettingsValue?.appointmentColor, '#0EA5E9');
    if (!Number.isInteger(agenteId) || agenteId <= 0) return fallback;
    const agentColors = normalizeAgentColorMap(agendaSettingsValue?.agentColors);
    return normalizeHexColor(agentColors[String(agenteId)], fallback);
}

function normalizeAgendaSettings(value) {
    const source = asObject(value);
    const workingHoursSource = source.workingHours || source.working_hours;
    const workingHours = normalizeWorkingHoursByDay(workingHoursSource);

    return {
        appointmentColor: normalizeHexColor(source.appointmentColor, '#0EA5E9'),
        timeZone: normalizeTimeZone(source.timeZone || source.timezone, 'America/Costa_Rica'),
        workingHours,
        agentColors: normalizeAgentColorMap(source.agentColors),
    };
}

async function applyAgendaScheduleToTenantCalendars(tenantId, agendaSettings) {
    const timezone = normalizeTimeZone(agendaSettings?.timeZone, 'America/Costa_Rica');
    const workingHours = normalizeWorkingHoursByDay(agendaSettings?.workingHours);

    const calendars = await prisma.calendar.findMany({
        where: { tenantId, activo: true },
        select: { id: true, config: true },
    });

    for (const calendar of calendars) {
        const currentConfig = asObject(calendar.config);
        const nextConfig = {
            ...currentConfig,
            timezone,
            working_hours: workingHours,
        };

        await prisma.calendar.update({
            where: { id: calendar.id },
            data: { timezone, config: nextConfig },
        });

        await prisma.calendarSlot.deleteMany({
            where: {
                calendarId: calendar.id,
                status: 'available',
                startTime: { gte: new Date() },
            },
        });

        await calendarService.generateSlots(calendar.id);
    }
}

function serializeAppointmentAsAgendaEvent(appointment, appointmentColor = '#0EA5E9') {
    const details = buildAppointmentDetails(appointment);
    const cliente = pickFirstNonEmpty(details.nombre, details.telefono, appointment?.userKey);
    return {
        id: `appt:${appointment.id}`,
        tenantId: appointment.tenantId,
        createdByAdminUserId: null,
        flowId: null,
        titulo: `Cliente: ${cliente || '-'}`,
        descripcion: details.descripcion,
        tipo: 'reunion',
        color: appointmentColor,
        estado: mapAppointmentStatusToAgendaStatus(appointment.status),
        startAt: appointment.startTime,
        endAt: appointment.endTime,
        reminderMinutes: null,
        triggerWebhookOnStart: false,
        webhookUrl: null,
        webhookMethod: null,
        webhookHeaders: null,
        webhookPayload: null,
        createdAt: appointment.createdAt,
        updatedAt: appointment.updatedAt,
        source: 'appointment',
        appointmentId: appointment.id,
        calendarId: appointment.calendarId,
        calendarName: appointment?.calendar?.name ?? null,
        timezone: appointment?.calendar?.timezone ?? null,
        assignments: appointment?.calendar?.agente
            ? [
                  {
                      agenteId: appointment.calendar.agente.id,
                      nombre: appointment.calendar.agente.nombre ?? null,
                      email: appointment.calendar.agente.email ?? null,
                      estado: appointment.calendar.agente.estado ?? null,
                  },
              ]
            : [],
    };
}

async function logAgendaEvent({ tenantId, eventId, adminUserId, accion, metadata }) {
    await prisma.agendaEventLog.create({
        data: {
            tenantId,
            eventId,
            adminUserId: adminUserId ?? null,
            accion,
            metadata: metadata ?? undefined,
        },
    });
}

function parseIsoDate(value) {
    if (!value) return null;
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? null : dt;
}

function parsePagination(pageRaw, limitRaw) {
    const page = Math.max(Number(pageRaw) || 1, 1);
    const limit = Math.min(Math.max(Number(limitRaw) || 10, 1), 50);
    return { page, limit, skip: (page - 1) * limit };
}

async function runAgendaStartHooks({ tenantId, event, actorAdminUserId }) {
    if (!event.triggerWebhookOnStart || !event.webhookUrl) return;

    const method = (event.webhookMethod || 'POST').toUpperCase();
    const supported = new Set(['POST', 'PUT', 'PATCH']);
    if (!supported.has(method)) return;

    try {
        const headers = {
            'Content-Type': 'application/json',
            ...(event.webhookHeaders && typeof event.webhookHeaders === 'object' ? event.webhookHeaders : {}),
        };

        const payload = {
            eventId: event.id,
            tenantId,
            tipo: event.tipo,
            estado: event.estado,
            startAt: event.startAt,
            endAt: event.endAt,
            flowId: event.flowId,
            custom: event.webhookPayload ?? null,
        };

        const resp = await fetch(event.webhookUrl, {
            method,
            headers,
            body: JSON.stringify(payload),
        });

        await logAgendaEvent({
            tenantId,
            eventId: event.id,
            adminUserId: actorAdminUserId,
            accion: 'WEBHOOK_TRIGGERED',
            metadata: { status: resp.status, ok: resp.ok },
        });
    } catch (err) {
        await logAgendaEvent({
            tenantId,
            eventId: event.id,
            adminUserId: actorAdminUserId,
            accion: 'WEBHOOK_FAILED',
            metadata: { error: err.message },
        });
    }
}

async function sendFlowContentToUser({ tenantId, userPhone, content }) {
    if (!userPhone || !content) return;

    const { phoneNumberId, accessToken } = await db.getWaCredentials(tenantId);
    if (!phoneNumberId || !accessToken) return;

    if (content.type === 'text' || content.type === 'end' || content.type === 'handoff') {
        const text = String(content.text || '').trim();
        if (text) await wa.sendTextMessage(phoneNumberId, userPhone, text, accessToken);
        return;
    }

    if (content.type === 'waba_flow') {
        const flowId = content.flow_id ?? content.flowId;
        if (flowId) {
            await wa.sendFlowMessage(phoneNumberId, userPhone, {
                flowId,
                flowToken:     content.flow_token   ?? content.flowToken,
                flowCta:       content.flow_cta      ?? content.flowCta      ?? 'Abrir',
                bodyText:      content.body_text     ?? content.bodyText     ?? content.text ?? ' ',
                headerText:    content.header_text   ?? content.headerText,
                footerText:    content.footer_text   ?? content.footerText,
                initialScreen: content.initial_screen ?? content.initialScreen,
                screenData:    content.screen_data   ?? content.screenData,
            }, accessToken);
        }
        return;
    }

    if (content.type === 'buttons' && Array.isArray(content.buttons) && content.buttons.length > 0) {
        await wa.sendButtonMessage(phoneNumberId, userPhone, content.text || 'Selecciona una opción', content.buttons.slice(0, 3), accessToken);
        return;
    }

    if (content.type === 'list' && Array.isArray(content.sections) && content.sections.length > 0) {
        const firstSection = content.sections[0];
        const rows = Array.isArray(firstSection?.rows) ? firstSection.rows : [];
        const fallbackButtons = rows.slice(0, 3).map((row) => ({ id: row.id, title: row.title }));
        if (fallbackButtons.length > 0) {
            await wa.sendButtonMessage(phoneNumberId, userPhone, content.text || 'Selecciona una opción', fallbackButtons, accessToken);
        }
    }
}

async function resumeFlowForCompletedTask({ tenantId, solicitud }) {
    if (!solicitud || solicitud.origin !== 'bot' || !solicitud.userId) return;

    const { executeStep } = require('../services/flowEngine');

    const result = await executeStep({
        tenantId,
        currentNodeId: null,
        input: '',
        userId: solicitud.userId,
        sessionKey: solicitud.user?.phone || String(solicitud.userId),
        _conversationId: solicitud.conversationId || undefined,
    });

    if (result?.content && solicitud.user?.phone) {
        await sendFlowContentToUser({ tenantId, userPhone: solicitud.user.phone, content: result.content });
    }

    socketService.emit(tenantId, 'FLOW_RESUMED', {
        solicitudId: solicitud.id,
        conversationId: solicitud.conversationId || null,
        nodeId: result?.nodeId ?? null,
    });
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

// POST /admin/tenants — create a new tenant (superAdmin only)
router.post('/tenants', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const { nombre, slug, plan } = req.body;
        if (!nombre || !slug) {
            return res.status(400).json({ error: 'nombre and slug are required' });
        }
        const apiKey = crypto.randomBytes(32).toString('hex');
        const tenant = await db.createTenant({ nombre, slug, apiKey, plan });
        audit({ adminUserId: req.admin.adminUserId, accion: 'CREATE_TENANT', entidad: 'tenant', entidadId: tenant.id, ip: req.ip, userAgent: req.headers['user-agent'], metadata: { slug } });
        // Return raw apiKey only at creation time — stored as hash in DB
        res.status(201).json({ ...tenant, apiKey });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants — list accessible tenants for the authenticated user
// superAdmin: all; tenant-scoped users: only their own tenant; others: empty list
router.get('/tenants', async (req, res, next) => {
    try {
        if (req.admin.superAdmin) {
            const tenants = await db.listTenants();
            return res.json(tenants);
        }
        // TenantAdmin: return only their own tenant
        if (!req.admin.tenantId) return res.json([]);
        const tenant = await prisma.tenant.findUnique({ where: { id: req.admin.tenantId } });
        return res.json(tenant ? [tenant] : []);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug — fetch a single tenant by slug
router.get('/tenants/:slug', async (req, res, next) => {
    try {
        const tenant = await prisma.tenant.findUnique({ where: { slug: req.params.slug } });
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        res.json(tenant);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/deactivate
router.patch('/tenants/:slug/deactivate', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.setTenantActive(req.params.slug, false);
        audit({ adminUserId: req.admin.adminUserId, accion: 'DEACTIVATE_TENANT', entidad: 'tenant', entidadId: tenant.id, ip: req.ip, userAgent: req.headers['user-agent'] });
        res.json(tenant);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/activate
router.patch('/tenants/:slug/activate', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.setTenantActive(req.params.slug, true);
        audit({ adminUserId: req.admin.adminUserId, accion: 'ACTIVATE_TENANT', entidad: 'tenant', entidadId: tenant.id, ip: req.ip, userAgent: req.headers['user-agent'] });
        res.json(tenant);
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/rotate-api-key
router.post('/tenants/:slug/rotate-api-key', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        // TenantAdmin can only rotate their own key
        if (!req.admin.superAdmin && req.admin.tenantId !== tenant.id) {
            return res.status(403).json({ error: 'Acceso denegado' });
        }

        const newApiKey = crypto.randomBytes(32).toString('hex');
        const hashedKey = crypto.createHash('sha256').update(newApiKey).digest('hex');
        const updated = await prisma.tenant.update({
            where: { id: tenant.id },
            data: { apiKey: hashedKey },
        });
        audit({ adminUserId: req.admin.adminUserId, tenantId: tenant.id, accion: 'ROTATE_API_KEY', entidad: 'tenant', entidadId: tenant.id, ip: req.ip, userAgent: req.headers['user-agent'] });
        // Return raw key to caller — only time it's visible; DB stores the hash
        res.json({ id: updated.id, slug: updated.slug, apiKey: newApiKey });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/logo — upload/replace logo (max 2 MB image)
router.post('/tenants/:slug/logo', requirePermiso('MANAGE_TENANTS'), logoUpload.single('logo'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

        // Validate magic bytes to prevent MIME-type spoofing
        const fileBuffer = fs.readFileSync(req.file.path);
        if (!validateImageMagicBytes(fileBuffer)) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: 'El archivo no es una imagen válida' });
        }

        // Delete previous logo file if it exists
        if (tenant.logoUrl) {
            const prevPath = path.join(process.cwd(), tenant.logoUrl.replace(/^\//, ''));
            fs.unlink(prevPath, () => {}); // fire-and-forget
        }

        const logoUrl = `/uploads/logos/${req.file.filename}`;
        const updated = await prisma.tenant.update({
            where: { id: tenant.id },
            data: { logoUrl },
        });
        audit({ adminUserId: req.admin.adminUserId, tenantId: tenant.id, accion: 'UPDATE_LOGO', entidad: 'tenant', entidadId: tenant.id, ip: req.ip, userAgent: req.headers['user-agent'] });
        res.json({ id: updated.id, slug: updated.slug, logoUrl: updated.logoUrl });
    } catch (err) {
        next(err);
    }
});
// ---------------------------------------------------------------------------
// Agentes (per-tenant, admin-managed)

// GET /admin/tenants/:slug/agente-puestos
router.get('/tenants/:slug/agente-puestos', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const puestos = await db.listAgentePuestos(tenant.id);
        res.json(puestos);
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/agente-puestos
router.post('/tenants/:slug/agente-puestos', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const nombre = String(req.body?.nombre ?? '').trim();
        if (!nombre) return res.status(400).json({ error: 'nombre is required' });

        const puesto = await db.createAgentePuesto({ tenantId: tenant.id, nombre });
        res.status(201).json(puesto);
    } catch (err) {
        if (err?.code === 'P2002') {
            return res.status(409).json({ error: 'El puesto ya existe para este tenant' });
        }
        next(err);
    }
});

// PATCH /admin/tenants/:slug/agente-puestos/:id
router.patch('/tenants/:slug/agente-puestos/:id', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const id = Number(req.params.id);
        const nombre = String(req.body?.nombre ?? '').trim();
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid puesto id' });
        if (!nombre) return res.status(400).json({ error: 'nombre is required' });

        const result = await db.updateAgentePuesto({ id, tenantId: tenant.id, nombre });
        if (!result || result.count === 0) return res.status(404).json({ error: 'Puesto not found' });

        const puesto = await prisma.agentePuesto.findFirst({ where: { id, tenantId: tenant.id } });
        return res.json(puesto);
    } catch (err) {
        if (err?.code === 'P2002') {
            return res.status(409).json({ error: 'El puesto ya existe para este tenant' });
        }
        next(err);
    }
});

// DELETE /admin/tenants/:slug/agente-puestos/:id
router.delete('/tenants/:slug/agente-puestos/:id', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid puesto id' });

        const result = await db.deleteAgentePuesto({ id, tenantId: tenant.id });
        if (!result || result.count === 0) return res.status(404).json({ error: 'Puesto not found' });

        return res.status(204).send();
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/agentes
router.get('/tenants/:slug/agentes', requirePermiso('VIEW_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const agentes = await db.listAgentes(tenant.id);
        res.json(agentes);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/admin-users  — list admin users for escalation tree
router.get('/tenants/:slug/admin-users', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const users = await db.listAdminUsers(tenant.id);
        return res.json(users);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/admin-users/:id/jefe  — set supervisor in the hierarchy tree
router.patch('/tenants/:slug/admin-users/:id/jefe', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid admin user id' });

        const rawJefeId = req.body?.jefeId;
        const jefeId = rawJefeId == null || rawJefeId === '' ? null : Number(rawJefeId);
        if (jefeId !== null && (!Number.isInteger(jefeId) || jefeId <= 0)) {
            return res.status(400).json({ error: 'jefeId must be a positive integer or null' });
        }
        if (jefeId !== null) {
            const jefeExiste = await prisma.adminUser.findFirst({ where: { id: jefeId }, select: { id: true } });
            if (!jefeExiste) return res.status(400).json({ error: 'jefeId not found' });
        }

        const result = await db.setAdminUserJefe({ id, tenantId: tenant.id, jefeId });
        if (!result) return res.status(404).json({ error: 'Admin user not found' });
        if (result.error) return res.status(422).json({ error: result.error });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'SET_ADMIN_USER_JEFE',
            entidad: 'admin_user',
            entidadId: String(id),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { jefeId },
        });

        return res.json(result);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/admin-users/:id/escalation-chain
router.get('/tenants/:slug/admin-users/:id/escalation-chain', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid admin user id' });

        const chain = await db.getAdminUserEscalationChain(id, tenant.id);
        return res.json(chain);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/calendars
router.get('/tenants/:slug/calendars', requirePermiso('VIEW_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const calendars = await prisma.calendar.findMany({
            where: { tenantId: tenant.id, activo: true },
            select: { id: true, name: true, agenteId: true },
            orderBy: { createdAt: 'desc' },
        });
        return res.json({ data: calendars });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/calendars/:calendarId/google/oauth/start
router.get('/tenants/:slug/calendars/:calendarId/google/oauth/start', requirePermiso('EDIT_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const calendar = await prisma.calendar.findFirst({
            where: { id: req.params.calendarId, tenantId: tenant.id },
            select: { id: true },
        });
        if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

        const { clientId, redirectUri } = getGoogleOauthClientConfig(req);
        if (!clientId) return res.status(503).json({ error: 'Google OAuth is not configured' });

        const state = buildSignedOauthState({
            tenantId: tenant.id,
            slug: tenant.slug,
            calendarId: calendar.id,
            adminUserId: req.admin?.adminUserId ?? null,
            exp: Date.now() + (10 * 60 * 1000),
            nonce: crypto.randomBytes(12).toString('hex'),
        });

        const oauthUrl = new URL(GOOGLE_OAUTH_AUTH_URL);
        oauthUrl.searchParams.set('client_id', clientId);
        oauthUrl.searchParams.set('redirect_uri', redirectUri);
        oauthUrl.searchParams.set('response_type', 'code');
        oauthUrl.searchParams.set('access_type', 'offline');
        oauthUrl.searchParams.set('prompt', 'consent');
        oauthUrl.searchParams.set('include_granted_scopes', 'true');
        oauthUrl.searchParams.set('scope', GOOGLE_CALENDAR_SCOPES.join(' '));
        oauthUrl.searchParams.set('state', state);

        return res.json({ authorizationUrl: oauthUrl.toString() });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/calendars/:calendarId/google/oauth/callback
router.get('/tenants/:slug/calendars/:calendarId/google/oauth/callback', async (req, res, next) => {
    try {
        const oauthError = String(req.query.error || '').trim();
        if (oauthError) return res.status(400).json({ error: `Google OAuth error: ${oauthError}` });

        const code = String(req.query.code || '').trim();
        const state = String(req.query.state || '').trim();
        if (!code || !state) return res.status(400).json({ error: 'Missing OAuth code/state' });

        const parsedState = parseSignedOauthState(state);
        if (!parsedState) return res.status(400).json({ error: 'Invalid OAuth state' });

        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (tenant.id !== parsedState.tenantId) return res.status(400).json({ error: 'OAuth tenant mismatch' });
        if (String(parsedState.calendarId) !== String(req.params.calendarId)) {
            return res.status(400).json({ error: 'OAuth calendar mismatch' });
        }

        const calendar = await prisma.calendar.findFirst({
            where: { id: req.params.calendarId, tenantId: tenant.id },
            select: { id: true, config: true },
        });
        if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

        const { clientId, clientSecret, redirectUri } = getGoogleOauthClientConfig(req);
        if (!clientId || !clientSecret) return res.status(503).json({ error: 'Google OAuth is not configured' });

        const body = new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        });

        const tokenResp = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const tokenJson = await tokenResp.json().catch(() => ({}));

        if (!tokenResp.ok || !tokenJson.access_token) {
            return res.status(400).json({ error: 'Could not exchange OAuth code for tokens' });
        }

        const existingCreds = getDecryptedGoogleCredentials(calendar.config);
        await persistGoogleCredentialsOnCalendar({
            calendar,
            nextAccessToken: tokenJson.access_token,
            nextRefreshToken: tokenJson.refresh_token || existingCreds.refreshToken,
            expiresInSec: tokenJson.expires_in,
            nextCalendarExternalId: 'primary',
        });

        audit({
            adminUserId: parsedState.adminUserId ?? null,
            tenantId: tenant.id,
            accion: 'CONNECT_GOOGLE_CALENDAR',
            entidad: 'calendar',
            entidadId: String(calendar.id),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { provider: 'google', via: 'oauth_callback' },
        });

        return res.send('<html><body style="font-family:Arial,sans-serif;padding:24px;"><h2>Google Calendar conectado</h2><p>Ya puedes cerrar esta ventana y volver al panel.</p></body></html>');
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/calendars/:calendarId/google/calendars
router.get('/tenants/:slug/calendars/:calendarId/google/calendars', requirePermiso('EDIT_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const calendar = await prisma.calendar.findFirst({
            where: { id: req.params.calendarId, tenantId: tenant.id },
            select: { id: true, config: true },
        });
        if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

        const creds = getDecryptedGoogleCredentials(calendar.config);
        if (!creds.accessToken) {
            return res.status(400).json({ error: 'Calendar is not connected to Google OAuth' });
        }

        const requestCalendarList = async (token) => fetch(
            `${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`,
            {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` },
            }
        );

        let response = await requestCalendarList(creds.accessToken);
        if ((response.status === 401 || response.status === 403) && creds.refreshToken) {
            const refreshed = await refreshGoogleAccessTokenForCalendar({ calendar, req });
            if (refreshed) {
                response = await requestCalendarList(refreshed);
            }
        }

        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            return res.status(400).json({ error: 'Could not list Google calendars' });
        }

        const calendars = Array.isArray(json.items)
            ? json.items.map((item) => ({
                id: item.id,
                summary: item.summary,
                primary: Boolean(item.primary),
                accessRole: item.accessRole || null,
            }))
            : [];

        return res.json({ data: calendars });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/calendars/:calendarId/google/connect
router.post('/tenants/:slug/calendars/:calendarId/google/connect', requirePermiso('EDIT_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const calendar = await prisma.calendar.findFirst({
            where: { id: req.params.calendarId, tenantId: tenant.id },
            select: { id: true, config: true },
        });
        if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

        const googleCalendarId = String(req.body?.googleCalendarId || '').trim();
        if (!googleCalendarId) return res.status(400).json({ error: 'googleCalendarId is required' });

        const config = asObject(calendar.config);
        const updated = await prisma.calendar.update({
            where: { id: calendar.id },
            data: {
                config: {
                    ...config,
                    provider: 'google',
                    sync: true,
                    google_calendar_id: googleCalendarId,
                    calendar_external_id: googleCalendarId,
                },
            },
            select: { id: true, config: true },
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'SET_GOOGLE_CALENDAR_TARGET',
            entidad: 'calendar',
            entidadId: String(calendar.id),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { googleCalendarId },
        });

        return res.json({ id: updated.id, googleCalendarId });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/calendars/:calendarId/google/disconnect
router.post('/tenants/:slug/calendars/:calendarId/google/disconnect', requirePermiso('EDIT_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const calendar = await prisma.calendar.findFirst({
            where: { id: req.params.calendarId, tenantId: tenant.id },
            select: { id: true, config: true },
        });
        if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

        const config = asObject(calendar.config);
        const nextConfig = { ...config };
        delete nextConfig.provider_credentials;
        delete nextConfig.providerCredentials;
        delete nextConfig.google_calendar_id;
        delete nextConfig.calendar_external_id;
        nextConfig.provider = 'internal';
        nextConfig.sync = false;

        await prisma.calendar.update({
            where: { id: calendar.id },
            data: { config: nextConfig },
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'DISCONNECT_GOOGLE_CALENDAR',
            entidad: 'calendar',
            entidadId: String(calendar.id),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { provider: 'google' },
        });

        return res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/agentes
router.post('/tenants/:slug/agentes', requirePermiso('EDIT_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const nombre = String(req.body?.nombre ?? '').trim();
        const email = String(req.body?.email ?? '').trim();
        const whatsapp = String(req.body?.whatsapp ?? '').trim();
        const calendarLinkValidation = normalizeOptionalHttpUrl(req.body?.calendarLink);
        if (calendarLinkValidation.error) {
            return res.status(400).json({ error: calendarLinkValidation.error });
        }

        const calendarSelection = parseCalendarSelection(req.body?.calendarId);
        if (calendarSelection.error) {
            return res.status(400).json({ error: calendarSelection.error });
        }

        if (calendarSelection.calendarId) {
            const existingCalendar = await prisma.calendar.findFirst({
                where: { id: calendarSelection.calendarId, tenantId: tenant.id },
                select: { id: true },
            });
            if (!existingCalendar) {
                return res.status(400).json({ error: 'calendarId is invalid for this tenant' });
            }
        }

        const puestoId = Number(req.body?.puestoId);
        const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';

        if (!nombre || !email || !whatsapp || !Number.isInteger(puestoId) || puestoId <= 0) {
            return res.status(400).json({ error: 'nombre, email, whatsapp and puestoId are required' });
        }
        if (password && password.length < 8) {
            return res.status(400).json({ error: 'password must contain at least 8 characters' });
        }

        const puesto = await prisma.agentePuesto.findFirst({ where: { id: puestoId, tenantId: tenant.id, activo: true } });
        if (!puesto) {
            return res.status(400).json({ error: 'puestoId is invalid for this tenant' });
        }

        const passwordHash = password ? await bcrypt.hash(password, 12) : null;

        const agente = await db.createAgente({
            tenantId: tenant.id,
            nombre,
            email,
            whatsapp,
            puestoId,
            calendarLink: calendarLinkValidation.value,
            passwordHash,
        });

        const assignedCalendarId = calendarSelection.calendarId
            ? await assignCalendarToAgente({
                tenantId: tenant.id,
                agenteId: agente.id,
                calendarId: calendarSelection.calendarId,
            })
            : await ensureInternalCalendarForAgente({
                tenantId: tenant.id,
                agenteId: agente.id,
                agenteNombre: agente.nombre,
                agenteEmail: agente.email,
            });

        res.status(201).json({ ...agente, assignedCalendarId });
    } catch (err) {
        if (err?.code === 'P2002') {
            return res.status(409).json({ error: 'Ya existe un registro con datos duplicados para este agente' });
        }
        if (err?.code === 'P2003') {
            return res.status(400).json({ error: 'Referencia invalida al crear el agente (puesto, calendario o jefe)' });
        }
        if (err?.code === 'P2025') {
            return res.status(404).json({ error: 'No se encontro el recurso relacionado para completar la creacion del agente' });
        }
        next(err);
    }
});

// PATCH /admin/tenants/:slug/agentes/:id/estado
router.patch('/tenants/:slug/agentes/:id/estado', requirePermiso('EDIT_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const { estado } = req.body;
        if (!estado) return res.status(400).json({ error: 'estado is required' });
        const result = await db.setAgenteEstado(Number(req.params.id), tenant.id, estado);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/agentes/:id
router.patch('/tenants/:slug/agentes/:id', requirePermiso('EDIT_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const id = Number(req.params.id);
        const nombre = String(req.body?.nombre ?? '').trim();
        const email = String(req.body?.email ?? '').trim();
        const whatsapp = String(req.body?.whatsapp ?? '').trim();
        const calendarLinkValidation = normalizeOptionalHttpUrl(req.body?.calendarLink);
        if (calendarLinkValidation.error) {
            return res.status(400).json({ error: calendarLinkValidation.error });
        }

        const calendarSelection = parseCalendarSelection(req.body?.calendarId);
        if (calendarSelection.error) {
            return res.status(400).json({ error: calendarSelection.error });
        }

        if (calendarSelection.calendarId) {
            const existingCalendar = await prisma.calendar.findFirst({
                where: { id: calendarSelection.calendarId, tenantId: tenant.id },
                select: { id: true },
            });
            if (!existingCalendar) {
                return res.status(400).json({ error: 'calendarId is invalid for this tenant' });
            }
        }

        const puestoId = Number(req.body?.puestoId);
        const rawJefeAdminId = req.body?.jefeAdminId;
        const jefeAdminId = rawJefeAdminId != null && rawJefeAdminId !== '' ? Number(rawJefeAdminId) : null;
        const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'invalid agente id' });
        }
        if (!nombre || !email || !whatsapp || !Number.isInteger(puestoId) || puestoId <= 0) {
            return res.status(400).json({ error: 'nombre, email, whatsapp and puestoId are required' });
        }
        if (password && password.length < 8) {
            return res.status(400).json({ error: 'password must contain at least 8 characters' });
        }
        if (jefeAdminId !== null && (!Number.isInteger(jefeAdminId) || jefeAdminId <= 0)) {
            return res.status(400).json({ error: 'jefeAdminId is invalid' });
        }

        const puesto = await prisma.agentePuesto.findFirst({ where: { id: puestoId, tenantId: tenant.id, activo: true } });
        if (!puesto) {
            return res.status(400).json({ error: 'puestoId is invalid for this tenant' });
        }

        if (jefeAdminId !== null) {
            const jefeAdmin = await prisma.adminUser.findFirst({ where: { id: jefeAdminId, tenantId: tenant.id } });
            if (!jefeAdmin) {
                return res.status(400).json({ error: 'jefeAdminId is invalid for this tenant' });
            }
        }

        const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;

        const result = await db.updateAgente({
            id,
            tenantId: tenant.id,
            nombre,
            email,
            whatsapp,
            puestoId,
            calendarLink: calendarLinkValidation.value,
            jefeAdminId,
            passwordHash,
        });
        if (!result || result.count === 0) {
            return res.status(404).json({ error: 'Agente not found' });
        }

        if (calendarSelection.provided) {
            const assignedCalendarId = await assignCalendarToAgente({
                tenantId: tenant.id,
                agenteId: id,
                calendarId: calendarSelection.calendarId,
            });
            if (calendarSelection.calendarId && !assignedCalendarId) {
                return res.status(400).json({ error: 'calendarId is invalid for this tenant' });
            }
        }

        const agentes = await db.listAgentes(tenant.id);
        const agente = agentes.find((a) => a.id === id) ?? null;
        return res.json(agente);
    } catch (err) {
        if (err?.code === 'P2002') {
            return res.status(409).json({ error: 'Ya existe un registro con datos duplicados para este agente' });
        }
        if (err?.code === 'P2003') {
            return res.status(400).json({ error: 'Referencia invalida al actualizar el agente (puesto, calendario o jefe)' });
        }
        if (err?.code === 'P2025') {
            return res.status(404).json({ error: 'No se encontro el agente o un recurso relacionado para completar la actualizacion' });
        }
        next(err);
    }
});

// PATCH /admin/tenants/:slug/agentes/:id/presencia
// Body: { online: true|false }
// Called by the admin UI when an agent connects/disconnects from the panel.
router.patch('/tenants/:slug/agentes/:id/presencia', requirePermiso('EDIT_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const agenteId = Number(req.params.id);
        const { online } = req.body;
        if (typeof online !== 'boolean') return res.status(400).json({ error: 'online (boolean) is required' });

        if (online) await db.setAgenteLastSeen(agenteId, tenant.id);

        // Emit real-time presence event
        socketService.emit(tenant.id, 'agent_presence', { agenteId, online, lastSeenAt: online ? new Date() : null });
        audit({ adminUserId: req.admin?.adminUserId, tenantId: tenant.id, accion: 'AGENTE_PRESENCIA', entidad: 'agente', entidadId: String(agenteId), metadata: { online } });

        return res.json({ ok: true, agenteId, online });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Solicitudes (per-tenant)
// ---------------------------------------------------------------------------

// POST /admin/tenants/:slug/solicitudes — create solicitud from admin panel
router.post('/tenants/:slug/solicitudes', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const {
            userId,
            nombre,
            telefonoContacto,
            horario,
            estado,
            flowId,
            conversationId,
            origin,
            titulo,
            prioridad,
            flowNodeRef,
            categoria,
            subcategoria,
            dueAt,
        } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId is required' });
        const normalizedEstado = db.normalizeSolicitudStatus(estado, db.SOLICITUD_STATUS.OPEN);
        if (!SOLICITUD_STATES.has(normalizedEstado)) {
            return res.status(400).json({ error: `estado must be one of: ${Array.from(SOLICITUD_STATES).join(', ')}` });
        }
        const solicitud = await db.saveSolicitud(Number(userId), {
            nombre: nombre || null,
            telefono_contacto: telefonoContacto || null,
            horario: horario || null,
            estado: normalizedEstado,
            flow_id: flowId != null ? Number(flowId) : null,
            conversation_id: conversationId || null,
            origin: origin || 'manual',
            title: titulo || null,
            priority: prioridad || null,
            flow_node_ref: flowNodeRef || null,
            categoria: categoria || null,
            subcategoria: subcategoria || null,
            due_at: dueAt || null,
        }, tenant.id);
        audit({ adminUserId: req.admin?.adminUserId, tenantId: tenant.id, accion: 'CREATE_SOLICITUD', entidad: 'solicitud', entidadId: String(solicitud.id), ip: req.ip, userAgent: req.headers['user-agent'], metadata: { userId, nombre } });
        socketService.emit(tenant.id, 'SOLICITUD_CREATED', { solicitud });
        queueSolicitudWebhook({
            tenant,
            req,
            event: 'solicitud.created',
            solicitudId: solicitud.id,
            payload: {
                id: solicitud.id,
                estado: solicitud.estado,
                prioridad: solicitud.prioridad,
                agenteId: solicitud.agenteId,
                origin: solicitud.origin,
                userId: solicitud.userId,
            },
        });
        res.status(201).json(solicitud);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes?estado=pendiente&page=1&limit=20
router.get('/tenants/:slug/solicitudes', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        const { estado, page, limit, userId, categoria } = req.query;
        const normalizedEstado = estado ? db.normalizeSolicitudStatus(estado, '') : '';
        const currentPage = page ? Number(page) : 1;
        const currentLimit = limit ? Number(limit) : 20;
        const normalizedUserId = userId !== undefined ? Number(userId) : undefined;

        const solicitudes = await db.listSolicitudes(tenant.id, {
            estado: normalizedEstado || undefined,
            userId: normalizedUserId,
            categoria: categoria || undefined,
            page: currentPage,
            limit: currentLimit,
        });

        const normalizedCategoria = String(categoria || '').trim();

        const enriched = solicitudes.map((item) => ({
            ...item,
            slaStatus: db.calculateSlaStatus(item, { warningThresholdMinutes: tenantConfig.warningThresholdMinutes }),
        }));

        const where = {
            tenantId: tenant.id,
            ...(normalizedEstado ? { estado: normalizedEstado } : {}),
            ...(normalizedUserId !== undefined ? { userId: normalizedUserId } : {}),
            ...(normalizedCategoria ? { categoria: normalizedCategoria } : {}),
        };
        const total = await prisma.solicitud.count({ where });

        res.json({
            data: enriched,
            total,
            page: currentPage,
            limit: currentLimit,
        });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/search
router.get('/tenants/:slug/solicitudes/search', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        if (!tenantConfig.advancedSearchEnabled) {
            return res.status(403).json({ error: 'Advanced search is disabled for this tenant' });
        }

        const {
            q,
            estado,
            agenteId,
            prioridad,
            categoria,
            subcategoria,
            channelSource,
            tags,
            from,
            to,
            dueFrom,
            dueTo,
            page,
            limit,
            slaStatus,
        } = req.query;

        const result = await db.searchSolicitudes(tenant.id, {
            q,
            estado,
            agenteId,
            prioridad,
            categoria,
            subcategoria,
            channelSource,
            tags,
            from,
            to,
            dueFrom,
            dueTo,
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 20,
            slaStatus,
            warningThresholdMinutes: tenantConfig.warningThresholdMinutes,
        });

        return res.json(result);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/stats
router.get('/tenants/:slug/solicitudes/stats', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);

        const stats = await db.getSolicitudesStats(tenant.id, {
            warningThresholdMinutes: tenantConfig.warningThresholdMinutes,
        });
        return res.json(stats);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/report
router.get('/tenants/:slug/solicitudes/report', requirePermiso('VIEW_METRICS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const report = await db.getSolicitudesReport(tenant.id, {
            from: req.query?.from,
            to: req.query?.to,
            groupBy: req.query?.groupBy,
        });

        return res.json(report);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/config
router.get('/tenants/:slug/solicitudes/config', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const config = await db.getSolicitudesEnterpriseConfig(tenant.id);
        return res.json(config);
    } catch (err) {
        next(err);
    }
});

// PUT /admin/tenants/:slug/solicitudes/config
router.put('/tenants/:slug/solicitudes/config', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const config = await db.setSolicitudesEnterpriseConfig(tenant.id, req.body || {});
        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'UPDATE_SOLICITUD_CONFIG',
            entidad: 'solicitud_config',
            entidadId: tenant.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { fields: Object.keys(req.body || {}) },
        });
        return res.json(config);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/webhooks
router.get('/tenants/:slug/solicitudes/webhooks', requirePermiso('MANAGE_WEBHOOKS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        const data = await db.listWebhookConfigs(tenant.id, { event: req.query?.event });

        return res.json({
            enabled: Boolean(tenantConfig?.webhooksEnabled),
            supportedEvents: Array.from(WEBHOOK_EVENTS),
            data,
        });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/solicitudes/webhooks
router.post('/tenants/:slug/solicitudes/webhooks', requirePermiso('MANAGE_WEBHOOKS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const event = String(req.body?.event || '').trim().toLowerCase();
        const url = String(req.body?.url || '').trim();
        if (!event || !WEBHOOK_EVENTS.has(event)) {
            return res.status(400).json({ error: `event must be one of: ${Array.from(WEBHOOK_EVENTS).join(', ')}` });
        }
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return res.status(400).json({ error: 'url must be a valid http(s) URL' });
            }
        } catch (_err) {
            return res.status(400).json({ error: 'url must be a valid URL' });
        }

        const created = await db.createWebhookConfig(tenant.id, {
            event,
            url,
            active: req.body?.active,
        });
        if (!created) return res.status(400).json({ error: 'Invalid webhook payload' });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'CREATE_SOLICITUD_WEBHOOK',
            entidad: 'webhook_config',
            entidadId: String(created.id),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { event: created.event, url: created.url, active: created.active },
        });

        return res.status(201).json(created);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/solicitudes/webhooks/:id
router.patch('/tenants/:slug/solicitudes/webhooks/:id', requirePermiso('MANAGE_WEBHOOKS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const patch = {};
        if (req.body?.event !== undefined) {
            const event = String(req.body.event || '').trim().toLowerCase();
            if (!WEBHOOK_EVENTS.has(event)) {
                return res.status(400).json({ error: `event must be one of: ${Array.from(WEBHOOK_EVENTS).join(', ')}` });
            }
            patch.event = event;
        }
        if (req.body?.url !== undefined) {
            const url = String(req.body.url || '').trim();
            try {
                const parsed = new URL(url);
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                    return res.status(400).json({ error: 'url must be a valid http(s) URL' });
                }
            } catch (_err) {
                return res.status(400).json({ error: 'url must be a valid URL' });
            }
            patch.url = url;
        }
        if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);

        const updated = await db.updateWebhookConfig(tenant.id, Number(req.params.id), patch);
        if (!updated) return res.status(404).json({ error: 'Webhook config not found' });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'UPDATE_SOLICITUD_WEBHOOK',
            entidad: 'webhook_config',
            entidadId: req.params.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { fields: Object.keys(patch) },
        });

        return res.json(updated);
    } catch (err) {
        next(err);
    }
});

// DELETE /admin/tenants/:slug/solicitudes/webhooks/:id
router.delete('/tenants/:slug/solicitudes/webhooks/:id', requirePermiso('MANAGE_WEBHOOKS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const removed = await db.deleteWebhookConfig(tenant.id, Number(req.params.id));
        if (!removed) return res.status(404).json({ error: 'Webhook config not found' });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'DELETE_SOLICITUD_WEBHOOK',
            entidad: 'webhook_config',
            entidadId: req.params.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { event: removed.event, url: removed.url },
        });

        return res.status(204).end();
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/webhooks/deliveries
router.get('/tenants/:slug/solicitudes/webhooks/deliveries', requirePermiso('MANAGE_WEBHOOKS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const data = await db.listSolicitudWebhookDeliveries(tenant.id, {
            event: req.query?.event,
            status: req.query?.status,
            limit: req.query?.limit,
        });

        return res.json({ data });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/solicitudes/webhooks/test
router.post('/tenants/:slug/solicitudes/webhooks/test', requirePermiso('MANAGE_WEBHOOKS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const event = String(req.body?.event || 'solicitud.updated').trim().toLowerCase();
        if (!WEBHOOK_EVENTS.has(event)) {
            return res.status(400).json({ error: `event must be one of: ${Array.from(WEBHOOK_EVENTS).join(', ')}` });
        }

        queueSolicitudWebhook({
            tenant,
            req,
            event,
            solicitudId: null,
            payload: {
                test: true,
                triggeredAt: new Date().toISOString(),
                actor: req.admin?.email || null,
            },
        });

        return res.json({ ok: true, queued: true, event });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/:id — full detail for CRM-like view
router.get('/tenants/:slug/solicitudes/:id', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const solicitud = await db.getSolicitudDetalle(Number(req.params.id), tenant.id);
        if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });

        return res.json(solicitud);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/solicitudes/:id/estado
router.patch('/tenants/:slug/solicitudes/:id/estado', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const { estado } = req.body;
        if (!estado) return res.status(400).json({ error: 'estado is required' });
        const normalizedEstado = db.normalizeSolicitudStatus(estado, '');
        if (!normalizedEstado || !SOLICITUD_STATES.has(normalizedEstado)) {
            return res.status(400).json({ error: `estado must be one of: ${Array.from(SOLICITUD_STATES).join(', ')}` });
        }

        const result = await db.updateSolicitudEstado(Number(req.params.id), tenant.id, normalizedEstado);
        const solicitud = await db.getSolicitudById(Number(req.params.id), tenant.id);
        if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });

        // Log status change to conversation timeline (best-effort)
        convLogger.logTaskStatusChange({
          tenantId:    tenant.id,
          solicitudId: Number(req.params.id),
          fromStatus:  solicitud.estado ?? 'unknown',
          toStatus:    normalizedEstado,
          agenteId:    solicitud.agenteId ?? null,
        }).catch(() => {});

        // Audit + real-time
        audit({ adminUserId: req.admin?.adminUserId, tenantId: tenant.id, accion: 'UPDATE_SOLICITUD_ESTADO', entidad: 'solicitud', entidadId: req.params.id, ip: req.ip, userAgent: req.headers['user-agent'], metadata: { estado: normalizedEstado } });
        socketService.emit(tenant.id, 'STATUS_UPDATED', { solicitudId: Number(req.params.id), estado: normalizedEstado });

        if (normalizedEstado === db.SOLICITUD_STATUS.COMPLETED) {
            await resumeFlowForCompletedTask({ tenantId: tenant.id, solicitud });
        }

        queueSolicitudWebhook({
            tenant,
            req,
            event: 'solicitud.status_changed',
            solicitudId: Number(req.params.id),
            payload: {
                id: Number(req.params.id),
                estado: normalizedEstado,
            },
        });

        res.json(result);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/solicitudes/:id/agente
router.patch('/tenants/:slug/solicitudes/:id/agente', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const { agenteId } = req.body;
        if (!agenteId) return res.status(400).json({ error: 'agenteId is required' });
        const result = await db.assignAgenteToSolicitud(Number(req.params.id), tenant.id, Number(agenteId));
        // Audit + real-time
        audit({ adminUserId: req.admin?.adminUserId, tenantId: tenant.id, accion: 'ASSIGN_AGENTE', entidad: 'solicitud', entidadId: req.params.id, ip: req.ip, userAgent: req.headers['user-agent'], metadata: { agenteId } });
        socketService.emit(tenant.id, 'AGENT_ASSIGNED', { solicitudId: Number(req.params.id), agenteId: Number(agenteId) });
        queueSolicitudWebhook({
            tenant,
            req,
            event: 'solicitud.assigned',
            solicitudId: Number(req.params.id),
            payload: {
                id: Number(req.params.id),
                agenteId: Number(agenteId),
            },
        });

        await createAdminNotification({
            tenantId: tenant.id,
            adminUserId: req.admin?.adminUserId,
            type: 'solicitud.assigned',
            title: 'Solicitud asignada',
            message: `La solicitud #${Number(req.params.id)} fue asignada al agente #${Number(agenteId)}.`,
            data: { solicitudId: Number(req.params.id), agenteId: Number(agenteId) },
        });

        try {
            const assignedAgente = await prisma.agente.findFirst({
                where: { id: Number(agenteId), tenantId: tenant.id },
                select: { id: true, nombre: true, whatsapp: true },
            });

            const recipient = normalizeWhatsappRecipient(assignedAgente?.whatsapp);
            if (recipient) {
                const { phoneNumberId, accessToken } = await db.getWaCredentials(tenant.id);
                if (phoneNumberId && accessToken) {
                    const loginUrl = await buildAgentSolicitudesUrl(tenant.id);
                    const text = buildAgentAssignmentWhatsappText({
                        solicitudId: Number(req.params.id),
                        agenteNombre: assignedAgente?.nombre,
                        tenantNombre: tenant.nombre,
                        loginUrl,
                    });
                    const waResp = await wa.sendTextMessage(phoneNumberId, recipient, text, accessToken);
                    audit({
                        adminUserId: req.admin?.adminUserId,
                        tenantId: tenant.id,
                        accion: 'AGENT_ASSIGNMENT_WHATSAPP_NOTIFIED',
                        entidad: 'solicitud',
                        entidadId: req.params.id,
                        ip: req.ip,
                        userAgent: req.headers['user-agent'],
                        metadata: {
                            agenteId: Number(agenteId),
                            waMsgId: waResp?.messages?.[0]?.id ?? null,
                            recipient,
                        },
                    });
                }
            }
        } catch (notifyErr) {
            audit({
                adminUserId: req.admin?.adminUserId,
                tenantId: tenant.id,
                accion: 'AGENT_ASSIGNMENT_WHATSAPP_NOTIFY_FAILED',
                entidad: 'solicitud',
                entidadId: req.params.id,
                ip: req.ip,
                userAgent: req.headers['user-agent'],
                metadata: {
                    agenteId: Number(agenteId),
                    error: String(notifyErr?.message || notifyErr || 'unknown_error'),
                },
            });
        }

        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Notificaciones admin (per-user)
// ---------------------------------------------------------------------------

// GET /admin/tenants/:slug/notifications?page=1&limit=10
router.get('/tenants/:slug/notifications', requirePermiso('VIEW_NOTIFICATIONS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const { page, limit, skip } = parsePagination(req.query?.page, req.query?.limit);
        const where = {
            tenantId: tenant.id,
            ...(req.admin?.superAdmin ? {} : { adminUserId: req.admin?.adminUserId }),
        };

        const [items, total, unreadCount] = await Promise.all([
            prisma.adminNotification.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip,
                take: limit,
            }),
            prisma.adminNotification.count({ where }),
            prisma.adminNotification.count({ where: { ...where, readAt: null } }),
        ]);

        return res.json({
            data: items.map(serializeNotification),
            total,
            unreadCount,
            page,
            limit,
        });
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/notifications/:id/read
router.patch('/tenants/:slug/notifications/:id/read', requirePermiso('VIEW_NOTIFICATIONS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'invalid notification id' });
        }

        const where = {
            id,
            tenantId: tenant.id,
            ...(req.admin?.superAdmin ? {} : { adminUserId: req.admin?.adminUserId }),
        };

        const found = await prisma.adminNotification.findFirst({ where });
        if (!found) return res.status(404).json({ error: 'Notification not found' });

        const updated = await prisma.adminNotification.update({
            where: { id },
            data: { readAt: found.readAt || new Date() },
        });

        return res.json(serializeNotification(updated));
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/notifications/read-all
router.patch('/tenants/:slug/notifications/read-all', requirePermiso('VIEW_NOTIFICATIONS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const result = await prisma.adminNotification.updateMany({
            where: {
                tenantId: tenant.id,
                readAt: null,
                ...(req.admin?.superAdmin ? {} : { adminUserId: req.admin?.adminUserId }),
            },
            data: { readAt: new Date() },
        });

        return res.json({ updated: result.count });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/solicitudes/:id/escalate
router.post('/tenants/:slug/solicitudes/:id/escalate', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        if (!tenantConfig.manualEscalationEnabled) {
            return res.status(403).json({ error: 'Manual escalation is disabled for this tenant' });
        }

        const solicitud = await db.getSolicitudById(Number(req.params.id), tenant.id);
        if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });
        if (!solicitud.userId) {
            return res.status(400).json({ error: 'La solicitud debe tener un usuario asociado para escalar' });
        }

        const reason = req.body?.reason ? String(req.body.reason) : null;
        const rawTargetAdminUserId = req.body?.targetAdminUserId;
        const targetAdminUserId = rawTargetAdminUserId != null && rawTargetAdminUserId !== ''
            ? Number(rawTargetAdminUserId)
            : null;

        if (targetAdminUserId != null) {
            if (!Number.isInteger(targetAdminUserId) || targetAdminUserId <= 0) {
                return res.status(400).json({ error: 'targetAdminUserId must be a positive integer' });
            }
            const targetAdmin = await prisma.adminUser.findFirst({
                where: { id: targetAdminUserId },
                select: { id: true },
            });
            if (!targetAdmin) {
                return res.status(400).json({ error: 'targetAdminUserId is not valid' });
            }
        }

        const escalated = await db.escalateSolicitud({
            id: Number(req.params.id),
            tenantId: tenant.id,
            actorUserId: req.admin?.adminUserId ?? null,
            reason,
            targetAdminUserId,
        });
        if (!escalated) return res.status(404).json({ error: 'Solicitud not found' });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'ESCALATE_SOLICITUD',
            entidad: 'solicitud',
            entidadId: req.params.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { reason, escalationLevel: escalated.escalationLevel, targetAdminUserId },
        });

        socketService.emit(tenant.id, 'SOLICITUD_ESCALATED', {
            solicitudId: Number(req.params.id),
            escalationLevel: escalated.escalationLevel,
            reason,
            targetAdminUserId,
        });

        queueSolicitudWebhook({
            tenant,
            req,
            event: 'solicitud.escalated',
            solicitudId: Number(req.params.id),
            payload: {
                id: Number(req.params.id),
                escalationLevel: escalated.escalationLevel,
                reason,
                targetAdminUserId,
            },
        });

        return res.json(escalated);
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/solicitudes/:id/portal-token
router.post('/tenants/:slug/solicitudes/:id/portal-token', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        if (!tenantConfig.customerPortalEnabled) {
            return res.status(403).json({ error: 'Customer portal is disabled for this tenant' });
        }

        const solicitud = await db.getSolicitudById(Number(req.params.id), tenant.id);
        if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });

        const token = generatePortalToken({
            tenantId: tenant.id,
            solicitudId: solicitud.id,
            userId: solicitud.userId ?? null,
        });

        const origin = process.env.CUSTOMER_PORTAL_BASE_URL || process.env.ADMIN_BASE_URL || '';
        const normalizedOrigin = String(origin).replace(/\/+$/, '');
        const path = `/portal/${encodeURIComponent(token)}/solicitudes`;

        return res.json({
            token,
            path,
            url: normalizedOrigin ? `${normalizedOrigin}${path}` : null,
        });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/:id/comments
router.get('/tenants/:slug/solicitudes/:id/comments', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const solicitud = await db.getSolicitudById(Number(req.params.id), tenant.id);
        if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });

        const comments = await db.getSolicitudComments(Number(req.params.id), tenant.id);
        return res.json({ data: comments });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/solicitudes/:id/comments
router.post('/tenants/:slug/solicitudes/:id/comments', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const { content, visibility, attachments } = req.body || {};
        if (!content || !String(content).trim()) {
            return res.status(400).json({ error: 'content is required' });
        }

        const comment = await db.addSolicitudComment({
            solicitudId: Number(req.params.id),
            tenantId: tenant.id,
            userId: req.admin?.adminUserId ?? null,
            content: String(content).trim(),
            visibility,
            attachments,
        });
        if (!comment) return res.status(404).json({ error: 'Solicitud not found' });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'ADD_SOLICITUD_COMMENT',
            entidad: 'solicitud',
            entidadId: req.params.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { commentId: comment.id, visibility: comment.visibility },
        });

        socketService.emit(tenant.id, 'SOLICITUD_COMMENT_ADDED', {
            solicitudId: Number(req.params.id),
            comment,
        });

        queueSolicitudWebhook({
            tenant,
            req,
            event: 'solicitud.comment_added',
            solicitudId: Number(req.params.id),
            payload: {
                id: Number(req.params.id),
                commentId: comment.id,
                visibility: comment.visibility,
            },
        });

        return res.status(201).json(comment);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/:id/history
router.get('/tenants/:slug/solicitudes/:id/history', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const solicitud = await db.getSolicitudById(Number(req.params.id), tenant.id);
        if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });

        const history = await db.getSolicitudHistory(Number(req.params.id), tenant.id);
        return res.json({ data: history });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/solicitudes/:id/messages
router.get('/tenants/:slug/solicitudes/:id/messages', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const solicitudId = Number(req.params.id);
        if (!Number.isInteger(solicitudId) || solicitudId <= 0) {
            return res.status(400).json({ error: 'invalid solicitud id' });
        }

        const result = await db.listMensajesBySolicitud({
            solicitudId,
            tenantId: tenant.id,
            page: req.query?.page,
            limit: req.query?.limit,
            q: req.query?.q,
            direccion: req.query?.direccion,
            start: req.query?.start,
            end: req.query?.end,
            lectura: req.query?.lectura,
        });
        if (!result) return res.status(404).json({ error: 'Solicitud not found' });

        return res.json({
            ok: true,
            solicitud: result.solicitud,
            data: result.data,
            total: result.total,
            page: result.page,
            limit: result.limit,
            meta: {
                page: result.page,
                limit: result.limit,
                total: result.total,
            },
        });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/solicitudes/:id/messages
router.post('/tenants/:slug/solicitudes/:id/messages', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const solicitudId = Number(req.params.id);
        if (!Number.isInteger(solicitudId) || solicitudId <= 0) {
            return res.status(400).json({ error: 'invalid solicitud id' });
        }

        const text = String(req.body?.text ?? '').trim();
        if (!text) return res.status(400).json({ error: 'text is required' });
        const replyToMensajeId = Number(req.body?.replyToMensajeId);

        const solicitud = await db.getSolicitudMessagingContext(solicitudId, tenant.id);
        if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });
        if (!solicitud.user?.phone) {
            return res.status(400).json({ error: 'Solicitud has no WhatsApp contact' });
        }

        const { phoneNumberId, accessToken } = await db.getWaCredentials(tenant.id);
        if (!phoneNumberId || !accessToken) {
            return res.status(422).json({ error: 'WhatsApp credentials not configured for this tenant' });
        }

        const waResp = await wa.sendTextMessage(phoneNumberId, solicitud.user.phone, text, accessToken);

        const mensaje = await db.saveMensaje({
            tenantId: tenant.id,
            userId: solicitud.userId,
            agenteId: solicitud.agenteId ?? null,
            waMsgId: waResp?.messages?.[0]?.id ?? null,
            status: 'sent',
            direccion: 'salida',
            tipo: 'text',
            contenido: {
                text,
                source: 'admin_solicitud',
                solicitudId,
                actor: {
                    type: 'admin',
                    adminUserId: req.admin?.adminUserId ?? null,
                    email: req.admin?.email ?? null,
                },
            },
            conversationId: solicitud.conversationId || undefined,
            replyToMensajeId: Number.isInteger(replyToMensajeId) && replyToMensajeId > 0 ? replyToMensajeId : null,
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'SEND_SOLICITUD_MESSAGE',
            entidad: 'solicitud',
            entidadId: String(solicitudId),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { mensajeId: mensaje?.id ?? null, waMsgId: mensaje?.waMsgId ?? null },
        });

        socketService.emit(tenant.id, 'SOLICITUD_MESSAGE_SENT', {
            solicitudId,
            mensaje,
        });

        return res.status(201).json({
            ok: true,
            data: {
                solicitudId,
                mensaje,
                waResponse: waResp,
            },
            solicitudId,
            mensaje,
            waResponse: waResp,
        });
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/solicitudes/:id
router.patch('/tenants/:slug/solicitudes/:id', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const allowedFields = [
            'estado',
            'prioridad',
            'agenteId',
            'categoria',
            'subcategoria',
            'tags',
            'followUpDate',
            'dueAt',
            'resolutionNotes',
            'customerNotes',
        ];
        const updates = {};
        for (const key of allowedFields) {
            if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
                const value = req.body[key];
                // Skip empty strings and undefined (keep null for explicit null values)
                if (value === '' || value === undefined) {
                    continue;
                }
                updates[key] = value;
            }
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({ error: 'No updatable fields provided' });
        }

        if (updates.estado !== undefined) {
            const normalizedEstado = db.normalizeSolicitudStatus(updates.estado, '');
            if (!normalizedEstado || !SOLICITUD_STATES.has(normalizedEstado)) {
                return res.status(400).json({ error: `estado must be one of: ${Array.from(SOLICITUD_STATES).join(', ')}` });
            }
            updates.estado = normalizedEstado;
        }

        const updated = await db.updateSolicitudFields(
            Number(req.params.id),
            tenant.id,
            updates,
            req.admin?.adminUserId ?? null,
        );
        if (!updated) return res.status(404).json({ error: 'Solicitud not found' });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'PATCH_SOLICITUD',
            entidad: 'solicitud',
            entidadId: req.params.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { fields: Object.keys(updates) },
        });

        socketService.emit(tenant.id, 'SOLICITUD_UPDATED', {
            solicitudId: Number(req.params.id),
            fields: Object.keys(updates),
        });

        queueSolicitudWebhook({
            tenant,
            req,
            event: 'solicitud.updated',
            solicitudId: Number(req.params.id),
            payload: {
                id: Number(req.params.id),
                fields: Object.keys(updates),
            },
        });

        return res.json(updated);
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/solicitudes/bulk-update
router.post('/tenants/:slug/solicitudes/bulk-update', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const updates = req.body?.updates || {};
        if (!ids.length) return res.status(400).json({ error: 'ids array is required' });
        if (!Object.keys(updates).length) return res.status(400).json({ error: 'updates object is required' });

        if (updates.estado !== undefined) {
            const normalizedEstado = db.normalizeSolicitudStatus(updates.estado, '');
            if (!normalizedEstado || !SOLICITUD_STATES.has(normalizedEstado)) {
                return res.status(400).json({ error: `estado must be one of: ${Array.from(SOLICITUD_STATES).join(', ')}` });
            }
            updates.estado = normalizedEstado;
        }

        const result = await db.bulkUpdateSolicitudes({
            tenantId: tenant.id,
            ids,
            updates,
            actorUserId: req.admin?.adminUserId ?? null,
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'BULK_UPDATE_SOLICITUDES',
            entidad: 'solicitud',
            entidadId: null,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { idsCount: ids.length, fields: Object.keys(updates) },
        });

        socketService.emit(tenant.id, 'SOLICITUDS_BULK_UPDATED', {
            ids,
            fields: Object.keys(updates),
            result,
        });

        return res.json(result);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/sla-policies
router.get('/tenants/:slug/sla-policies', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        if (!tenantConfig.slaEnabled) {
            return res.json({ data: [] });
        }

        const data = await db.listSlaPolicies(tenant.id);
        return res.json({ data });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/sla-policies
router.post('/tenants/:slug/sla-policies', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        if (!tenantConfig.slaEnabled) {
            return res.status(403).json({ error: 'SLA policies are disabled for this tenant' });
        }

        const nombre = String(req.body?.nombre || '').trim();
        if (!nombre) return res.status(400).json({ error: 'nombre is required' });

        const created = await db.createSlaPolicy(tenant.id, req.body || {});
        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'CREATE_SLA_POLICY',
            entidad: 'sla_policy',
            entidadId: String(created.id),
            metadata: { nombre: created.nombre },
        });
        return res.status(201).json(created);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/sla-policies/:id
router.patch('/tenants/:slug/sla-policies/:id', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        if (!tenantConfig.slaEnabled) {
            return res.status(403).json({ error: 'SLA policies are disabled for this tenant' });
        }

        const updated = await db.updateSlaPolicy(tenant.id, Number(req.params.id), req.body || {});
        if (!updated) return res.status(404).json({ error: 'SLA policy not found' });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'UPDATE_SLA_POLICY',
            entidad: 'sla_policy',
            entidadId: req.params.id,
            metadata: { fields: Object.keys(req.body || {}) },
        });
        return res.json(updated);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/assignment-rules
router.get('/tenants/:slug/assignment-rules', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        if (!tenantConfig.assignmentRulesEnabled) {
            return res.json({ data: [] });
        }

        const data = await db.listSolicitudAssignmentRules(tenant.id);
        return res.json({ data });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/assignment-rules
router.post('/tenants/:slug/assignment-rules', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        if (!tenantConfig.assignmentRulesEnabled) {
            return res.status(403).json({ error: 'Assignment rules are disabled for this tenant' });
        }

        const created = await db.createSolicitudAssignmentRule(tenant.id, req.body || {});
        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'CREATE_ASSIGNMENT_RULE',
            entidad: 'solicitud_assignment_rule',
            entidadId: String(created.id),
        });
        return res.status(201).json(created);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/assignment-rules/:id
router.patch('/tenants/:slug/assignment-rules/:id', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
        if (!tenantConfig.assignmentRulesEnabled) {
            return res.status(403).json({ error: 'Assignment rules are disabled for this tenant' });
        }

        const updated = await db.updateSolicitudAssignmentRule(tenant.id, Number(req.params.id), req.body || {});
        if (!updated) return res.status(404).json({ error: 'Assignment rule not found' });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'UPDATE_ASSIGNMENT_RULE',
            entidad: 'solicitud_assignment_rule',
            entidadId: req.params.id,
            metadata: { fields: Object.keys(req.body || {}) },
        });
        return res.json(updated);
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agenda (weekly planning)
// ---------------------------------------------------------------------------

// GET /admin/tenants/:slug/agenda/feature
router.get('/tenants/:slug/agenda/feature', requirePermiso('VIEW_AGENDA'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const config = await db.getConfig(tenant.id, 'feature_agenda_enabled');
        const enabled = Boolean(config?.valor?.enabled);
        res.json({ enabled });
    } catch (err) {
        next(err);
    }
});

// PUT /admin/tenants/:slug/agenda/feature
router.put('/tenants/:slug/agenda/feature', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const enabled = Boolean(req.body?.enabled);
        await db.setConfig(tenant.id, 'feature_agenda_enabled', { enabled });
        res.json({ enabled });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/agenda?start=ISO&end=ISO&tipo=&estado=&agenteId=
router.get('/tenants/:slug/agenda', requirePermiso('VIEW_AGENDA'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const startAt = parseIsoDate(req.query.start);
        const endAt = parseIsoDate(req.query.end);
        if (!startAt || !endAt) {
            return res.status(400).json({ error: 'start and end ISO dates are required' });
        }
        if (startAt >= endAt) {
            return res.status(400).json({ error: 'start must be earlier than end' });
        }

        const where = {
            tenantId: tenant.id,
            startAt: { lt: endAt },
            endAt: { gt: startAt },
        };

        if (req.query.tipo) {
            if (!AGENDA_TYPES.has(String(req.query.tipo))) {
                return res.status(400).json({ error: 'Invalid tipo' });
            }
            where.tipo = String(req.query.tipo);
        }

        if (req.query.estado) {
            if (!AGENDA_STATES.has(String(req.query.estado))) {
                return res.status(400).json({ error: 'Invalid estado' });
            }
            where.estado = String(req.query.estado);
        }

        if (req.query.agenteId) {
            where.assignments = { some: { agenteId: Number(req.query.agenteId) } };
        }

        const shouldIncludeAppointments = !req.query.tipo || String(req.query.tipo) === 'reunion';
        const agendaSettings = await db.getConfig(tenant.id, 'agenda_settings');
        const agendaSettingsValue = asObject(agendaSettings?.valor);

        let appointmentStatusFilter = null;
        if (req.query.estado) {
            const estado = String(req.query.estado);
            if (estado === 'pendiente') appointmentStatusFilter = ['scheduled', 'rescheduled'];
            else if (estado === 'completado') appointmentStatusFilter = ['completed'];
            else appointmentStatusFilter = [];
        }

        const [events, appointments] = await Promise.all([
            prisma.agendaEvent.findMany({
                where,
                include: {
                    assignments: { include: { agente: true } },
                },
                orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
            }),
            shouldIncludeAppointments
                ? prisma.appointment.findMany({
                      where: {
                          tenantId: tenant.id,
                          startTime: { lt: endAt },
                          endTime: { gt: startAt },
                          ...(Array.isArray(appointmentStatusFilter)
                              ? {
                                    status:
                                        appointmentStatusFilter.length > 0
                                            ? { in: appointmentStatusFilter }
                                            : { in: [] },
                                }
                              : { status: { not: 'cancelled' } }),
                          ...(req.query.agenteId
                              ? { calendar: { agenteId: Number(req.query.agenteId) } }
                              : {}),
                      },
                      include: {
                          calendar: {
                              include: {
                                  agente: {
                                      select: { id: true, nombre: true, email: true, estado: true },
                                  },
                              },
                          },
                      },
                      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
                  })
                : Promise.resolve([]),
        ]);

        const merged = [
            ...events.map(serializeAgendaEvent),
            ...appointments.map((appointment) => {
                const agenteId = Number(appointment?.calendar?.agente?.id);
                const appointmentColor = resolveAppointmentColor(agendaSettingsValue, agenteId);
                return serializeAppointmentAsAgendaEvent(appointment, appointmentColor);
            }),
        ].sort((a, b) => {
            const tA = new Date(a.startAt).getTime();
            const tB = new Date(b.startAt).getTime();
            if (tA !== tB) return tA - tB;
            return String(a.id).localeCompare(String(b.id));
        });

        res.json({ data: merged });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/agenda
router.post('/tenants/:slug/agenda', requirePermiso('CREATE_AGENDA'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const {
            titulo,
            descripcion,
            tipo,
            color,
            estado,
            startAt,
            endAt,
            reminderMinutes,
            flowId,
            triggerWebhookOnStart,
            webhookUrl,
            webhookMethod,
            webhookHeaders,
            webhookPayload,
            agenteIds,
        } = req.body;

        if (!titulo || typeof titulo !== 'string') {
            return res.status(400).json({ error: 'titulo is required' });
        }
        if (!AGENDA_TYPES.has(tipo)) {
            return res.status(400).json({ error: 'tipo must be one of reunion|tarea|automatizacion|webhook' });
        }
        const normalizedEstado = estado || 'pendiente';
        if (!AGENDA_STATES.has(normalizedEstado)) {
            return res.status(400).json({ error: 'estado must be one of pendiente|en_progreso|completado' });
        }

        const parsedStartAt = parseIsoDate(startAt);
        const parsedEndAt = parseIsoDate(endAt);
        if (!parsedStartAt || !parsedEndAt || parsedStartAt >= parsedEndAt) {
            return res.status(400).json({ error: 'Invalid startAt/endAt interval' });
        }

        if (flowId) {
            const flow = await prisma.flow.findFirst({ where: { id: Number(flowId), tenantId: tenant.id } });
            if (!flow) return res.status(400).json({ error: 'flowId does not exist for this tenant' });
        }

        const assignmentIds = Array.isArray(agenteIds)
            ? [...new Set(agenteIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
            : [];

        if (assignmentIds.length > 0) {
            const agentes = await prisma.agente.findMany({
                where: { tenantId: tenant.id, id: { in: assignmentIds } },
                select: { id: true },
            });
            if (agentes.length !== assignmentIds.length) {
                return res.status(400).json({ error: 'One or more agenteIds are invalid for this tenant' });
            }
        }

        const created = await prisma.$transaction(async (tx) => {
            const event = await tx.agendaEvent.create({
                data: {
                    tenantId: tenant.id,
                    createdByAdminUserId: req.admin?.adminUserId ?? null,
                    flowId: flowId ? Number(flowId) : null,
                    titulo: titulo.trim(),
                    descripcion: descripcion || null,
                    tipo,
                    color: color || '#60A5FA',
                    estado: normalizedEstado,
                    startAt: parsedStartAt,
                    endAt: parsedEndAt,
                    reminderMinutes: reminderMinutes ?? null,
                    triggerWebhookOnStart: Boolean(triggerWebhookOnStart),
                    webhookUrl: webhookUrl || null,
                    webhookMethod: webhookMethod || null,
                    webhookHeaders: webhookHeaders || undefined,
                    webhookPayload: webhookPayload || undefined,
                    assignments: assignmentIds.length
                        ? { create: assignmentIds.map((agenteId) => ({ agenteId })) }
                        : undefined,
                },
                include: { assignments: { include: { agente: true } } },
            });

            await tx.agendaEventLog.create({
                data: {
                    tenantId: tenant.id,
                    eventId: event.id,
                    adminUserId: req.admin?.adminUserId ?? null,
                    accion: 'CREATE',
                    metadata: { tipo: event.tipo, estado: event.estado },
                },
            });

            return event;
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'CREATE_AGENDA_EVENT',
            entidad: 'agenda_event',
            entidadId: String(created.id),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { tipo: created.tipo, estado: created.estado },
        });

        socketService.emit(tenant.id, 'agenda:event_created', serializeAgendaEvent(created));
        res.status(201).json(serializeAgendaEvent(created));
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/agenda/:id
router.patch('/tenants/:slug/agenda/:id', requirePermiso('EDIT_AGENDA'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const eventId = Number(req.params.id);
        const existing = await prisma.agendaEvent.findFirst({ where: { id: eventId, tenantId: tenant.id } });
        if (!existing) return res.status(404).json({ error: 'Agenda event not found' });

        const patch = {};
        if (req.body.titulo !== undefined) patch.titulo = String(req.body.titulo).trim();
        if (req.body.descripcion !== undefined) patch.descripcion = req.body.descripcion || null;
        if (req.body.color !== undefined) patch.color = req.body.color || '#60A5FA';

        if (req.body.tipo !== undefined) {
            if (!AGENDA_TYPES.has(String(req.body.tipo))) return res.status(400).json({ error: 'Invalid tipo' });
            patch.tipo = String(req.body.tipo);
        }

        if (req.body.estado !== undefined) {
            if (!AGENDA_STATES.has(String(req.body.estado))) return res.status(400).json({ error: 'Invalid estado' });
            patch.estado = String(req.body.estado);
        }

        const nextStartAt = req.body.startAt !== undefined ? parseIsoDate(req.body.startAt) : existing.startAt;
        const nextEndAt = req.body.endAt !== undefined ? parseIsoDate(req.body.endAt) : existing.endAt;
        if (!nextStartAt || !nextEndAt || nextStartAt >= nextEndAt) {
            return res.status(400).json({ error: 'Invalid startAt/endAt interval' });
        }
        patch.startAt = nextStartAt;
        patch.endAt = nextEndAt;

        if (req.body.reminderMinutes !== undefined) {
            const value = req.body.reminderMinutes;
            if (value !== null && (!Number.isInteger(value) || value < 0)) {
                return res.status(400).json({ error: 'reminderMinutes must be null or a non-negative integer' });
            }
            patch.reminderMinutes = value;
        }

        if (req.body.flowId !== undefined) {
            if (req.body.flowId === null) {
                patch.flowId = null;
            } else {
                const flow = await prisma.flow.findFirst({ where: { id: Number(req.body.flowId), tenantId: tenant.id } });
                if (!flow) return res.status(400).json({ error: 'flowId does not exist for this tenant' });
                patch.flowId = Number(req.body.flowId);
            }
        }

        if (req.body.triggerWebhookOnStart !== undefined) {
            patch.triggerWebhookOnStart = Boolean(req.body.triggerWebhookOnStart);
        }
        if (req.body.webhookUrl !== undefined) patch.webhookUrl = req.body.webhookUrl || null;
        if (req.body.webhookMethod !== undefined) patch.webhookMethod = req.body.webhookMethod || null;
        if (req.body.webhookHeaders !== undefined) patch.webhookHeaders = req.body.webhookHeaders || undefined;
        if (req.body.webhookPayload !== undefined) patch.webhookPayload = req.body.webhookPayload || undefined;

        const updated = await prisma.$transaction(async (tx) => {
            const event = await tx.agendaEvent.update({
                where: { id: eventId },
                data: patch,
                include: { assignments: { include: { agente: true } } },
            });

            await tx.agendaEventLog.create({
                data: {
                    tenantId: tenant.id,
                    eventId: event.id,
                    adminUserId: req.admin?.adminUserId ?? null,
                    accion: 'UPDATE',
                    metadata: {
                        changedFields: Object.keys(patch),
                        moved: existing.startAt.getTime() !== event.startAt.getTime() || existing.endAt.getTime() !== event.endAt.getTime(),
                        previousEstado: existing.estado,
                        nextEstado: event.estado,
                    },
                },
            });

            return event;
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'UPDATE_AGENDA_EVENT',
            entidad: 'agenda_event',
            entidadId: String(updated.id),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { changedFields: Object.keys(patch) },
        });

        if (existing.estado !== 'en_progreso' && updated.estado === 'en_progreso') {
            runAgendaStartHooks({ tenantId: tenant.id, event: updated, actorAdminUserId: req.admin?.adminUserId }).catch(() => {});
        }

        socketService.emit(tenant.id, 'agenda:event_updated', serializeAgendaEvent(updated));
        res.json(serializeAgendaEvent(updated));
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/agenda/:id/assignments
router.post('/tenants/:slug/agenda/:id/assignments', requirePermiso('EDIT_AGENDA'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const eventId = Number(req.params.id);
        const event = await prisma.agendaEvent.findFirst({ where: { id: eventId, tenantId: tenant.id } });
        if (!event) return res.status(404).json({ error: 'Agenda event not found' });

        const agenteIds = Array.isArray(req.body.agenteIds)
            ? [...new Set(req.body.agenteIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
            : [];

        if (agenteIds.length > 0) {
            const agentes = await prisma.agente.findMany({
                where: { tenantId: tenant.id, id: { in: agenteIds } },
                select: { id: true },
            });
            if (agentes.length !== agenteIds.length) {
                return res.status(400).json({ error: 'One or more agenteIds are invalid for this tenant' });
            }
        }

        const updated = await prisma.$transaction(async (tx) => {
            await tx.agendaEventAssignment.deleteMany({ where: { eventId } });
            if (agenteIds.length > 0) {
                await tx.agendaEventAssignment.createMany({ data: agenteIds.map((agenteId) => ({ eventId, agenteId })) });
            }

            await tx.agendaEventLog.create({
                data: {
                    tenantId: tenant.id,
                    eventId,
                    adminUserId: req.admin?.adminUserId ?? null,
                    accion: 'ASSIGN',
                    metadata: { agenteIds },
                },
            });

            return tx.agendaEvent.findUnique({
                where: { id: eventId },
                include: { assignments: { include: { agente: true } } },
            });
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'ASSIGN_AGENDA_EVENT',
            entidad: 'agenda_event',
            entidadId: String(eventId),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { agenteIds },
        });

        socketService.emit(tenant.id, 'agenda:event_assignment_changed', serializeAgendaEvent(updated));
        res.json(serializeAgendaEvent(updated));
    } catch (err) {
        next(err);
    }
});

// DELETE /admin/tenants/:slug/agenda/:id
router.delete('/tenants/:slug/agenda/:id', requirePermiso('DELETE_AGENDA'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const eventId = Number(req.params.id);
        const event = await prisma.agendaEvent.findFirst({ where: { id: eventId, tenantId: tenant.id } });
        if (!event) return res.status(404).json({ error: 'Agenda event not found' });

        await prisma.$transaction(async (tx) => {
            await tx.agendaEventLog.create({
                data: {
                    tenantId: tenant.id,
                    eventId,
                    adminUserId: req.admin?.adminUserId ?? null,
                    accion: 'DELETE',
                    metadata: { titulo: event.titulo },
                },
            });
            await tx.agendaEvent.delete({ where: { id: eventId } });
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'DELETE_AGENDA_EVENT',
            entidad: 'agenda_event',
            entidadId: String(eventId),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { titulo: event.titulo },
        });

        socketService.emit(tenant.id, 'agenda:event_deleted', { id: eventId });
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/agenda/:id/logs
router.get('/tenants/:slug/agenda/:id/logs', requirePermiso('VIEW_AGENDA'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const eventId = Number(req.params.id);
        const logs = await prisma.agendaEventLog.findMany({
            where: { tenantId: tenant.id, eventId },
            include: { adminUser: { select: { id: true, nombre: true, email: true } } },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });

        res.json({ data: logs });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/agenda/:id/trigger-start
router.post('/tenants/:slug/agenda/:id/trigger-start', requirePermiso('EDIT_AGENDA'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const eventId = Number(req.params.id);
        const event = await prisma.agendaEvent.findFirst({ where: { id: eventId, tenantId: tenant.id } });
        if (!event) return res.status(404).json({ error: 'Agenda event not found' });

        await runAgendaStartHooks({ tenantId: tenant.id, event, actorAdminUserId: req.admin?.adminUserId });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/metrics
router.get('/tenants/:slug/metrics', requirePermiso('VIEW_METRICS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const metrics = await db.getMetrics(tenant.id);
        res.json(metrics);
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Configuraciones (flow engine & tenant settings)
// ---------------------------------------------------------------------------

// PUT /admin/tenants/:slug/config/:clave
router.put('/tenants/:slug/config/:clave', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        let { valor } = req.body;
        if (valor === undefined) return res.status(400).json({ error: 'valor is required' });

        if (req.params.clave === 'agenda_settings') {
            valor = normalizeAgendaSettings(valor);
        }

        // For llm_config: if api_key is the sentinel or absent, preserve the existing key from DB
        if (req.params.clave === 'llm_config' && typeof valor === 'object' && valor !== null) {
            const incoming = valor.api_key;
            if (!incoming || incoming === '__configured__') {
                const existing = await db.getConfig(tenant.id, 'llm_config');
                const existingKey = existing?.valor?.api_key;
                if (existingKey) {
                    valor = { ...valor, api_key: existingKey };
                } else {
                    // No existing key and none provided — remove the field entirely
                    const { api_key: _dropped, ...rest } = valor;
                    valor = rest;
                }
            }
        }

        const config = await db.setConfig(tenant.id, req.params.clave, valor);

        if (req.params.clave === 'agenda_settings') {
            await applyAgendaScheduleToTenantCalendars(tenant.id, config?.valor || valor);
        }

        if (req.params.clave === 'wa_app_secret') {
            const resolvedSecret = await db.getWaAppSecret(tenant.id);
            if (resolvedSecret) {
                persistEnvVariable('WA_APP_SECRET', resolvedSecret);
            }
        }

        // Return masked version
        if (req.params.clave === 'llm_config' && config?.valor?.api_key) {
            return res.json({ ...config, valor: { ...config.valor, api_key: '__configured__' } });
        }
        if (req.params.clave === 'wa_credentials' && config?.valor?.accessToken) {
            return res.json({ ...config, valor: { ...config.valor, accessToken: db.WA_TOKEN_SENTINEL } });
        }
        if (req.params.clave === 'wa_app_secret' && config?.valor) {
            return res.json({ ...config, valor: db.CONFIG_SECRET_SENTINEL });
        }
        if (req.params.clave === 'email_settings' && config?.valor?.smtpPass) {
            return res.json({ ...config, valor: { ...config.valor, smtpPass: db.CONFIG_SECRET_SENTINEL } });
        }
        res.json(config);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/config/:clave
router.get('/tenants/:slug/config/:clave', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const config = await db.getConfig(tenant.id, req.params.clave);
        if (!config) {
            return res.json({ tenantId: tenant.id, clave: req.params.clave, valor: null });
        }

        // Mask api_key for llm_config — never expose it to the client
        if (req.params.clave === 'llm_config' && config?.valor?.api_key) {
            return res.json({ ...config, valor: { ...config.valor, api_key: '__configured__' } });
        }
        if (req.params.clave === 'wa_credentials' && config?.valor?.accessToken) {
            return res.json({ ...config, valor: { ...config.valor, accessToken: db.WA_TOKEN_SENTINEL } });
        }
        if (req.params.clave === 'wa_app_secret' && config?.valor) {
            return res.json({ ...config, valor: db.CONFIG_SECRET_SENTINEL });
        }
        if (req.params.clave === 'email_settings' && config?.valor?.smtpPass) {
            return res.json({ ...config, valor: { ...config.valor, smtpPass: db.CONFIG_SECRET_SENTINEL } });
        }
        res.json(config);
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Account Lockout Policy
// ---------------------------------------------------------------------------

// GET /admin/tenants/:slug/lockout-policy
// Fetch current lockout policy for tenant
router.get('/tenants/:slug/lockout-policy', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const policy = await lockoutPolicy.getPolicy(tenant.id);
        res.json(policy);
    } catch (err) {
        next(err);
    }
});

// PUT /admin/tenants/:slug/lockout-policy
// Update lockout policy for tenant
router.put('/tenants/:slug/lockout-policy', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const { maxAttempts, lockoutMinutes } = req.body;
        if (maxAttempts === undefined || lockoutMinutes === undefined) {
            return res.status(400).json({ error: 'maxAttempts and lockoutMinutes are required' });
        }

        const policy = await lockoutPolicy.updatePolicy(tenant.id, { maxAttempts, lockoutMinutes });
        
        // Audit
        audit({
            adminUserId: req.user?.adminUserId,
            tenantId: tenant.id,
            accion: 'UPDATE_LOCKOUT_POLICY',
            entidad: 'lockout_policy',
            metadata: { maxAttempts: policy.maxAttempts, lockoutMinutes: policy.lockoutMinutes },
        });

        res.json(policy);
    } catch (err) {
        next(err);
    }
});

// DELETE /admin/tenants/:slug/lockout-policy
// Reset policy to defaults
router.delete('/tenants/:slug/lockout-policy', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const policy = await lockoutPolicy.resetPolicy(tenant.id);
        
        // Audit
        audit({
            adminUserId: req.user?.adminUserId,
            tenantId: tenant.id,
            accion: 'RESET_LOCKOUT_POLICY',
            entidad: 'lockout_policy',
            metadata: { resettedTo: policy },
        });

        res.json({ message: 'Policy reset to defaults', policy });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Flow Keys (Meta WhatsApp Flows encryption)
// ---------------------------------------------------------------------------

const flowKeysService = require('../services/flowKeysService');

// GET /admin/tenants/:slug/flow-keys
// Get current Flow key registration status
router.get('/tenants/:slug/flow-keys', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const publicKey = await db.getConfig(tenant.id, 'flow_endpoint_public_key');
        const registrationStatus = await db.getConfig(tenant.id, 'flow_endpoint_registration_status');

        return res.json({
            hasPublicKey: Boolean(publicKey?.valor?.publicKey),
            registrationStatus: registrationStatus?.valor?.status || 'none',
            lastRegistered: registrationStatus?.valor?.lastRegisteredAt || null,
        });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/flow-keys/generate
// Generate new RSA-2048 key pair and store in database
router.post('/tenants/:slug/flow-keys/generate', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const { publicKey, privateKey } = flowKeysService.generateFlowKeyPair();

        await db.setConfig(tenant.id, 'flow_endpoint_public_key', {
            publicKey,
            generatedAt: new Date().toISOString(),
        });

        await db.setConfig(tenant.id, 'flow_endpoint_private_key', {
            privateKey,
            generatedAt: new Date().toISOString(),
        });

        // Clear registration status since we have new keys
        await db.setConfig(tenant.id, 'flow_endpoint_registration_status', {
            status: 'pending_registration',
            generatedAt: new Date().toISOString(),
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'GENERATE_FLOW_KEYS',
            entidad: 'flow_keys',
            entidadId: tenant.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { action: 'generated_new_keypair' },
        });

        return res.json({
            ok: true,
            message: 'Flow keys generated successfully',
            publicKey: publicKey.substring(0, 50) + '...', // Return partial key for security
            status: 'pending_registration',
        });
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/flow-keys/register
// Register Flow public key with Meta's Graph API
router.post('/tenants/:slug/flow-keys/register', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        // Get WhatsApp credentials for this tenant
        const { phoneNumberId, accessToken } = await db.getWaCredentials(tenant.id);
        if (!phoneNumberId || !accessToken) {
            return res.status(422).json({
                error: 'WhatsApp credentials not configured for this tenant',
                details: 'Cannot register Flow keys without WhatsApp phone number ID and access token',
            });
        }

        // Get the Flow public key from config
        const publicKeyConfig = await db.getConfig(tenant.id, 'flow_endpoint_public_key');
        if (!publicKeyConfig?.valor?.publicKey) {
            return res.status(400).json({
                error: 'No Flow public key found for this tenant',
                details: 'Please generate a new key pair first via POST /flow-keys/generate',
            });
        }

        const publicKey = publicKeyConfig.valor.publicKey;

        // Register with Meta
        const result = await flowKeysService.registerFlowPublicKey(
            phoneNumberId,
            publicKey,
            accessToken,
        );

        if (!result.ok) {
            audit({
                adminUserId: req.admin?.adminUserId,
                tenantId: tenant.id,
                accion: 'REGISTER_FLOW_KEYS_FAILED',
                entidad: 'flow_keys',
                entidadId: tenant.id,
                ip: req.ip,
                userAgent: req.headers['user-agent'],
                metadata: { error: result.error },
            });

            return res.status(400).json({
                ok: false,
                error: result.error,
                details: result.meta,
            });
        }

        // Update registration status in config
        await db.setConfig(tenant.id, 'flow_endpoint_registration_status', {
            status: 'registered',
            lastRegisteredAt: new Date().toISOString(),
            metaResponse: result.meta,
        });

        audit({
            adminUserId: req.admin?.adminUserId,
            tenantId: tenant.id,
            accion: 'REGISTER_FLOW_KEYS_SUCCESS',
            entidad: 'flow_keys',
            entidadId: tenant.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            metadata: { phoneNumberId, status: result.meta?.business_public_key_signature_status },
        });

        socketService.emit(tenant.id, 'FLOW_KEYS_REGISTERED', {
            status: 'registered',
            phoneNumberId,
            signatureStatus: result.meta?.business_public_key_signature_status,
        });

        return res.json({
            ok: true,
            message: 'Flow public key registered with Meta successfully',
            status: 'registered',
            phoneNumberId,
            signatureStatus: result.meta?.business_public_key_signature_status,
        });
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/flow-keys/status
// Query current registration status from Meta
router.get('/tenants/:slug/flow-keys/status', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;

        const { phoneNumberId, accessToken } = await db.getWaCredentials(tenant.id);
        if (!phoneNumberId || !accessToken) {
            return res.status(422).json({
                error: 'WhatsApp credentials not configured',
            });
        }

        const result = await flowKeysService.getFlowPublicKeyStatus(phoneNumberId, accessToken);

        if (!result.ok) {
            return res.status(400).json({
                ok: false,
                error: result.error,
            });
        }

        return res.json({
            ok: true,
            status: result.status,
            phoneNumberId,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
