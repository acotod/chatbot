const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const db = require('../services/database');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const { audit } = require('../services/audit');
const socketService = require('../services/socketService');

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
        res.status(201).json(tenant);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants — list tenants (superAdmin: all; TenantAdmin: own only)
router.get('/tenants', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
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

// ---------------------------------------------------------------------------
// Agentes (per-tenant, admin-managed)
// ---------------------------------------------------------------------------

// GET /admin/tenants/:slug/agentes
router.get('/tenants/:slug/agentes', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const agentes = await db.listAgentes(tenant.id);
        res.json(agentes);
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/agentes
router.post('/tenants/:slug/agentes', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const { nombre, email } = req.body;
        if (!nombre || !email) {
            return res.status(400).json({ error: 'nombre and email are required' });
        }
        const agente = await db.createAgente({ tenantId: tenant.id, nombre, email });
        res.status(201).json(agente);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/agentes/:id/estado
router.patch('/tenants/:slug/agentes/:id/estado', async (req, res, next) => {
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

// ---------------------------------------------------------------------------
// Solicitudes (per-tenant)
// ---------------------------------------------------------------------------

// GET /admin/tenants/:slug/solicitudes?estado=pendiente&page=1&limit=20
router.get('/tenants/:slug/solicitudes', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const { estado, page, limit } = req.query;
        const solicitudes = await db.listSolicitudes(tenant.id, {
            estado: estado || undefined,
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 20,
        });
        res.json(solicitudes);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/solicitudes/:id/estado
router.patch('/tenants/:slug/solicitudes/:id/estado', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const { estado } = req.body;
        if (!estado) return res.status(400).json({ error: 'estado is required' });
        const result = await db.updateSolicitudEstado(Number(req.params.id), tenant.id, estado);
        // Audit + real-time
        audit({ adminUserId: req.admin?.adminUserId, tenantId: tenant.id, accion: 'UPDATE_SOLICITUD_ESTADO', entidad: 'solicitud', entidadId: req.params.id, ip: req.ip, userAgent: req.headers['user-agent'], metadata: { estado } });
        socketService.emit(tenant.id, 'STATUS_UPDATED', { solicitudId: Number(req.params.id), estado });
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/solicitudes/:id/agente
router.patch('/tenants/:slug/solicitudes/:id/agente', async (req, res, next) => {
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
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

// GET /admin/tenants/:slug/metrics
router.get('/tenants/:slug/metrics', async (req, res, next) => {
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
router.put('/tenants/:slug/config/:clave', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const { valor } = req.body;
        if (valor === undefined) return res.status(400).json({ error: 'valor is required' });
        const config = await db.setConfig(tenant.id, req.params.clave, valor);
        res.json(config);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/config/:clave
router.get('/tenants/:slug/config/:clave', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        if (denyIfWrongTenant(req, res, tenant.id)) return;
        const config = await db.getConfig(tenant.id, req.params.clave);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        res.json(config);
    } catch (err) {
        next(err);
    }
});

module.exports = router;


// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

// POST /admin/tenants — create a new tenant
router.post('/tenants', async (req, res, next) => {
    try {
        const { nombre, slug, plan } = req.body;
        if (!nombre || !slug) {
            return res.status(400).json({ error: 'nombre and slug are required' });
        }
        const apiKey = crypto.randomBytes(32).toString('hex');
        const tenant = await db.createTenant({ nombre, slug, apiKey, plan });
        res.status(201).json(tenant);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants — list all tenants
router.get('/tenants', async (req, res, next) => {
    try {
        const tenants = await db.listTenants();
        res.json(tenants);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/deactivate
router.patch('/tenants/:slug/deactivate', async (req, res, next) => {
    try {
        const tenant = await db.setTenantActive(req.params.slug, false);
        res.json(tenant);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/activate
router.patch('/tenants/:slug/activate', async (req, res, next) => {
    try {
        const tenant = await db.setTenantActive(req.params.slug, true);
        res.json(tenant);
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Agentes (per-tenant, admin-managed)
// ---------------------------------------------------------------------------

// GET /admin/tenants/:slug/agentes
router.get('/tenants/:slug/agentes', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const agentes = await db.listAgentes(tenant.id);
        res.json(agentes);
    } catch (err) {
        next(err);
    }
});

// POST /admin/tenants/:slug/agentes
router.post('/tenants/:slug/agentes', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const { nombre, email } = req.body;
        if (!nombre || !email) {
            return res.status(400).json({ error: 'nombre and email are required' });
        }
        const agente = await db.createAgente({ tenantId: tenant.id, nombre, email });
        res.status(201).json(agente);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/agentes/:id/estado
router.patch('/tenants/:slug/agentes/:id/estado', async (req, res, next) => {
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

// ---------------------------------------------------------------------------
// Configuraciones (flow engine & tenant settings)
// ---------------------------------------------------------------------------

// PUT /admin/tenants/:slug/config/:clave
router.put('/tenants/:slug/config/:clave', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const { valor } = req.body;
        if (valor === undefined) return res.status(400).json({ error: 'valor is required' });
        const config = await db.setConfig(tenant.id, req.params.clave, valor);
        res.json(config);
    } catch (err) {
        next(err);
    }
});

// GET /admin/tenants/:slug/config/:clave
router.get('/tenants/:slug/config/:clave', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        const config = await db.getConfig(tenant.id, req.params.clave);
        if (!config) return res.status(404).json({ error: 'Config not found' });
        res.json(config);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
