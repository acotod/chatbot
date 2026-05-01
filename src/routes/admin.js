const express = require('express');
const crypto = require('crypto');
const db = require('../services/database');
const requireJwt = require('../middleware/requireJwt');

const router = express.Router();

// All admin routes require a valid JWT (issued by POST /auth/login)
router.use(requireJwt);

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
// Solicitudes (per-tenant)
// ---------------------------------------------------------------------------

// GET /admin/tenants/:slug/solicitudes?estado=pendiente&page=1&limit=20
router.get('/tenants/:slug/solicitudes', async (req, res, next) => {
    try {
        const tenant = await db.findTenantBySlug(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
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
        const { estado } = req.body;
        if (!estado) return res.status(400).json({ error: 'estado is required' });
        const result = await db.updateSolicitudEstado(Number(req.params.id), tenant.id, estado);
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
        const { agenteId } = req.body;
        if (!agenteId) return res.status(400).json({ error: 'agenteId is required' });
        const result = await db.assignAgenteToSolicitud(Number(req.params.id), tenant.id, Number(agenteId));
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


// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

// POST /admin/tenants — create a new tenant
router.post('/tenants', requireAdminKey, async (req, res, next) => {
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
router.get('/tenants', requireAdminKey, async (req, res, next) => {
    try {
        const tenants = await db.listTenants();
        res.json(tenants);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/deactivate
router.patch('/tenants/:slug/deactivate', requireAdminKey, async (req, res, next) => {
    try {
        const tenant = await db.setTenantActive(req.params.slug, false);
        res.json(tenant);
    } catch (err) {
        next(err);
    }
});

// PATCH /admin/tenants/:slug/activate
router.patch('/tenants/:slug/activate', requireAdminKey, async (req, res, next) => {
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
router.get('/tenants/:slug/agentes', requireAdminKey, async (req, res, next) => {
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
router.post('/tenants/:slug/agentes', requireAdminKey, async (req, res, next) => {
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
router.patch('/tenants/:slug/agentes/:id/estado', requireAdminKey, async (req, res, next) => {
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
router.put('/tenants/:slug/config/:clave', requireAdminKey, async (req, res, next) => {
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
router.get('/tenants/:slug/config/:clave', requireAdminKey, async (req, res, next) => {
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
