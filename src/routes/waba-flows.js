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
  simulateAllPaths,
  buildSimulationVerdict,
} = require('../services/wabaFlowService');
const logger = require('../utils/logger');
const conversationLogger = require('../engine/conversationLogger');

const router = express.Router();
const prisma = new PrismaClient();
const CONV_EVENT = conversationLogger.EVENT;

router.use(requireJwt);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function tid(req) { return req.admin?.tenantId ?? req.user?.tenantId ?? req.user?.tenant_id; }
function uid(req) { return req.admin?.adminUserId ?? req.user?.adminUserId ?? req.user?.id; }
function notFound(res, entity = 'Flow') { return res.status(404).json({ error: `${entity} not found` }); }

/**
 * Merge FlowVariable DB records into definition.variables.
 * DB records take precedence over any values already in definition.variables
 * (so designer defaults are overwritten by admin-configured values).
 */
async function _syncVariablesIntoDefinition(tenantId, flowId, definition) {
  const rows = await prisma.flowVariable.findMany({
    where: {
      tenantId,
      OR: [
        { scope: 'global', flowId: null },
        { flowId },
      ],
    },
    orderBy: { id: 'asc' },
  });

  const vars = Object.assign({}, definition.variables ?? {});
  for (const row of rows) {
    vars[row.nombre] = {
      tipo: row.tipo,
      valorDefault: row.valorDefault,
      scope: row.scope,
      descripcion: row.descripcion ?? undefined,
    };
  }
  return { ...definition, variables: vars };
}

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

async function resolveTenantForFlow(req, flowId, explicitTenantSlug) {
  const resolvedTenantId = await resolveTenantId(req, explicitTenantSlug);
  if (resolvedTenantId) return resolvedTenantId;

  // For super-admins without a pinned tenant, infer tenant from the flow.
  if (req.admin?.superAdmin) {
    const flow = await prisma.flow.findUnique({
      where: { id: flowId },
      select: { tenantId: true },
    });
    return flow?.tenantId ?? null;
  }

  return null;
}

async function _getIntegrationMap(tenantId) {
  const integrations = await prisma.integration.findMany({
    where: { tenantId, activo: true },
  });
  return new Map(integrations.map((i) => [i.nombre, i]));
}

function buildSimulationUserKey(flowId, runKey, pathIndex) {
  return `waba-sim:${flowId}:${runKey}:${pathIndex}`.slice(0, 120);
}

function simulationStatusFromPath(path) {
  if (Array.isArray(path?.trace) && path.trace.some((step) => step?.error)) return 'error';
  if (path?.endedBy === 'max_steps') return 'error';
  return 'completed';
}

