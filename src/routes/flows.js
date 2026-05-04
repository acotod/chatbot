'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const { audit } = require('../services/audit');
const { executeStep } = require('../services/flowEngine');
const { executeGenericStep } = require('../services/genericFlowEngine');
const { parseMetaJsonToGraph, buildMetaJsonFromGraph } = require('../services/flowTransformer');
const { getCatalog, saveCatalog } = require('../services/endpointCatalog');
const { validateWabaJson } = require('../services/wabaValidator');

const prisma = new PrismaClient();
const router = express.Router();
const flowTestSessions = new Map();

router.use(requireJwt);

function executeStepInFlow(flow, { currentNodeId, input }) {
  if (!currentNodeId) {
    const startNode = flow.nodes.find((n) => n.type === 'start') ?? flow.nodes[0];
    if (!startNode) return null;
    return { nodeId: startNode.id, content: startNode.content };
  }

  const edges = flow.edges.filter((e) => e.sourceNodeId === currentNodeId);
  const matchedEdge =
    edges.find((e) => e.condition && e.condition === input) ??
    edges.find((e) => !e.condition);

  if (!matchedEdge) return null;

  const nextNode = flow.nodes.find((n) => n.id === matchedEdge.targetNodeId);
  if (!nextNode) return null;

  return { nodeId: nextNode.id, content: nextNode.content };
}

// ── CRUD flows ────────────────────────────────────────────────────────────────

// GET /flows?tenantSlug=xxx
router.get('/', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const { tenantSlug } = req.query;
    const where = {};

    if (tenantSlug) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      where.tenantId = tenant.id;
    } else if (!req.admin.superAdmin && req.admin.tenantId) {
      where.tenantId = req.admin.tenantId;
    }

    const flows = await prisma.flow.findMany({
      where,
      include: { nodes: true, edges: true },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(flows);
  } catch (err) { next(err); }
});

// POST /flows
router.post('/', requirePermiso('EDIT_FLUJOS'), async (req, res, next) => {
  try {
    const { tenantId, nombre } = req.body;
    if (!tenantId || !nombre) return res.status(400).json({ error: 'tenantId and nombre are required' });

    const flow = await prisma.flow.create({
      data: { tenantId, nombre },
      include: { nodes: true, edges: true },
    });
    audit({ adminUserId: req.admin.adminUserId, tenantId, accion: 'CREATE_FLOW', entidad: 'flow', entidadId: flow.id, metadata: { nombre } });
    res.status(201).json(flow);
  } catch (err) { next(err); }
});

// ── Flow engine step ──────────────────────────────────────────────────────────

