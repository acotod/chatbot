'use strict';
/**
 * WABA Flow Integration Module — REST API
 *
 * All routes are JWT-protected. tenantId from req.admin.
 *
 * GET    /waba-flows                          — list flows (+ latest version info)
 * POST   /waba-flows                          — create new flow with initial definition
 * GET    /waba-flows/:id                      — get flow details with versions
 * PUT    /waba-flows/:id                      — update name / metaJson
 * DELETE /waba-flows/:id                      — soft-delete (activo=false)
 *
 * POST   /waba-flows/import                   — import from WABA JSON (creates flow + version)
 * GET    /waba-flows/:id/export               — export latest published version to WABA JSON
 *
 * POST   /waba-flows/:id/validate             — validate definition (internal rules + WABA compat)
 * POST   /waba-flows/:id/simulate             — dry-run simulation with mock inputs
 *
 * GET    /waba-flows/:id/versions             — list versions
 * POST   /waba-flows/:id/versions             — save new version snapshot
 * PUT    /waba-flows/:id/versions/:vId/publish — publish/unpublish version
 * POST   /waba-flows/:id/versions/:vId/rollback — make version the active published one
 *
 * GET    /waba-flows/import-logs              — audit trail of all imports
 */

const express    = require('express');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');
const {
  validateInternalDefinition,
  validateWabaJson,
  importFromWaba,
  exportToWaba,
  enrichDefinition,
  simulateFlow,
} = require('../services/wabaFlowService');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

router.use(requireJwt);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function tid(req) { return req.admin?.tenantId ?? req.user?.tenantId ?? req.user?.tenant_id; }
function uid(req) { return req.admin?.adminUserId ?? req.user?.adminUserId ?? req.user?.id; }
function notFound(res, entity = 'Flow') { return res.status(404).json({ error: `${entity} not found` }); }

async function resolveTenantId(req, explicitTenantSlug) {
  if (!req.admin?.superAdmin) {
    return tid(req) ?? null;
  }

  if (req.admin?.tenantId) {
    return req.admin.tenantId;
  }

  if (explicitTenantSlug) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: explicitTenantSlug },
      select: { id: true },
    });
    return tenant?.id ?? null;
  }

  return null;
}

