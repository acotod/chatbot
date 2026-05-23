'use strict';
/**
 * Integration Manager API
 *
 * GET    /integrations                  — list all integrations for tenant
 * GET    /integrations/:id              — get single integration
 * POST   /integrations                  — create integration
 * PUT    /integrations/:id              — update integration
 * DELETE /integrations/:id              — delete integration
 * POST   /integrations/:id/test         — test live HTTP connectivity
 * GET    /integrations/catalog/endpoints — get endpoint catalog for tenant
 * PUT    /integrations/catalog/endpoints — save endpoint catalog for tenant
 *
 * All routes require JWT. tenantId from req.user.
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');
const { getCatalog, saveCatalog } = require('../services/endpointCatalog');

const router = express.Router();
const prisma = new PrismaClient();

router.use(requireJwt);

function tid(req) {
  return req.admin?.tenantId ?? req.user?.tenantId ?? req.user?.tenant_id;
}

async function resolveTenantId(req, explicitTenantSlug) {
  if (!req.admin?.superAdmin) {
    return tid(req) ?? null;
  }
  if (req.admin?.tenantId) return req.admin.tenantId;
  if (explicitTenantSlug) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: explicitTenantSlug },
      select: { id: true },
    });
    return tenant?.id ?? null;
  }
  return null;
}

async function requireTenantId(req, res) {
  const tenantSlug = req.query?.tenantSlug || req.body?.tenantSlug;
  const tenantId = await resolveTenantId(req, tenantSlug);
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId is required — pass ?tenantSlug= or use a tenant-scoped account' });
    return null;
  }
  return tenantId;
}

// GET /integrations
router.get('/', async (req, res, next) => {
  try {
    const tenantId = await requireTenantId(req, res);
    if (!tenantId) return;
    const { tipo, activo } = req.query;
    const where = { tenantId };
    if (tipo) where.tipo = tipo;
    if (activo !== undefined) where.activo = activo === 'true';

    const integrations = await prisma.integration.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
    res.json(integrations);
  } catch (err) {
    next(err);
  }
});

// GET /integrations/:id
router.get('/:id', async (req, res, next) => {
  try {
    const tenantId = await requireTenantId(req, res);
    if (!tenantId) return;
    const integration = await prisma.integration.findFirst({
      where: { id: Number(req.params.id), tenantId },
    });
    if (!integration) return res.status(404).json({ error: 'Integration not found' });
    res.json(integration);
  } catch (err) {
    next(err);
  }
});

// POST /integrations
router.post('/', async (req, res, next) => {
  try {
    const tenantId = await requireTenantId(req, res);
    if (!tenantId) return;
    const { nombre, tipo, config, activo = true } = req.body;

    if (!nombre || nombre.trim() === '')
      return res.status(400).json({ error: 'nombre is required' });
    if (!tipo) return res.status(400).json({ error: 'tipo is required' });
    if (!config || typeof config !== 'object')
      return res.status(400).json({ error: 'config must be a JSON object' });

    // Validate required config fields based on tipo
    if ((tipo === 'webhook' || tipo === 'rest_api') && !config.endpoint) {
      return res.status(400).json({ error: 'config.endpoint is required for webhook/rest_api integrations' });
    }

    const integration = await prisma.integration.create({
      data: {
        tenantId,
        nombre: nombre.trim(),
        tipo,
        config,
        activo: Boolean(activo),
      },
    });
    res.status(201).json(integration);
  } catch (err) {
    next(err);
  }
});

// PUT /integrations/:id
router.put('/:id', async (req, res, next) => {
  try {
    const tenantId = await requireTenantId(req, res);
    if (!tenantId) return;
    const existing = await prisma.integration.findFirst({
      where: { id: Number(req.params.id), tenantId },
    });
    if (!existing) return res.status(404).json({ error: 'Integration not found' });

    const { nombre, tipo, config, activo } = req.body;
    const patch = {};
    if (nombre !== undefined) patch.nombre = nombre.trim();
    if (tipo !== undefined) patch.tipo = tipo;
    if (config !== undefined) patch.config = config;
    if (activo !== undefined) patch.activo = Boolean(activo);

    const updated = await prisma.integration.update({
      where: { id: Number(req.params.id) },
      data: patch,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /integrations/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const tenantId = await requireTenantId(req, res);
    if (!tenantId) return;
    const existing = await prisma.integration.findFirst({
      where: { id: Number(req.params.id), tenantId },
    });
    if (!existing) return res.status(404).json({ error: 'Integration not found' });
    await prisma.integration.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /integrations/:id/test  — live HTTP connectivity check
router.post('/:id/test', async (req, res, next) => {
  try {
    const tenantId = await requireTenantId(req, res);
    if (!tenantId) return;
    const integration = await prisma.integration.findFirst({
      where: { id: Number(req.params.id), tenantId },
    });
    if (!integration) return res.status(404).json({ error: 'Integration not found' });

    const { endpoint, method = 'GET', headers = {} } = integration.config;
    if (!endpoint) {
      return res.status(400).json({ error: 'Integration has no endpoint configured' });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const fetchRes = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const bodyText = await fetchRes.text();
      res.json({
        ok: fetchRes.ok,
        status: fetchRes.status,
        body: bodyText.substring(0, 1000),
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      res.json({ ok: false, error: fetchErr.message });
    }
  } catch (err) {
    next(err);
  }
});

// GET /integrations/catalog/endpoints — get endpoint catalog for tenant
router.get('/catalog/endpoints', async (req, res, next) => {
  try {
    const tenantId = await requireTenantId(req, res);
    if (!tenantId) return;
    const catalog = await getCatalog(tenantId);
    res.json({ data: catalog });
  } catch (err) {
    next(err);
  }
});

// PUT /integrations/catalog/endpoints — upsert endpoint catalog for tenant
router.put('/catalog/endpoints', async (req, res, next) => {
  try {
    const tenantId = await requireTenantId(req, res);
    if (!tenantId) return;
    const { endpoints } = req.body;
    if (!Array.isArray(endpoints)) {
      return res.status(400).json({ error: '"endpoints" must be an array' });
    }
    await saveCatalog(tenantId, { endpoints });
    res.json({ ok: true, data: { endpoints } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
