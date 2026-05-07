const express = require('express');
const crypto = require('crypto');
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

function parseCalendarSelection(value) {
    if (value === undefined) return { provided: false, clear: false, calendarId: null };
    if (value === null) return { provided: true, clear: true, calendarId: null };
    const raw = String(value).trim();
    if (!raw) return { provided: true, clear: true, calendarId: null };
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(raw);
    if (!isUuid) return { error: 'calendarId must be a UUID' };
    return { provided: true, clear: false, calendarId: raw };
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
        assignments: (event.assignments || []).map((a) => ({
            agenteId: a.agenteId,
            nombre: a.agente?.nombre ?? null,
            email: a.agente?.email ?? null,
            estado: a.agente?.estado ?? null,
        })),
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

    const creds = await db.getConfig(tenantId, 'wa_credentials');
    const phoneNumberId = creds?.valor?.phoneNumberId;
    const accessToken = creds?.valor?.accessToken;
    if (!phoneNumberId || !accessToken) return;

    if (content.type === 'text' || content.type === 'end' || content.type === 'handoff') {
        const text = String(content.text || '').trim();
        if (text) await wa.sendTextMessage(phoneNumberId, userPhone, text, accessToken);
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
        const updated = await prisma.tenant.update({
            where: { id: tenant.id },
            data: { apiKey: newApiKey },
        });
        audit({ adminUserId: req.admin.adminUserId, tenantId: tenant.id, accion: 'ROTATE_API_KEY', entidad: 'tenant', entidadId: tenant.id, ip: req.ip, userAgent: req.headers['user-agent'] });
        res.json({ id: updated.id, slug: updated.slug, apiKey: updated.apiKey });
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

// POST /admin/tenants/:slug/agentes
router.post('/tenants/:slug/agentes', requirePermiso('EDIT_AGENTES'), async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
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

        if (!nombre || !email || !whatsapp || !Number.isInteger(puestoId) || puestoId <= 0) {
            return res.status(400).json({ error: 'nombre, email, whatsapp and puestoId are required' });
        }

        const puesto = await prisma.agentePuesto.findFirst({ where: { id: puestoId, tenantId: tenant.id, activo: true } });
        if (!puesto) {
            return res.status(400).json({ error: 'puestoId is invalid for this tenant' });
        }

        const agente = await db.createAgente({
            tenantId: tenant.id,
            nombre,
            email,
            whatsapp,
            puestoId,
            calendarLink: calendarLinkValidation.value,
        });

        const assignedCalendarId = await assignCalendarToAgente({
            tenantId: tenant.id,
            agenteId: agente.id,
            calendarId: calendarSelection.calendarId,
        });

        res.status(201).json({ ...agente, assignedCalendarId });
    } catch (err) {
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

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'invalid agente id' });
        }
        if (!nombre || !email || !whatsapp || !Number.isInteger(puestoId) || puestoId <= 0) {
            return res.status(400).json({ error: 'nombre, email, whatsapp and puestoId are required' });
        }

        const puesto = await prisma.agentePuesto.findFirst({ where: { id: puestoId, tenantId: tenant.id, activo: true } });
        if (!puesto) {
            return res.status(400).json({ error: 'puestoId is invalid for this tenant' });
        }

        const result = await db.updateAgente({
            id,
            tenantId: tenant.id,
            nombre,
            email,
            whatsapp,
            puestoId,
            calendarLink: calendarLinkValidation.value,
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
        const { userId, nombre, telefonoContacto, horario, estado, flowId, conversationId, origin, titulo, prioridad, flowNodeRef } = req.body;
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
        const { estado, page, limit, userId } = req.query;
        const normalizedEstado = estado ? db.normalizeSolicitudStatus(estado, '') : '';
        const currentPage = page ? Number(page) : 1;
        const currentLimit = limit ? Number(limit) : 20;
        const normalizedUserId = userId !== undefined ? Number(userId) : undefined;

        const solicitudes = await db.listSolicitudes(tenant.id, {
            estado: normalizedEstado || undefined,
            userId: normalizedUserId,
            page: currentPage,
            limit: currentLimit,
        });

        const enriched = solicitudes.map((item) => ({
            ...item,
            slaStatus: db.calculateSlaStatus(item, { warningThresholdMinutes: tenantConfig.warningThresholdMinutes }),
        }));

        const where = {
            tenantId: tenant.id,
            ...(normalizedEstado ? { estado: normalizedEstado } : {}),
            ...(normalizedUserId !== undefined ? { userId: normalizedUserId } : {}),
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
            channelSource,
            tags,
            from,
            to,
            page,
            limit,
            slaStatus,
        } = req.query;

        const result = await db.searchSolicitudes(tenant.id, {
            q,
            estado,
            agenteId,
            prioridad,
            channelSource,
            tags,
            from,
            to,
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
router.get('/tenants/:slug/solicitudes/webhooks', requirePermiso('VIEW_SOLICITUDES'), async (req, res, next) => {
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
router.post('/tenants/:slug/solicitudes/webhooks', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
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
router.patch('/tenants/:slug/solicitudes/webhooks/:id', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
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
router.delete('/tenants/:slug/solicitudes/webhooks/:id', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
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
router.get('/tenants/:slug/solicitudes/webhooks/deliveries', requirePermiso('VIEW_METRICS'), async (req, res, next) => {
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
router.post('/tenants/:slug/solicitudes/webhooks/test', requirePermiso('EDIT_SOLICITUDES'), async (req, res, next) => {
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
        res.json(result);
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

        const reason = req.body?.reason ? String(req.body.reason) : null;
        const escalated = await db.escalateSolicitud({
            id: Number(req.params.id),
            tenantId: tenant.id,
            actorUserId: req.admin?.adminUserId ?? null,
            reason,
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
            metadata: { reason, escalationLevel: escalated.escalationLevel },
        });

        socketService.emit(tenant.id, 'SOLICITUD_ESCALATED', {
            solicitudId: Number(req.params.id),
            escalationLevel: escalated.escalationLevel,
            reason,
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
            'tags',
            'followUpDate',
            'resolutionNotes',
            'customerNotes',
        ];
        const updates = {};
        for (const key of allowedFields) {
            if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
                updates[key] = req.body[key];
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

        const events = await prisma.agendaEvent.findMany({
            where,
            include: {
                assignments: { include: { agente: true } },
            },
            orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        });

        res.json({ data: events.map(serializeAgendaEvent) });
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

        // Return masked version
        if (req.params.clave === 'llm_config' && config?.valor?.api_key) {
            return res.json({ ...config, valor: { ...config.valor, api_key: '__configured__' } });
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
        if (!config) return res.status(404).json({ error: 'Config not found' });

        // Mask api_key for llm_config — never expose it to the client
        if (req.params.clave === 'llm_config' && config?.valor?.api_key) {
            return res.json({ ...config, valor: { ...config.valor, api_key: '__configured__' } });
        }
        res.json(config);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