async function _getIntegrationMap(tenantId) {
  const integrations = await prisma.integration.findMany({
    where: { tenantId, activo: true },
  });
  return new Map(integrations.map((i) => [i.nombre, i]));
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST flows
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const tenantId = await resolveTenantId(req, req.query.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug is required for WABA flows' });
    const { activo, page = 1, limit = 20 } = req.query;
    const where = { tenantId };
    if (activo !== undefined) where.activo = activo === 'true';

    const [total, flows] = await Promise.all([
      prisma.flow.count({ where }),
      prisma.flow.findMany({
        where,
        include: {
          flowVersions: {
            orderBy: { versionNumber: 'desc' },
            take: 1,
            select: {
              id: true,
              versionNumber: true,
              published: true,
              publishedAt: true,
              changelog: true,
              wabaValidationStatus: true,
              wabaValidatedAt: true,
              createdAt: true,
            },
          },
          _count: { select: { flowVersions: true, executions: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
    ]);

    res.json({ total, page: Number(page), limit: Number(limit), flows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Import logs (before /:id to avoid route collision)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/import-logs', async (req, res, next) => {
  try {
    const tenantId = await resolveTenantId(req, req.query.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug is required for WABA import logs' });
    const { page = 1, limit = 30 } = req.query;
    const logs = await prisma.wabaImportLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
    });
    res.json(logs);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CREATE flow
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const tenantId = await resolveTenantId(req, req.body?.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug is required for WABA flows' });
    const adminUserId = uid(req);
    const { nombre, definition, changelog } = req.body;

    if (!nombre?.trim()) return res.status(400).json({ error: 'nombre is required' });

    let parsedDef = definition;
    if (!parsedDef || !Array.isArray(parsedDef.nodes)) {
      // Create minimal empty definition
      parsedDef = {
        version: '7.1',
        entry_point: 'node_1',
        nodes: [{ id: 'node_1', type: 'message', config: { text: 'Hola, ¿en qué puedo ayudarte?' }, next: null, branches: {} }],
        variables: {},
        integrations: {},
        metadata: { flow_name: nombre },
      };
    }

    const validation = validateInternalDefinition(parsedDef);

    const flow = await prisma.flow.create({
      data: {
        tenantId,
        nombre: nombre.trim(),
        version: 1,
        activo: true,
        metaJson: exportToWaba(parsedDef),
        flowVersions: {
          create: {
            tenantId,
            versionNumber: 1,
            definition: parsedDef,
            changelog: changelog ?? 'Versión inicial',
            published: false,
            createdByAdminUserId: adminUserId,
            wabaValidationStatus: validation.valid ? 'valid' : 'invalid',
            wabaValidatedAt: new Date(),
            wabaValidationErrors: validation.errors.length ? validation.errors : null,
          },
        },
      },
      include: { flowVersions: true },
    });

    res.status(201).json(flow);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT from WABA JSON
// ─────────────────────────────────────────────────────────────────────────────
router.post('/import', async (req, res, next) => {
  try {
    const tenantId = await resolveTenantId(req, req.body?.tenantSlug);
    const adminUserId = uid(req);
    const { wabaJson, nombre, changelog } = req.body;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantSlug is required for WABA import' });
    }

    if (!wabaJson || typeof wabaJson !== 'object') {
      return res.status(400).json({ error: 'wabaJson must be a non-null object' });
    }

    // Validate WABA JSON structure first
    const wabaValidation = validateWabaJson(wabaJson);

    if (!wabaValidation.valid) {
      return res.status(400).json({
        error: 'Invalid WABA JSON',
        validation: wabaValidation,
      });
    }

    // Convert to internal definition
    const { definition, nodeCount, warnings } = importFromWaba(wabaJson, nombre);

    // Validate internal definition
    const internalValidation = validateInternalDefinition(definition);

    const flowName = nombre?.trim() || definition.metadata?.flow_name || 'Imported Flow';
    const wabaStatus = internalValidation.valid ? 'valid' : 'invalid';

    // Create flow + version + import log in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const flow = await tx.flow.create({
        data: {
          tenantId,
          nombre: flowName,
          version: 1,
          activo: true,
          metaJson: wabaJson,
        },
      });

      const version = await tx.flowVersion.create({
        data: {
          tenantId,
          flowId: flow.id,
          versionNumber: 1,
          definition,
          changelog: changelog ?? `Importado desde WABA JSON (${nodeCount} nodos)`,
          published: false,
          createdByAdminUserId: adminUserId,
          wabaValidationStatus: wabaStatus,
          wabaValidatedAt: new Date(),
          wabaValidationErrors: internalValidation.errors.length ? internalValidation.errors : null,
        },
      });

      const importLog = await tx.wabaImportLog.create({
        data: {
          tenantId,
          flowId: flow.id,
          adminUserId,
          source: 'manual',
          originalJson: wabaJson,
          parsedNodes: nodeCount,
          validationErrors: wabaValidation.errors.length ? wabaValidation.errors : null,
          status: internalValidation.valid ? 'validated' : 'failed',
        },
      });

      return { flow, version, importLog };
    });

    logger.info({ tenantId, flowId: result.flow.id, nodeCount }, 'waba-flows: flow imported');

    res.status(201).json({
      flow: result.flow,
      version: result.version,
      importLog: result.importLog,
      wabaValidation,
      internalValidation,
      warnings,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET flow details
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);

    const flow = await prisma.flow.findFirst({
      where: { id, tenantId },
      include: {
        flowVersions: {
          orderBy: { versionNumber: 'desc' },
          select: {
            id: true, versionNumber: true, published: true, publishedAt: true,
            changelog: true, wabaValidationStatus: true, wabaValidatedAt: true,
            wabaValidationErrors: true, createdAt: true, createdByAdminUserId: true,
          },
        },
        variables: true,
        _count: { select: { executions: true, flowVersions: true } },
      },
    });

    if (!flow) return notFound(res);
    res.json(flow);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET single version definition
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/versions/:vId', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const flowId   = Number(req.params.id);
    const vId      = Number(req.params.vId);

    const version = await prisma.flowVersion.findFirst({
      where: { id: vId, flowId, tenantId },
    });
    if (!version) return notFound(res, 'Version');
    res.json(version);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE flow (rename / toggle activo)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);
    const { nombre, activo } = req.body;

    const existing = await prisma.flow.findFirst({ where: { id, tenantId } });
    if (!existing) return notFound(res);

    const updated = await prisma.flow.update({
      where: { id },
      data: {
        ...(nombre !== undefined && { nombre: nombre.trim() }),
        ...(activo !== undefined && { activo: Boolean(activo) }),
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE flow (soft delete)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);

    const existing = await prisma.flow.findFirst({ where: { id, tenantId } });
    if (!existing) return notFound(res);

    await prisma.flow.update({ where: { id }, data: { activo: false } });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT to WABA JSON
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/export', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);
    const { versionId } = req.query;

    let version;
    if (versionId) {
      version = await prisma.flowVersion.findFirst({
        where: { id: Number(versionId), flowId: id, tenantId },
      });
    } else {
      version = await prisma.flowVersion.findFirst({
        where: { flowId: id, tenantId, published: true },
        orderBy: { versionNumber: 'desc' },
      }) ?? await prisma.flowVersion.findFirst({
        where: { flowId: id, tenantId },
        orderBy: { versionNumber: 'desc' },
      });
    }

    if (!version) return notFound(res, 'Version');

    // Enrich with integrations before export
    const intMap = await _getIntegrationMap(tenantId);
    const enriched = enrichDefinition(version.definition, intMap);
    const wabaJson = exportToWaba(enriched);

    // Optionally stream as downloadable file
    if (req.query.download === 'true') {
      const flow = await prisma.flow.findUnique({ where: { id }, select: { nombre: true } });
      const filename = `${(flow?.nombre ?? 'flow').replace(/\s+/g, '_')}_v${version.versionNumber}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json');
    }

    res.json(wabaJson);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATE flow definition
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/validate', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);
    const { versionId, definition: bodyDef } = req.body;

    let definition = bodyDef;

    if (!definition) {
      const whereVersion = versionId
        ? { id: Number(versionId), flowId: id, tenantId }
        : undefined;
      const version = whereVersion
        ? await prisma.flowVersion.findFirst({ where: whereVersion })
        : await prisma.flowVersion.findFirst({
            where: { flowId: id, tenantId },
            orderBy: { versionNumber: 'desc' },
          });
      if (!version) return notFound(res, 'Version');
      definition = version.definition;

      // Persist validation result
      const internalResult = validateInternalDefinition(definition);
      const wabaJson = exportToWaba(definition);
      const wabaResult = validateWabaJson(wabaJson);

      await prisma.flowVersion.update({
        where: { id: version.id },
        data: {
          wabaValidationStatus: internalResult.valid ? 'valid' : 'invalid',
          wabaValidatedAt: new Date(),
          wabaValidationErrors: internalResult.errors.length ? internalResult.errors : null,
        },
      });

      return res.json({ internal: internalResult, waba: wabaResult, versionId: version.id });
    }

    const internalResult = validateInternalDefinition(definition);
    const wabaJson = exportToWaba(definition);
    const wabaResult = validateWabaJson(wabaJson);
    res.json({ internal: internalResult, waba: wabaResult });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATE flow (dry-run)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/simulate', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);
    const { versionId, inputs = [], definition: bodyDef } = req.body;

    let definition = bodyDef;

    if (!definition) {
      const version = versionId
        ? await prisma.flowVersion.findFirst({ where: { id: Number(versionId), flowId: id, tenantId } })
        : await prisma.flowVersion.findFirst({
            where: { flowId: id, tenantId },
            orderBy: { versionNumber: 'desc' },
          });
      if (!version) return notFound(res, 'Version');
      definition = version.definition;
    }

    // Enrich with integrations (for action node metadata)
    const intMap = await _getIntegrationMap(tenantId);
    const enriched = enrichDefinition(definition, intMap);

    const result = simulateFlow(enriched, inputs);
    res.json(result);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// LIST versions
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/versions', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const flowId = Number(req.params.id);

    const versions = await prisma.flowVersion.findMany({
      where: { flowId, tenantId },
      orderBy: { versionNumber: 'desc' },
      select: {
        id: true, versionNumber: true, published: true, publishedAt: true,
        changelog: true, wabaValidationStatus: true, wabaValidatedAt: true,
        wabaValidationErrors: true, createdAt: true, createdByAdminUserId: true,
        _count: { select: { executions: true } },
      },
    });

    res.json(versions);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SAVE new version
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/versions', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const flowId = Number(req.params.id);
    const adminUserId = uid(req);
    const { definition, changelog } = req.body;

    if (!definition || !Array.isArray(definition.nodes)) {
      return res.status(400).json({ error: 'definition.nodes array is required' });
    }

    const existing = await prisma.flow.findFirst({ where: { id: flowId, tenantId } });
    if (!existing) return notFound(res);

    // Get next version number
    const latest = await prisma.flowVersion.findFirst({
      where: { flowId, tenantId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    const versionNumber = (latest?.versionNumber ?? 0) + 1;

    const validation = validateInternalDefinition(definition);

    const version = await prisma.flowVersion.create({
      data: {
        tenantId,
        flowId,
        versionNumber,
        definition,
        changelog: changelog ?? `Versión ${versionNumber}`,
        published: false,
        createdByAdminUserId: adminUserId,
        wabaValidationStatus: validation.valid ? 'valid' : 'invalid',
        wabaValidatedAt: new Date(),
        wabaValidationErrors: validation.errors.length ? validation.errors : null,
      },
    });

    // Update flow version counter & metaJson snapshot
    await prisma.flow.update({
      where: { id: flowId },
      data: { version: versionNumber, metaJson: exportToWaba(definition) },
    });

    logger.info({ tenantId, flowId, versionNumber }, 'waba-flows: new version saved');
    res.status(201).json({ version, validation });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLISH / UNPUBLISH version
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/versions/:vId/publish', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const flowId = Number(req.params.id);
    const vId    = Number(req.params.vId);
    const { publish = true } = req.body;

    const version = await prisma.flowVersion.findFirst({ where: { id: vId, flowId, tenantId } });
    if (!version) return notFound(res, 'Version');

    await prisma.$transaction(async (tx) => {
      if (publish) {
        // Unpublish all other versions first
        await tx.flowVersion.updateMany({
          where: { flowId, tenantId, published: true },
          data: { published: false },
        });
      }
      await tx.flowVersion.update({
        where: { id: vId },
        data: {
          published: Boolean(publish),
          publishedAt: publish ? new Date() : null,
        },
      });
    });

    logger.info({ tenantId, flowId, vId, publish }, 'waba-flows: version publish state changed');
    res.json({ published: Boolean(publish), versionId: vId });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROLLBACK: make an older version the published one
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/versions/:vId/rollback', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const flowId = Number(req.params.id);
    const vId    = Number(req.params.vId);

    const version = await prisma.flowVersion.findFirst({ where: { id: vId, flowId, tenantId } });
    if (!version) return notFound(res, 'Version');

    await prisma.$transaction(async (tx) => {
      await tx.flowVersion.updateMany({
        where: { flowId, tenantId, published: true },
        data: { published: false },
      });
      await tx.flowVersion.update({
        where: { id: vId },
        data: { published: true, publishedAt: new Date() },
      });
    });

    logger.info({ tenantId, flowId, vId }, 'waba-flows: rollback to version');
    res.json({ rolledBack: true, versionId: vId });
  } catch (err) { next(err); }
});

module.exports = router;