async function persistSimulationConversations({
  tenantId,
  flowId,
  flowVersionId,
  enrichedDefinition,
  mode,
  result,
  verdict,
  adminUserId,
}) {
  const persistedConversationIds = [];
  const runKey = Date.now().toString(36);

  const normalizedPaths = Array.isArray(result?.paths)
    ? result.paths
    : [{
        pathId: 'single',
        trace: Array.isArray(result?.trace) ? result.trace : [],
        finalVariables: result?.finalVariables ?? {},
        stepCount: result?.stepCount ?? 0,
        endedBy: 'completed',
      }];

  for (const [index, path] of normalizedPaths.entries()) {
    const userKey = buildSimulationUserKey(flowId, runKey, index + 1);
    const conversationId = await conversationLogger.getOrCreate(
      tenantId,
      userKey,
      flowId,
      flowVersionId ?? null,
      {
        contextMeta: {
          sandbox: true,
          source: 'waba_flow_simulator',
          simulationMode: mode,
          simulationPathId: path.pathId,
          adminUserId: adminUserId ?? null,
        },
      },
    );

    if (!conversationId) continue;
    persistedConversationIds.push(conversationId);

    await conversationLogger.log(conversationId, tenantId, enrichedDefinition.entry_point ?? null, CONV_EVENT.FLOW_START, {
      flow_id: flowId,
      flow_version_id: flowVersionId ?? null,
      entry_point: enrichedDefinition.entry_point ?? null,
      simulation: {
        mode,
        path_id: path.pathId,
        step_count: path.stepCount ?? path.trace?.length ?? 0,
      },
    });

    for (const step of (path.trace ?? [])) {
      const nodeRef = step?.nodeId ?? null;

      if (step?.error) {
        await conversationLogger.log(conversationId, tenantId, nodeRef, CONV_EVENT.FLOW_ERROR, {
          message: step.error,
          simulation: true,
          path_id: path.pathId,
        });
        continue;
      }

      if (step?.llm_intent) {
        await conversationLogger.log(conversationId, tenantId, nodeRef, CONV_EVENT.LLM_CALL, {
          kind: 'intent_classification',
          intent: step.llm_intent,
          simulation: true,
        });
      }

      if (step?.input !== null && step?.input !== undefined) {
        const inputEvent = step?.nodeType === 'menu' ? CONV_EVENT.MENU_SELECTION : CONV_EVENT.USER_INPUT;
        await conversationLogger.log(conversationId, tenantId, nodeRef, inputEvent, {
          value: step.input,
          selected: step.selected ?? null,
          simulation: true,
        });
      }

      if (step?.variable_captured && typeof step.variable_captured === 'object') {
        for (const [variable, value] of Object.entries(step.variable_captured)) {
          await conversationLogger.log(conversationId, tenantId, nodeRef, CONV_EVENT.VARIABLE_SET, {
            variable,
            value,
            simulation: true,
          });
        }
      }

      const output = step?.output;
      if (!output || typeof output !== 'object') continue;

      if (output.type === 'text' || output.type === 'buttons' || output.type === 'list') {
        await conversationLogger.log(conversationId, tenantId, nodeRef, CONV_EVENT.MESSAGE_SENT, {
          text: output.text ?? null,
          options: output.options ?? null,
          llm_generated: Boolean(output.llmGenerated),
          simulation: true,
        });
        if (output.llmGenerated) {
          await conversationLogger.log(conversationId, tenantId, nodeRef, CONV_EVENT.LLM_CALL, {
            kind: 'llm_response',
            text: output.text ?? null,
            simulation: true,
          });
        }
      } else if (output.type === 'condition') {
        await conversationLogger.log(conversationId, tenantId, nodeRef, CONV_EVENT.CONDITION_EVAL, {
          expression: output.expression ?? null,
          result: output.result ?? output.assumedResult ?? null,
          branch: output.assumedBranch ?? null,
          next: output.next ?? null,
          simulation: true,
        });
      } else if (output.type === 'api_call_simulated') {
        await conversationLogger.log(conversationId, tenantId, nodeRef, CONV_EVENT.API_CALL, {
          endpoint: output.endpoint ?? null,
          method: output.method ?? null,
          note: output.note ?? null,
          simulation: true,
        });
      }
    }

    await conversationLogger.updateContext(conversationId, {
      current_node: path.trace?.[path.trace.length - 1]?.nodeId ?? null,
      variables: path.finalVariables ?? {},
      simulation: {
        mode,
        path_id: path.pathId,
        verdict_status: verdict?.status ?? null,
      },
      verdict,
    });

    await conversationLogger.log(conversationId, tenantId, path.trace?.[path.trace.length - 1]?.nodeId ?? null, CONV_EVENT.FLOW_END, {
      final_variables: path.finalVariables ?? {},
      verdict,
      simulation: true,
    });

    await conversationLogger.end(conversationId, simulationStatusFromPath(path), {
      variables: path.finalVariables ?? {},
      simulation: {
        mode,
        path_id: path.pathId,
      },
      verdict,
    });
  }

  return persistedConversationIds;
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
    const flowId   = Number(req.params.id);
    const vId      = Number(req.params.vId);
    const tenantId = await resolveTenantForFlow(req, flowId, req.query.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug is required for WABA flows' });

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
    const id = Number(req.params.id);
    const tenantId = await resolveTenantForFlow(req, id, req.body?.tenantSlug ?? req.query?.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug is required for WABA flows' });
    const { versionId, inputs = [], definition: bodyDef, mode = 'single', useLlm = false } = req.body;

    let definition = bodyDef;
    let resolvedFlowVersionId = versionId ? Number(versionId) : null;

    if (!definition) {
      const version = versionId
        ? await prisma.flowVersion.findFirst({ where: { id: Number(versionId), flowId: id, tenantId } })
        : await prisma.flowVersion.findFirst({
            where: { flowId: id, tenantId },
            orderBy: { versionNumber: 'desc' },
          });
      if (!version) return notFound(res, 'Version');
      definition = version.definition;
      resolvedFlowVersionId = version.id;
    }

    // Enrich with integrations (for action node metadata)
    const intMap = await _getIntegrationMap(tenantId);
    const enriched = enrichDefinition(definition, intMap);

    if (mode === 'exhaustive') {
      const result = await simulateAllPaths(enriched, { tenantId, useLlm: Boolean(useLlm) });
      const verdict = await buildSimulationVerdict(result, enriched, { tenantId, useLlm: Boolean(useLlm) });
      const conversationIds = await persistSimulationConversations({
        tenantId,
        flowId: id,
        flowVersionId: resolvedFlowVersionId,
        enrichedDefinition: enriched,
        mode,
        result,
        verdict,
        adminUserId: uid(req),
      });
      return res.json({ ...result, verdict, conversationIds });
    }

    const result = simulateFlow(enriched, inputs);
    const verdict = await buildSimulationVerdict(result, enriched, { tenantId, useLlm: false });
    const conversationIds = await persistSimulationConversations({
      tenantId,
      flowId: id,
      flowVersionId: resolvedFlowVersionId,
      enrichedDefinition: enriched,
      mode: 'single',
      result,
      verdict,
      adminUserId: uid(req),
    });
    res.json({ ...result, verdict, mode: 'single', conversationIds });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// LIST versions
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/versions', async (req, res, next) => {
  try {
    const flowId = Number(req.params.id);
    const tenantId = await resolveTenantForFlow(req, flowId, req.query.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug is required for WABA flows' });

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
    const requestTenantId = tid(req);
    const flowId = Number(req.params.id);
    const adminUserId = uid(req);
    const { definition, changelog } = req.body;

    if (!definition || !Array.isArray(definition.nodes)) {
      return res.status(400).json({ error: 'definition.nodes array is required' });
    }

    const existing = await prisma.flow.findFirst({
      where: {
        id: flowId,
        ...(requestTenantId ? { tenantId: requestTenantId } : {}),
      },
      select: { id: true, tenantId: true },
    });
    if (!existing) return notFound(res);

    const tenantId = existing.tenantId;

    // Sync DB variables into definition before saving
    const enrichedDefinition = await _syncVariablesIntoDefinition(tenantId, flowId, definition);

    // Get next version number
    const latest = await prisma.flowVersion.findFirst({
      where: { flowId, tenantId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    const versionNumber = (latest?.versionNumber ?? 0) + 1;

    const validation = validateInternalDefinition(enrichedDefinition);

    const version = await prisma.flowVersion.create({
      data: {
        tenantId,
        flowId,
        versionNumber,
        definition: enrichedDefinition,
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
      data: { version: versionNumber, metaJson: exportToWaba(enrichedDefinition) },
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
    const flowId = Number(req.params.id);
    const vId    = Number(req.params.vId);
    const { publish = true } = req.body;
    const tenantId = await resolveTenantForFlow(req, flowId, req.body?.tenantSlug ?? req.query?.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug is required for WABA flows' });

    const version = await prisma.flowVersion.findFirst({ where: { id: vId, flowId, tenantId } });
    if (!version) return notFound(res, 'Version');

    // On publish, re-sync DB variables so the published snapshot is always up-to-date
    let finalDefinition = version.definition;
    if (publish) {
      finalDefinition = await _syncVariablesIntoDefinition(tenantId, flowId, version.definition);
    }

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
          ...(publish ? { definition: finalDefinition } : {}),
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
    const flowId = Number(req.params.id);
    const vId    = Number(req.params.vId);
    const tenantId = await resolveTenantForFlow(req, flowId, req.body?.tenantSlug ?? req.query?.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug is required for WABA flows' });

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