// POST /flows/execute
router.post('/execute', async (req, res, next) => {
  try {
    const { tenantId, currentNodeId, input } = req.body;
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
    const result = await executeStep({ tenantId, currentNodeId: currentNodeId ?? null, input: input ?? null });
    if (!result) return res.status(404).json({ error: 'No next node found' });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /flows/:id/execute
// Compatibility route used by the builder test panel.
router.post('/:id/execute', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const flowId = Number(req.params.id);
    if (Number.isNaN(flowId)) return res.status(400).json({ error: 'Invalid flow id' });

    const flow = await prisma.flow.findUnique({
      where: { id: flowId },
      include: { nodes: true, edges: true },
    });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    if (!req.admin.superAdmin && req.admin.tenantId && flow.tenantId !== req.admin.tenantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : null;
    const key = sessionId ? `${flowId}:${sessionId}` : null;

    const currentNodeId = req.body?.currentNodeId ?? (key ? flowTestSessions.get(key) ?? null : null);
    const input = req.body?.mensaje ?? req.body?.input ?? null;

    const result = executeStepInFlow(flow, {
      currentNodeId: currentNodeId ? Number(currentNodeId) : null,
      input,
    });

    if (!result) {
      if (key) flowTestSessions.delete(key);
      return res.status(404).json({ error: 'No next node found' });
    }

    if (key) flowTestSessions.set(key, result.nodeId);

    const content = result.content ?? {};
    const reply = content.body ?? content.label ?? content.title ?? '✓';
    res.json({
      reply,
      nextScreen: String(result.nodeId),
      nodeId: result.nodeId,
      content,
    });
  } catch (err) { next(err); }
});

// POST /flows/:id/execute-generic
// Stateful execution using Flow.metaJson screens/actions and DB-persisted JSON session state.
router.post('/:id/execute-generic', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const flowId = Number(req.params.id);
    if (Number.isNaN(flowId)) return res.status(400).json({ error: 'Invalid flow id' });

    const flow = await prisma.flow.findUnique({ where: { id: flowId } });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    if (!req.admin.superAdmin && req.admin.tenantId && flow.tenantId !== req.admin.tenantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const flowJson = flow.metaJson;
    if (!flowJson || !Array.isArray(flowJson.screens) || flowJson.screens.length === 0) {
      return res.status(400).json({
        error: 'Flow metaJson must include screens[] in generic format before execute-generic',
      });
    }

    const sessionKeyRaw = req.body?.sessionKey ?? `admin-${req.admin.adminUserId}`;
    const sessionKey = String(sessionKeyRaw).trim();
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey is required' });

    if (req.body?.reset === true) {
      await prisma.flowSession.deleteMany({
        where: { tenantId: flow.tenantId, flowId, sessionKey },
      });
    }

    let session = await prisma.flowSession.findUnique({
      where: {
        tenantId_flowId_sessionKey: {
          tenantId: flow.tenantId,
          flowId,
          sessionKey,
        },
      },
    });

    if (!session) {
      session = await prisma.flowSession.create({
        data: {
          tenantId: flow.tenantId,
          flowId,
          sessionKey,
          currentScreenId: null,
          stateJson: { variables: {} },
          businessContextJson: req.body?.businessContextJson ?? null,
          auditEventsJson: [],
        },
      });
    }

    const currentScreenId = req.body?.currentScreenId ?? session.currentScreenId ?? null;
    const input = req.body?.input ?? null;
    const previousVars = (session.stateJson && typeof session.stateJson === 'object')
      ? (session.stateJson.variables || {})
      : {};
    const businessContext = req.body?.businessContextJson
      ?? session.businessContextJson
      ?? {};

    const result = await executeGenericStep({
      flowJson,
      currentScreenId,
      input,
      variables: previousVars,
      businessContext,
    });

    const nextAudit = Array.isArray(session.auditEventsJson) ? [...session.auditEventsJson] : [];
    nextAudit.push({
      ts: new Date().toISOString(),
      from: result.currentScreenId,
      to: result.nextScreenId,
      input,
      matchedCondition: result.matchedCondition,
      webhook: result.webhookResult
        ? {
            payload: result.webhookResult.payload,
            response: result.webhookResult.responseBody,
          }
        : null,
    });

    const updated = await prisma.flowSession.update({
      where: {
        tenantId_flowId_sessionKey: {
          tenantId: flow.tenantId,
          flowId,
          sessionKey,
        },
      },
      data: {
        status: result.terminal ? 'completed' : 'active',
        currentScreenId: result.nextScreenId,
        stateJson: {
          variables: result.variables,
          lastWebhook: result.webhookResult
            ? {
                payload: result.webhookResult.payload,
                response: result.webhookResult.responseBody,
              }
            : null,
        },
        businessContextJson: businessContext,
        auditEventsJson: nextAudit,
      },
    });

    return res.json({
      sessionKey,
      status: updated.status,
      currentScreenId: updated.currentScreenId,
      screen: result.nextScreen,
      terminal: result.terminal,
      variables: result.variables,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /flows/:id/sessions/:sessionKey
// Returns a persisted generic flow session snapshot with JSON state/audit.
router.get('/:id/sessions/:sessionKey', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const flowId = Number(req.params.id);
    if (Number.isNaN(flowId)) return res.status(400).json({ error: 'Invalid flow id' });

    const flow = await prisma.flow.findUnique({ where: { id: flowId } });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    if (!req.admin.superAdmin && req.admin.tenantId && flow.tenantId !== req.admin.tenantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const sessionKey = String(req.params.sessionKey || '').trim();
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey is required' });

    const session = await prisma.flowSession.findUnique({
      where: {
        tenantId_flowId_sessionKey: {
          tenantId: flow.tenantId,
          flowId,
          sessionKey,
        },
      },
    });

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const includeAudit = req.query.includeAudit !== 'false';
    const auditEvents = Array.isArray(session.auditEventsJson) ? session.auditEventsJson : [];

    return res.json({
      flow: {
        id: flow.id,
        nombre: flow.nombre,
        version: flow.version,
      },
      session: {
        id: session.id,
        sessionKey: session.sessionKey,
        status: session.status,
        currentScreenId: session.currentScreenId,
        stateJson: session.stateJson,
        businessContextJson: session.businessContextJson,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      audit: includeAudit ? auditEvents : undefined,
      auditCount: auditEvents.length,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /flows/:id/sessions
// Lists persisted generic flow sessions for the selected flow.
router.get('/:id/sessions', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const flowId = Number(req.params.id);
    if (Number.isNaN(flowId)) return res.status(400).json({ error: 'Invalid flow id' });

    const flow = await prisma.flow.findUnique({ where: { id: flowId } });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    if (!req.admin.superAdmin && req.admin.tenantId && flow.tenantId !== req.admin.tenantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const rawLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
    const status = req.query.status ? String(req.query.status) : null;

    const sessions = await prisma.flowSession.findMany({
      where: {
        tenantId: flow.tenantId,
        flowId,
        ...(status ? { status } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    return res.json({
      flow: {
        id: flow.id,
        nombre: flow.nombre,
        version: flow.version,
      },
      total: sessions.length,
      items: sessions.map((s) => ({
        id: s.id,
        sessionKey: s.sessionKey,
        status: s.status,
        currentScreenId: s.currentScreenId,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// ── Flow Builder smart endpoints ──────────────────────────────────────────────

/**
 * GET /flows/endpoints-catalog?tenantId=xxx
 * Returns the dynamic endpoint catalog for the given tenant.
 * Falls back to the built-in default catalog when no tenant config is found.
 */
router.get('/endpoints-catalog', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const { tenantId, tenantSlug } = req.query;

    let resolvedTenantId = tenantId;
    if (!resolvedTenantId && tenantSlug) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
      resolvedTenantId = tenant?.id ?? null;
    }
    if (!resolvedTenantId && !req.admin.superAdmin) {
      resolvedTenantId = req.admin.tenantId ?? null;
    }

    const catalog = await getCatalog(resolvedTenantId);
    res.json({ action: 'catalog', data: catalog, explanation: 'Catálogo de endpoints disponibles' });
  } catch (err) { next(err); }
});

/**
 * PUT /flows/endpoints-catalog
 * Save a custom endpoint catalog for a tenant.
 * Body: { tenantId, endpoints: [...] }
 */
router.put('/endpoints-catalog', requirePermiso('EDIT_FLUJOS'), async (req, res, next) => {
  try {
    const { tenantId, endpoints } = req.body;
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
    if (!Array.isArray(endpoints)) return res.status(400).json({ error: 'endpoints must be an array' });

    await saveCatalog(tenantId, { endpoints });
    audit({
      adminUserId: req.admin.adminUserId,
      tenantId,
      accion: 'UPDATE_ENDPOINTS_CATALOG',
      entidad: 'flow_catalog',
      entidadId: tenantId,
      metadata: { count: endpoints.length },
    });
    res.json({ action: 'catalog_saved', data: { endpoints }, explanation: 'Catálogo guardado correctamente' });
  } catch (err) { next(err); }
});

/**
 * POST /flows/parse-json
 * Convert a Meta WhatsApp Flow JSON into ReactFlow nodes + edges.
 * Body: { json: <Meta Flow JSON object> }
 */
router.post('/parse-json', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const { json } = req.body;
    if (!json || typeof json !== 'object') {
      return res.status(400).json({ error: 'Body must include a "json" object (parsed Meta Flow JSON)' });
    }

    const result = parseMetaJsonToGraph(json);
    const hasErrors = result.diagnostics.some(d => d.severity === 'error');

    res.status(hasErrors ? 422 : 200).json({
      action:      'parse_flow',
      nodes:       result.nodes,
      edges:       result.edges,
      startNodeId: result.startNodeId,
      diagnostics: result.diagnostics,
      explanation: hasErrors
        ? 'El JSON se procesó parcialmente con errores'
        : `Flow parseado: ${result.nodes.length} nodos, ${result.edges.length} conexiones`,
    });
  } catch (err) { next(err); }
});

/**
 * POST /flows/export-json
 * Build a Meta WhatsApp Flow JSON from ReactFlow nodes + edges.
 * Body: { nodes, edges, tenantId? }
 * Optionally saves the snapshot to a flow by providing flowId.
 */
router.post('/export-json', requirePermiso('EDIT_FLUJOS'), async (req, res, next) => {
  try {
    const { nodes, edges, tenantId, tenantSlug, flowId } = req.body;
    if (!Array.isArray(nodes)) return res.status(400).json({ error: 'nodes must be an array' });

    let resolvedTenantId = tenantId;
    if (!resolvedTenantId && tenantSlug) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
      resolvedTenantId = tenant?.id ?? null;
    }
    if (!resolvedTenantId && !req.admin.superAdmin) {
      resolvedTenantId = req.admin.tenantId ?? null;
    }

    const catalog = await getCatalog(resolvedTenantId);
    const { json, validation } = buildMetaJsonFromGraph(nodes, edges ?? [], catalog.endpoints ?? []);

    // Run WABA structural validation on the exported JSON
    let wabaValidation = { valid: true, errors: [], warnings: [] };
    if (json) {
      wabaValidation = validateWabaJson(json);
      // Merge WABA errors into validation
      wabaValidation.errors.forEach(e => {
        if (!validation.errors.find(ve => ve.code === e.code)) {
          validation.errors.push({ code: e.code, severity: 'error', message: e.message, field: e.field, fix: e.fix });
        }
      });
      wabaValidation.warnings.forEach(w => {
        if (!validation.warnings.find(vw => vw.code === w.code)) {
          validation.warnings.push({ code: w.code, severity: 'warning', message: w.message, field: w.field });
        }
      });
    }

    // Optionally persist snapshot to flow
    if (json && flowId) {
      await prisma.flow.update({
        where: { id: Number(flowId) },
        data:  { metaJson: json },
      }).catch(() => {}); // Non-blocking
    }

    const hasErrors = validation.errors.length > 0;
    res.status(hasErrors ? 422 : 200).json({
      action: 'export_json',
      json:   json ?? null,
      validation,
      explanation: hasErrors
        ? `Export falló con ${validation.errors.length} error(es)`
        : `JSON Meta listo para publicar: ${json?.screens?.length ?? 0} pantallas`,
    });
  } catch (err) { next(err); }
});

// ── Per-flow CRUD (wildcards — must be last to avoid shadowing static routes) ─

// GET /flows/:id
router.get('/:id', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const flow = await prisma.flow.findUnique({
      where: { id: Number(req.params.id) },
      include: { nodes: true, edges: true },
    });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    res.json(flow);
  } catch (err) { next(err); }
});

// PUT /flows/:id — full replace (nodes + edges) + meta_json snapshot
router.put('/:id', requirePermiso('EDIT_FLUJOS'), async (req, res, next) => {
  try {
    const flowId = Number(req.params.id);
    const { nombre, activo, nodes, edges, metaJson } = req.body;

    const existing = await prisma.flow.findUnique({ where: { id: flowId } });
    if (!existing) return res.status(404).json({ error: 'Flow not found' });

    // Transactionally replace nodes + edges
    const flow = await prisma.$transaction(async (tx) => {
      await tx.flowEdge.deleteMany({ where: { flowId } });
      await tx.flowNode.deleteMany({ where: { flowId } });

      const updated = await tx.flow.update({
        where: { id: flowId },
        data: {
          nombre:   nombre ?? existing.nombre,
          activo:   activo ?? existing.activo,
          version:  { increment: 1 },
          metaJson: metaJson ?? existing.metaJson ?? undefined,
          nodes: nodes?.length
            ? { create: nodes.map(({ type, content, posX = 0, posY = 0 }) => ({ type, content, posX, posY })) }
            : undefined,
        },
        include: { nodes: true },
      });

      // Re-create edges using new node IDs mapped by index
      if (edges?.length && nodes?.length) {
        const nodeIdMap = {}; // old_index → new DB id
        updated.nodes.forEach((n, i) => { nodeIdMap[i] = n.id; });

        await tx.flowEdge.createMany({
          data: edges.map(({ sourceIndex, targetIndex, condition }) => ({
            flowId,
            sourceNodeId: nodeIdMap[sourceIndex],
            targetNodeId: nodeIdMap[targetIndex],
            condition: condition ?? null,
          })),
        });
      }

      return tx.flow.findUnique({
        where: { id: flowId },
        include: { nodes: true, edges: true },
      });
    });

    audit({
      adminUserId: req.admin.adminUserId,
      tenantId: existing.tenantId,
      accion: 'UPDATE_FLOW',
      entidad: 'flow',
      entidadId: flowId,
      metadata: { nombre, version: flow.version },
    });
    res.json(flow);
  } catch (err) { next(err); }
});

// DELETE /flows/:id
router.delete('/:id', requirePermiso('EDIT_FLUJOS'), async (req, res, next) => {
  try {
    const flow = await prisma.flow.delete({ where: { id: Number(req.params.id) } });
    audit({ adminUserId: req.admin.adminUserId, tenantId: flow.tenantId, accion: 'DELETE_FLOW', entidad: 'flow', entidadId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
