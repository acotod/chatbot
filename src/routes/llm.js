'use strict';
/**
 * LLM / WABA Rescue routes.
 *
 * POST /llm/rescue                  Submit a WABA Flow JSON + error for diagnosis & repair
 * GET  /llm/rescue                  List rescue history for the tenant
 * GET  /llm/rescue/:id              Fetch a specific rescue log
 * POST /llm/validate                Validate-only (no rescue attempt, no persistence)
 * GET  /llm/status                  Check if LLM is configured for the tenant
 *
 * Permissions:
 *   VIEW_LLM_RESCUE    — read rescue logs
 *   MANAGE_LLM_RESCUE  — submit rescues
 *   MANAGE_LLM_CONFIG  — read LLM config status
 */

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const { audit } = require('../services/audit');
const { rescueFlow, validateWabaJson } = require('../services/wabaValidator');
const { getLlmStatus, getLlmConfig, generateFlow, callLlmForJson } = require('../services/llmService');
const { getCatalog } = require('../services/endpointCatalog');
const logger = require('../utils/logger');

const prisma = new PrismaClient();
const router = express.Router();

router.use(requireJwt);

// ── Validation helpers ────────────────────────────────────────────────────────

function validateRequest(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array() });
    return false;
  }
  return true;
}

/**
 * Resolve the tenantId the caller may act on.
 * SuperAdmins may pass an explicit tenantId; if none provided, prefer a tenant
 * with llm_config, then fall back to the first available tenant.
 */
async function resolveTenantId(req, explicitId) {
  if (req.admin.superAdmin) {
    if (explicitId) return explicitId;
    if (req.admin.tenantId) return req.admin.tenantId;

    // Prefer a tenant that already has llm_config configured
    const withLlmConfig = await prisma.configuracion.findFirst({
      where: { clave: 'llm_config' },
      select: { tenantId: true },
      orderBy: { id: 'asc' },
    });
    if (withLlmConfig?.tenantId) return withLlmConfig.tenantId;

    // Fall back to the first tenant in the database
    const first = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    return first?.id ?? null;
  }
  return req.admin.tenantId ?? null;
}

// ── POST /llm/rescue ──────────────────────────────────────────────────────────

const rescueValidationRules = [
  body('originalJson')
    .notEmpty().withMessage('originalJson is required')
    .custom((v) => {
      // Accept object or JSON string
      if (typeof v === 'object') return true;
      try { JSON.parse(v); return true; } catch { throw new Error('originalJson must be valid JSON (object or JSON string)'); }
    }),
  body('wabaError')
    .notEmpty().withMessage('wabaError is required'),
  body('tenantId')
    .optional().isUUID().withMessage('tenantId must be a valid UUID'),
];

router.post('/rescue', requirePermiso('MANAGE_LLM_RESCUE'), rescueValidationRules, async (req, res, next) => {
  if (!validateRequest(req, res)) return;

  try {
    const tenantId = await resolveTenantId(req, req.body.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const { originalJson, wabaError } = req.body;

    logger.info({ tenantId, adminUserId: req.admin.adminUserId }, 'llm/rescue: rescue initiated');

    // Run rescue pipeline
    const result = await rescueFlow({ originalJson, wabaError, tenantId });

    // Persist log
    const log = await prisma.wabaRescueLog.create({
      data: {
        tenantId,
        adminUserId     : req.admin.adminUserId ?? null,
        originalJson    : typeof originalJson === 'string' ? JSON.parse(originalJson) : originalJson,
        wabaError       : typeof wabaError === 'string' ? tryParseJson(wabaError) : wabaError,
        diagnosis       : result.diagnosis,
        fixedJson       : result.fixedJson,
        changes         : result.changes,
        confidenceScore : result.confidenceScore,
        status          : result.status,
        llmUsed         : result.llmUsed,
      },
    });

    audit({
      adminUserId : req.admin.adminUserId,
      tenantId,
      accion      : 'WABA_RESCUE',
      entidad     : 'waba_rescue_log',
      entidadId   : String(log.id),
      metadata    : { status: result.status, confidenceScore: result.confidenceScore, llmUsed: result.llmUsed },
    });

    res.status(200).json({
      id              : log.id,
      status          : result.status,
      success         : result.success,
      confidenceScore : result.confidenceScore,
      llmUsed         : result.llmUsed,
      diagnosis       : result.diagnosis,
      fixedJson       : result.fixedJson,
      changes         : result.changes,
      residualRisks   : result.residualRisks,
      probableNextError: result.probableNextError,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /llm/validate ────────────────────────────────────────────────────────
// Lightweight: validate-only, no LLM call, no persistence.

router.post('/validate', requirePermiso('VIEW_LLM_RESCUE'), [
  body('flowJson').notEmpty().withMessage('flowJson is required'),
], async (req, res, next) => {
  if (!validateRequest(req, res)) return;
  try {
    let flow = req.body.flowJson;
    if (typeof flow === 'string') {
      try { flow = JSON.parse(flow); }
      catch (e) { return res.status(400).json({ valid: false, errors: [{ code: 'JSON_PARSE_ERROR', message: e.message }], warnings: [] }); }
    }
    const result = validateWabaJson(flow);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── GET /llm/rescue ───────────────────────────────────────────────────────────

router.get('/rescue', requirePermiso('VIEW_LLM_RESCUE'), [
  query('tenantId').optional().isUUID(),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  query('status').optional().isIn(['pending', 'fixed', 'partial', 'failed', 'manual_review']),
], async (req, res, next) => {
  if (!validateRequest(req, res)) return;
  try {
    const tenantId = await resolveTenantId(req, req.query.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const page  = req.query.page  ?? 1;
    const limit = req.query.limit ?? 20;
    const skip  = (page - 1) * limit;
    const where = { tenantId };
    if (req.query.status) where.status = req.query.status;

    const [logs, total] = await prisma.$transaction([
      prisma.wabaRescueLog.findMany({
        where,
        orderBy : { createdAt: 'desc' },
        skip,
        take    : limit,
        // Return summary fields only (no full JSONs for list)
        select  : { id: true, status: true, confidenceScore: true, llmUsed: true, createdAt: true, updatedAt: true, adminUserId: true },
      }),
      prisma.wabaRescueLog.count({ where }),
    ]);

    res.json({ data: logs, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// ── GET /llm/rescue/:id ───────────────────────────────────────────────────────

router.get('/rescue/:id', requirePermiso('VIEW_LLM_RESCUE'), async (req, res, next) => {
  try {
    const id  = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const log = await prisma.wabaRescueLog.findUnique({ where: { id } });
    if (!log) return res.status(404).json({ error: 'Rescue log not found' });

    // Tenant scope guard
    if (!req.admin.superAdmin && log.tenantId !== req.admin.tenantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(log);
  } catch (err) {
    next(err);
  }
});

// ── GET /llm/status ───────────────────────────────────────────────────────────

router.get('/status', requirePermiso('MANAGE_LLM_CONFIG'), async (req, res, next) => {
  try {
    const tenantId = await resolveTenantId(req, req.query.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const status = await getLlmStatus(tenantId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// ── POST /llm/prompt-assistant ───────────────────────────────────────────────
// Validates prompt completeness and asks follow-up questions to enrich it.

const PROMPT_ASSISTANT_SYSTEM = `You are a prompt assistant for a WhatsApp flow builder.
You must improve a draft prompt and decide if it is complete enough to generate a robust flow.

Rules:
- Work only with provided information.
- If information is missing, ask concise follow-up questions (max 3).
- If enough information exists, mark status as "ready".
- Always return valid JSON only.

Return schema:
{
  "status": "needs_info" | "ready",
  "assistantMessage": "short guidance in Spanish",
  "questions": ["..."],
  "missing": ["..."],
  "suggestedPrompt": "full improved prompt in Spanish, ready for flow generation",
  "score": 0
}`;

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .slice(-20)
    .map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      text: String(m?.text || '').trim().slice(0, 1000),
    }))
    .filter((m) => m.text.length > 0);
}

function buildDraftFromBrief(brief, draftPrompt) {
  if (typeof draftPrompt === 'string' && draftPrompt.trim()) return draftPrompt.trim();
  if (!brief || typeof brief !== 'object') return '';

  const lines = [
    'Objetivo: Disenar un flujo conversacional de WhatsApp Business',
    `Tipo de proyecto: ${brief.projectType || 'general'}`,
    `Caso de uso: ${brief.useCase || 'No especificado'}`,
    `Industria: ${brief.industry || 'No especificada'}`,
    `Usuario objetivo: ${brief.targetUser || 'No especificado'}`,
    `Objetivo principal: ${brief.mainGoal || 'No especificado'}`,
    `Entradas esperadas: ${brief.requiredInputs || 'No especificadas'}`,
    `Reglas de negocio: ${brief.businessRules || 'No especificadas'}`,
    `Integraciones API/webhooks: ${brief.apiIntegrations || 'Sin integraciones externas'}`,
    `Salidas esperadas: ${brief.expectedOutputs || 'No especificadas'}`,
    `Tono conversacional: ${brief.tone || 'cercano'}`,
  ];
  return lines.join('\n');
}



router.post('/prompt-assistant', requirePermiso('MANAGE_LLM_RESCUE'), [
  body('tenantId').optional({ checkFalsy: true }).isUUID(),
], async (req, res, next) => {
  if (!validateRequest(req, res)) return;

  try {
    const tenantId = await resolveTenantId(req, req.body.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const brief = req.body.brief && typeof req.body.brief === 'object' ? req.body.brief : {};
    const draftPrompt = buildDraftFromBrief(brief, req.body.draftPrompt);
    const userMessage = String(req.body.userMessage || '').trim();
    const history = normalizeHistory(req.body.history);
    if (userMessage) history.push({ role: 'user', text: userMessage });

    const userPayload = {
      draftPrompt,
      brief,
      history,
      instruction: 'Evalua completitud del prompt, pregunta faltantes y devuelve prompt mejorado.',
    };

    const llm = await callLlmForJson(tenantId, PROMPT_ASSISTANT_SYSTEM, JSON.stringify(userPayload));
    if (!llm || typeof llm.json !== 'object' || !llm.json) {
      const cfg = await getLlmConfig(tenantId);
      if (!cfg) return res.status(503).json({ error: 'LLM no configurado para este tenant' });
      return res.status(503).json({ error: 'LLM temporalmente no disponible. Reintenta en unos segundos.', provider: cfg.provider, model: cfg.model });
    }

    const json = llm.json;
    const status = json.status === 'ready' ? 'ready' : 'needs_info';
    const questions = Array.isArray(json.questions)
      ? json.questions.map((q) => String(q).trim()).filter(Boolean).slice(0, 3)
      : [];
    const missing = Array.isArray(json.missing)
      ? json.missing.map((m) => String(m).trim()).filter(Boolean).slice(0, 8)
      : [];
    const suggestedPrompt = String(json.suggestedPrompt || draftPrompt || '').trim();

    return res.json({
      status,
      assistantMessage: String(json.assistantMessage || (status === 'ready'
        ? 'Prompt listo para generar flujo.'
        : 'Necesito algunos datos extra para completar el prompt.')).trim(),
      questions,
      missing,
      suggestedPrompt,
      score: clampScore(json.score),
      provider: llm.provider,
      model: llm.model,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /llm/generate-flow ──────────────────────────────────────────────────
// Generate a Meta WhatsApp Flow JSON from a natural language prompt using LLM.

router.post('/generate-flow', requirePermiso('MANAGE_LLM_RESCUE'), [
  body('prompt').notEmpty().withMessage('prompt is required').isLength({ max: 10000 }),
  body('tenantId').optional({ checkFalsy: true }).isUUID(),
], async (req, res, next) => {
  if (!validateRequest(req, res)) return;
  try {
    const tenantId = await resolveTenantId(req, req.body.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const { prompt } = req.body;
    logger.info({ tenantId, promptLen: prompt.length }, 'llm/generate-flow: generating');

    let resolvedTenantId = tenantId;
    let result = await generateFlow(resolvedTenantId, prompt);

    // Superadmin resilience: if chosen tenant fails, try another tenant that has llm_config
    if (!result && req.admin.superAdmin) {
      const fallbackCfg = await prisma.configuracion.findFirst({
        where: { clave: 'llm_config', tenantId: { not: resolvedTenantId } },
        select: { tenantId: true },
        orderBy: { id: 'asc' },
      });
      if (fallbackCfg?.tenantId) {
        logger.warn({ fromTenantId: resolvedTenantId, toTenantId: fallbackCfg.tenantId }, 'llm/generate-flow: trying fallback tenant with llm_config');
        const fallbackResult = await generateFlow(fallbackCfg.tenantId, prompt);
        if (fallbackResult) {
          resolvedTenantId = fallbackCfg.tenantId;
          result = fallbackResult;
        }
      }
    }

    if (!result) {
      const cfg = await getLlmConfig(resolvedTenantId);
      if (!cfg) {
        const json = buildDeterministicFallbackFlow(prompt);
        audit({
          adminUserId : req.admin.adminUserId,
          tenantId: resolvedTenantId,
          accion      : 'GENERATE_FLOW',
          entidad     : 'flow',
          entidadId   : null,
          metadata    : { provider: 'fallback', model: 'deterministic-v1', promptLen: prompt.length, llmUnavailable: true, reason: 'not_configured' },
        });
        return res.json({
          json,
          provider: 'fallback',
          model: 'deterministic-v1',
          warning: 'LLM no configurado o no disponible. Se generó un flujo base para que puedas continuar.',
          fallback: true,
        });
      }
      logger.warn({ tenantId: resolvedTenantId, provider: cfg.provider, model: cfg.model }, 'llm/generate-flow: provider returned null');
      const json = buildDeterministicFallbackFlow(prompt);
      audit({
        adminUserId : req.admin.adminUserId,
        tenantId: resolvedTenantId,
        accion      : 'GENERATE_FLOW',
        entidad     : 'flow',
        entidadId   : null,
        metadata    : { provider: 'fallback', model: 'deterministic-v1', promptLen: prompt.length, llmUnavailable: true, llmProvider: cfg.provider, llmModel: cfg.model },
      });
      return res.json({
        json,
        provider: 'fallback',
        model: 'deterministic-v1',
        warning: 'Proveedor LLM temporalmente no disponible. Se generó un flujo base para que puedas continuar.',
        fallback: true,
      });
    }

    audit({
      adminUserId : req.admin.adminUserId,
      tenantId: resolvedTenantId,
      accion      : 'GENERATE_FLOW',
      entidad     : 'flow',
      entidadId   : null,
      metadata    : { provider: result.provider, model: result.model, promptLen: prompt.length },
    });

    res.json({ json: result.json, provider: result.provider, model: result.model });
  } catch (err) { next(err); }
});

// ── POST /llm/design-intelligent-flow ───────────────────────────────────────
// Enterprise AI Flow Orchestrator — two-stage LLM pipeline:
//   Stage 1: Requirement analysis (intent + entities + constraints)
//   Stage 2: Enriched flow synthesis (catalog-aware prompt)

router.post('/design-intelligent-flow', requirePermiso('MANAGE_LLM_RESCUE'), [
  body('prompt').notEmpty().withMessage('prompt is required').isLength({ max: 10000 }),
  body('tenantId').optional({ checkFalsy: true }).isUUID(),
], async (req, res, next) => {
  if (!validateRequest(req, res)) return;
  try {
    const tenantId = await resolveTenantId(req, req.body.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const { prompt } = req.body;
    logger.info({ tenantId, promptLen: prompt.length }, 'llm/design-intelligent-flow: starting pipeline');

    // ── Stage 1: Requirement analysis ─────────────────────────────────────────
    const analysis = await analyzeRequirement(tenantId, prompt);
    logger.info(
      { tenantId, intent: analysis.intent, entities: analysis.entities.length, source: analysis._source },
      'llm/design-intelligent-flow: analysis complete',
    );

    // ── Stage 3 (pre-synthesis): Integration catalog scoring ──────────────────
    const integrations = await buildIntegrationSuggestions(tenantId, prompt);
    const topEndpoints = integrations.suggested.slice(0, 3);

    // ── Stage 2: Build enriched prompt + generate flow ────────────────────────
    const enrichedPrompt = buildEnrichedPrompt(prompt, analysis, topEndpoints);
    const generation = await generateFlowOrFallback(req, tenantId, enrichedPrompt);

    // ── Stage 4: Structural validation ───────────────────────────────────────
    const validation = buildValidationSummary(generation.json, analysis);
    const stageStatus = validation.status === 'failed'
      ? 'failed'
      : validation.status === 'passed_with_warnings'
        ? 'completed_with_warnings'
        : 'completed';
    const screenCount = Array.isArray(generation.json?.screens) ? generation.json.screens.length : 0;

    // ── Stage 6: Unified data contract ───────────────────────────────────────
    const dataContract = buildDataContract(analysis, topEndpoints);

    audit({
      adminUserId : req.admin.adminUserId,
      tenantId    : generation.resolvedTenantId,
      accion      : 'DESIGN_INTELLIGENT_FLOW',
      entidad     : 'flow',
      entidadId   : null,
      metadata    : {
        provider             : generation.provider,
        model                : generation.model,
        promptLen            : prompt.length,
        enrichedPromptLen    : enrichedPrompt.length,
        fallback             : generation.fallback === true,
        intent               : analysis.intent,
        entityCount          : analysis.entities.length,
        analysisSource       : analysis._source,
        validationStatus     : validation.status,
        suggestedIntegrations: integrations.suggested.length,
      },
    });

    return res.json({
      orchestration: {
        pipelineVersion: '2.0',
        stages: [
          {
            key   : 'interpret_requirement',
            label : 'Interpretar requerimiento',
            status: analysis._source === 'fallback' ? 'completed_with_warnings' : 'completed',
            detail: {
              intent           : analysis.intent,
              summary          : analysis.summary,
              goals            : analysis.goals,
              entities         : analysis.entities,
              constraints      : analysis.constraints,
              flow_type        : analysis.flow_type,
              tone             : analysis.tone,
              error_handling   : analysis.error_handling,
              estimated_screens: analysis.estimated_screens,
              source           : analysis._source || 'llm',
            },
          },
          {
            key   : 'synthesize_flow',
            label : 'Proponer flujo estructurado',
            status: 'completed',
            detail: { screenCount, enrichedPromptLen: enrichedPrompt.length },
          },
          {
            key   : 'integration_mapping',
            label : 'Sugerir integraciones',
            status: 'completed',
            detail: { catalogSize: integrations.catalogSize, suggested: topEndpoints.length },
          },
          {
            key   : 'validate_logic',
            label : 'Validar logica',
            status: stageStatus,
            detail: { errors: validation.errors.length, warnings: validation.warnings.length },
          },
          { key: 'simulate', label: 'Simular ejecucion', status: 'ready' },
        ],
      },
      proposal: {
        flowJson: generation.json,
        summary : { screenCount },
      },
      integrations: {
        suggested  : integrations.suggested,
        catalogSize: integrations.catalogSize,
      },
      dataContract,
      validation,
      simulation: {
        channels   : ['waba', 'web'],
        dryRunReady: true,
      },
      approval: {
        required: true,
        status  : 'pending_human_approval',
      },
      legacy: {
        json    : generation.json,
        provider: generation.provider,
        model   : generation.model,
        warning : generation.warning,
        fallback: generation.fallback === true,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Requirement intelligence ──────────────────────────────────────────────────

const REQUIREMENT_ANALYSIS_SYSTEM = `You are an enterprise conversational flow architect.
Analyze the user's natural-language requirement and extract a precise structure.
Always respond with valid JSON only — no explanation, no markdown fences.

Return schema:
{
  "intent": "short_snake_case_intent_id",
  "summary": "one sentence description in Spanish",
  "goals": ["goal1", "goal2"],
  "entities": [{ "name": "field_name", "type": "text|number|date|email|phone|select|boolean", "required": true, "description": "brief" }],
  "constraints": ["constraint1"],
  "suggested_integrations": ["integration_keyword1"],
  "data_collection": "single|multiple|none",
  "tone": "professional|casual|formal|friendly",
  "error_handling": "retry|human_fallback|silent_skip|none",
  "flow_type": "linear|branched|conditional|hybrid",
  "estimated_screens": 3
}`;

/**
 * Stage 1 — LLM-based requirement analysis.
 * Returns a validated/normalised structure; falls back deterministically if the LLM
 * is unavailable so the pipeline never blocks on the first stage.
 */
async function analyzeRequirement(tenantId, prompt) {
  const VALID_TYPES    = ['text', 'number', 'date', 'email', 'phone', 'select', 'boolean'];
  const VALID_DC       = ['single', 'multiple', 'none'];
  const VALID_TONE     = ['professional', 'casual', 'formal', 'friendly'];
  const VALID_HANDLING = ['retry', 'human_fallback', 'silent_skip', 'none'];
  const VALID_FTYPE    = ['linear', 'branched', 'conditional', 'hybrid'];

  const result = await callLlmForJson(tenantId, REQUIREMENT_ANALYSIS_SYSTEM, prompt);

  if (!result || typeof result.json !== 'object' || !result.json) {
    // Deterministic fallback so the pipeline always completes
    return {
      intent            : 'generic_flow',
      summary           : 'Flujo conversacional general',
      goals             : ['capturar datos', 'confirmar solicitud'],
      entities          : [
        { name: 'nombre',  type: 'text', required: true,  description: 'Nombre del usuario'           },
        { name: 'detalle', type: 'text', required: true,  description: 'Detalle de la solicitud'       },
      ],
      constraints           : [],
      suggested_integrations: [],
      data_collection   : 'multiple',
      tone              : 'professional',
      error_handling    : 'human_fallback',
      flow_type         : 'linear',
      estimated_screens : 3,
      _source           : 'fallback',
    };
  }

  const j = result.json;
  return {
    intent: String(j.intent || 'generic_flow')
      .toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60),
    summary: String(j.summary || '').trim().slice(0, 300),
    goals  : Array.isArray(j.goals)
      ? j.goals.map((g) => String(g).trim()).filter(Boolean).slice(0, 10)
      : [],
    entities: Array.isArray(j.entities)
      ? j.entities.slice(0, 20).map((e) => ({
          name       : String(e?.name || 'field').replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 60),
          type       : VALID_TYPES.includes(e?.type) ? e.type : 'text',
          required   : e?.required !== false,
          description: String(e?.description || '').trim().slice(0, 100),
        }))
      : [],
    constraints: Array.isArray(j.constraints)
      ? j.constraints.map((c) => String(c).trim()).filter(Boolean).slice(0, 10)
      : [],
    suggested_integrations: Array.isArray(j.suggested_integrations)
      ? j.suggested_integrations.map((s) => String(s).trim()).filter(Boolean).slice(0, 5)
      : [],
    data_collection   : VALID_DC.includes(j.data_collection)   ? j.data_collection   : 'multiple',
    tone              : VALID_TONE.includes(j.tone)             ? j.tone              : 'professional',
    error_handling    : VALID_HANDLING.includes(j.error_handling) ? j.error_handling : 'human_fallback',
    flow_type         : VALID_FTYPE.includes(j.flow_type)       ? j.flow_type         : 'linear',
    estimated_screens : Math.max(1, Math.min(20,
      Number.isInteger(j.estimated_screens) ? j.estimated_screens : 3)),
    _source  : 'llm',
    _provider: result.provider,
    _model   : result.model,
  };
}

/**
 * Build an enriched generation prompt that includes the extracted requirement
 * structure and the top catalog endpoints as inline context for the flow LLM.
 */
function buildEnrichedPrompt(prompt, analysis, topEndpoints) {
  const lines = [
    '=== REQUERIMIENTO DEL USUARIO ===',
    prompt.trim(),
    '',
    '=== INTENCIÓN DETECTADA ===',
    `Intent: ${analysis.intent}`,
    `Tipo de flujo: ${analysis.flow_type}`,
    `Tono: ${analysis.tone}`,
    `Manejo de errores: ${analysis.error_handling}`,
    `Pantallas estimadas: ${analysis.estimated_screens}`,
  ];

  if (analysis.goals.length > 0) {
    lines.push('', '=== OBJETIVOS ===');
    analysis.goals.forEach((g) => lines.push(`- ${g}`));
  }

  if (analysis.entities.length > 0) {
    lines.push(
      '',
      '=== CAMPOS DE DATOS REQUERIDOS (usa estos nombres de campo exactamente en los inputs) ===',
    );
    analysis.entities.forEach((e) => {
      lines.push(
        `- ${e.name} [${e.type}]${e.required ? ' (obligatorio)' : ' (opcional)'}: ${e.description}`,
      );
    });
  }

  if (analysis.constraints.length > 0) {
    lines.push('', '=== RESTRICCIONES DE NEGOCIO ===');
    analysis.constraints.forEach((c) => lines.push(`- ${c}`));
  }

  if (topEndpoints.length > 0) {
    lines.push(
      '',
      '=== APIs DISPONIBLES EN EL CATÁLOGO (incluye llamadas webhook cuando sea relevante) ===',
    );
    topEndpoints.forEach((ep) => {
      lines.push(`- ${ep.name} [${ep.method} ${ep.url}]: ${ep.description || ''}`);
      if (ep.inputs.length  > 0) lines.push(`  inputs: ${ep.inputs.join(', ')}`);
      if (ep.outputs.length > 0) lines.push(`  outputs: ${ep.outputs.join(', ')}`);
    });
  }

  return lines.join('\n');
}

/**
 * Build the unified data contract from the requirement analysis and catalog suggestions.
 * user_input  — fields to collect from the end-user, keyed by entity name
 * api_responses — expected outputs from each relevant catalog endpoint
 * context_memory — intent metadata persisted across screens
 * validated_data — empty placeholder, filled at runtime after validations
 */
function buildDataContract(analysis, topEndpoints) {
  const user_input = {};
  for (const entity of analysis.entities) {
    user_input[entity.name] = {
      type       : entity.type,
      required   : entity.required,
      description: entity.description,
    };
  }

  const api_responses = {};
  for (const ep of topEndpoints) {
    api_responses[ep.id] = {
      endpoint: ep.name,
      method  : ep.method,
      outputs : ep.outputs,
    };
  }

  const context_memory = {
    flow_intent   : analysis.intent,
    flow_type     : analysis.flow_type,
    tone          : analysis.tone,
    error_handling: analysis.error_handling,
    goals         : analysis.goals,
    constraints   : analysis.constraints,
  };

  return { user_input, validated_data: {}, api_responses, context_memory };
}

async function generateFlowOrFallback(req, tenantId, prompt) {
  let resolvedTenantId = tenantId;
  let result = await generateFlow(resolvedTenantId, prompt);

  if (!result && req.admin.superAdmin) {
    const fallbackCfg = await prisma.configuracion.findFirst({
      where: { clave: 'llm_config', tenantId: { not: resolvedTenantId } },
      select: { tenantId: true },
      orderBy: { id: 'asc' },
    });
    if (fallbackCfg?.tenantId) {
      logger.warn({ fromTenantId: resolvedTenantId, toTenantId: fallbackCfg.tenantId }, 'llm/design-intelligent-flow: trying fallback tenant with llm_config');
      const fallbackResult = await generateFlow(fallbackCfg.tenantId, prompt);
      if (fallbackResult) {
        resolvedTenantId = fallbackCfg.tenantId;
        result = fallbackResult;
      }
    }
  }

  if (result) {
    return {
      resolvedTenantId,
      json: result.json,
      provider: result.provider,
      model: result.model,
      fallback: false,
      warning: null,
    };
  }

  const cfg = await getLlmConfig(resolvedTenantId);
  const warning = !cfg
    ? 'LLM no configurado o no disponible. Se generó un flujo base para que puedas continuar.'
    : 'Proveedor LLM temporalmente no disponible. Se generó un flujo base para que puedas continuar.';

  return {
    resolvedTenantId,
    json: buildDeterministicFallbackFlow(prompt),
    provider: 'fallback',
    model: 'deterministic-v1',
    fallback: true,
    warning,
  };
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4);
}

function scoreEndpoint(endpoint, prompt) {
  const promptTokens = new Set(tokenize(prompt));
  const source = [
    endpoint?.id,
    endpoint?.name,
    endpoint?.description,
    ...(Array.isArray(endpoint?.inputs) ? endpoint.inputs : []),
    ...(Array.isArray(endpoint?.outputs) ? endpoint.outputs : []),
  ].join(' ');
  return tokenize(source).reduce((acc, token) => acc + (promptTokens.has(token) ? 1 : 0), 0);
}

async function buildIntegrationSuggestions(tenantId, prompt) {
  const catalog = await getCatalog(tenantId);
  const endpoints = Array.isArray(catalog?.endpoints) ? catalog.endpoints : [];

  const suggested = endpoints
    .map((endpoint) => ({ endpoint, score: scoreEndpoint(endpoint, prompt) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => ({
      id: item.endpoint.id,
      name: item.endpoint.name,
      method: item.endpoint.method,
      url: item.endpoint.url,
      inputs: Array.isArray(item.endpoint.inputs) ? item.endpoint.inputs : [],
      outputs: Array.isArray(item.endpoint.outputs) ? item.endpoint.outputs : [],
      description: item.endpoint.description,
      score: item.score,
    }));

  return { suggested, catalogSize: endpoints.length };
}

function buildValidationSummary(flowJson, analysis) {
  const validation = validateWabaJson(flowJson);
  const hasErrors = Array.isArray(validation?.errors) && validation.errors.length > 0;
  const hasWarnings = Array.isArray(validation?.warnings) && validation.warnings.length > 0;

  // Data-completeness check: verify that every required entity has at least one
  // matching input component across the generated screens.
  const completeness = { covered: [], missing: [] };
  if (analysis && Array.isArray(analysis.entities) && analysis.entities.length > 0) {
    const allInputNames = new Set();
    const screens = Array.isArray(flowJson?.screens) ? flowJson.screens : [];
    for (const screen of screens) {
      collectComponentNames(screen?.layout?.children || [], allInputNames);
    }
    for (const entity of analysis.entities) {
      const nameLower = entity.name.toLowerCase();
      const covered = [...allInputNames].some(
        (n) => n.toLowerCase() === nameLower ||
               n.toLowerCase().includes(nameLower) ||
               nameLower.includes(n.toLowerCase()),
      );
      if (covered) {
        completeness.covered.push(entity.name);
      } else {
        completeness.missing.push({
          field  : entity.name,
          type   : entity.type,
          required: entity.required,
          message: `Campo '${entity.name}' no encontrado en ningun input del flujo generado`,
        });
      }
    }
  }

  const missingRequired = completeness.missing.filter((m) => m.required);
  const missingOptional = completeness.missing.filter((m) => !m.required);
  const effectiveStatus = hasErrors || missingRequired.length > 0
    ? 'failed'
    : (hasWarnings || missingOptional.length > 0) ? 'passed_with_warnings' : 'passed';

  return {
    status  : effectiveStatus,
    errors  : validation.errors || [],
    warnings: [
      ...(validation.warnings || []),
      ...missingOptional.map((m) => ({ code: 'MISSING_OPTIONAL_FIELD', message: m.message, field: m.field })),
    ],
    completeness_errors: missingRequired.map((m) => ({ code: 'MISSING_REQUIRED_FIELD', message: m.message, field: m.field })),
    covered_fields: completeness.covered,
  };
}

/** Recursively collect all `name` attributes from layout components. */
function collectComponentNames(children, nameSet) {
  if (!Array.isArray(children)) return;
  for (const child of children) {
    if (child?.name) nameSet.add(String(child.name));
    if (Array.isArray(child?.children))   collectComponentNames(child.children, nameSet);
    if (Array.isArray(child?.['data-source'])) {
      for (const ds of child['data-source']) {
        if (ds?.id) nameSet.add(String(ds.id));
      }
    }
  }
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return { raw: str }; }
}

function buildDeterministicFallbackFlow(prompt) {
  const cleanPrompt = String(prompt || '').trim().slice(0, 220);
  const intro = cleanPrompt
    ? `Te ayudo con tu solicitud: ${cleanPrompt}. Elige una opcion para continuar.`
    : 'Te ayudo con tu solicitud. Elige una opcion para continuar.';

  return {
    version: '7.1',
    data_api_version: '3.0',
    routing_model: {
      INIT: ['CAPTURAR_DATOS', 'SOPORTE_HUMANO', 'CIERRE'],
      CAPTURAR_DATOS: ['CIERRE'],
      SOPORTE_HUMANO: ['CIERRE'],
      CIERRE: [],
    },
    screens: [
      {
        id: 'INIT',
        title: 'Bienvenida',
        terminal: false,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: 'Inicio' },
            { type: 'TextBody', text: intro },
            {
              type: 'RadioButtonsGroup',
              name: 'accion',
              label: 'Como prefieres continuar?',
              'data-source': [
                { id: 'capturar_datos', title: 'Completar datos' },
                { id: 'soporte_humano', title: 'Hablar con soporte' },
                { id: 'cerrar', title: 'Finalizar' },
              ],
            },
            { type: 'Footer', label: 'Continuar', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'CAPTURAR_DATOS' } } },
          ],
        },
      },
      {
        id: 'CAPTURAR_DATOS',
        title: 'Datos',
        terminal: false,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: 'Datos principales' },
            { type: 'TextBody', text: 'Comparte la informacion clave para completar tu solicitud.' },
            { type: 'TextInput', name: 'nombre', label: 'Nombre' },
            { type: 'TextInput', name: 'detalle', label: 'Detalle de la solicitud' },
            { type: 'Footer', label: 'Enviar', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'CIERRE' } } },
          ],
        },
      },
      {
        id: 'SOPORTE_HUMANO',
        title: 'Soporte',
        terminal: false,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: 'Soporte humano' },
            { type: 'TextBody', text: 'Te conectaremos con un agente para continuar.' },
            { type: 'Footer', label: 'Continuar', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'CIERRE' } } },
          ],
        },
      },
      {
        id: 'CIERRE',
        title: 'Listo',
        terminal: true,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: 'Solicitud recibida' },
            { type: 'TextBody', text: 'Gracias. Tu solicitud fue registrada.' },
            { type: 'Footer', label: 'Finalizar', 'on-click-action': { name: 'complete' } },
          ],
        },
      },
    ],
  };
}

// ── POST /llm/simulate-flow ───────────────────────────────────────────────────
// Dry-run simulation of a Meta WABA flow JSON without real HTTP calls.
// Accepts the flowJson + dataContract from design-intelligent-flow response.

router.post('/simulate-flow', requirePermiso('MANAGE_LLM_RESCUE'), [
  body('flowJson').notEmpty().withMessage('flowJson is required'),
  body('tenantId').optional({ checkFalsy: true }).isUUID(),
], async (req, res, next) => {
  if (!validateRequest(req, res)) return;
  try {
    const tenantId = await resolveTenantId(req, req.body.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    let flowJson = req.body.flowJson;
    if (typeof flowJson === 'string') {
      try { flowJson = JSON.parse(flowJson); } catch (e) {
        return res.status(400).json({ error: 'flowJson must be valid JSON' });
      }
    }
    if (!flowJson || typeof flowJson !== 'object') {
      return res.status(400).json({ error: 'flowJson must be an object' });
    }

    const dataContract = req.body.dataContract && typeof req.body.dataContract === 'object'
      ? req.body.dataContract
      : {};

    logger.info({ tenantId }, 'llm/simulate-flow: starting dry-run');

    const simulation = simulateDryRun(flowJson, dataContract);

    audit({
      adminUserId: req.admin.adminUserId,
      tenantId,
      accion     : 'SIMULATE_FLOW',
      entidad    : 'flow',
      entidadId  : null,
      metadata   : { steps: simulation.summary.totalSteps, terminal: simulation.summary.terminal },
    });

    return res.json({ simulation });
  } catch (err) { next(err); }
});

// ── Dry-run simulation helpers ────────────────────────────────────────────────

const MOCK_VALUE_BY_TYPE = {
  text   : (name) => `[${name}_simulado]`,
  number : ()     => 42,
  date   : ()     => new Date().toISOString().slice(0, 10),
  email  : ()     => 'usuario@ejemplo.com',
  phone  : ()     => '+521234567890',
  select : (name) => `opcion_1`,
  boolean: ()     => true,
};

function generateMockValue(type, name) {
  const fn = MOCK_VALUE_BY_TYPE[type] || MOCK_VALUE_BY_TYPE.text;
  return fn(name);
}

function buildMockInputsFromContract(userInput) {
  const mocks = {};
  for (const [field, meta] of Object.entries(userInput || {})) {
    mocks[field] = generateMockValue(meta?.type || 'text', field);
  }
  return mocks;
}

function collectScreenInputs(children) {
  const inputs = [];
  if (!Array.isArray(children)) return inputs;
  for (const child of children) {
    const inputTypes = ['TextInput', 'TextArea', 'DatePicker', 'RadioButtonsGroup',
                        'CheckboxGroup', 'Dropdown', 'OptIn'];
    if (inputTypes.includes(child?.type) && child?.name) {
      inputs.push({ name: child.name, type: child.type, label: child.label || child.name });
    }
    if (Array.isArray(child?.children)) inputs.push(...collectScreenInputs(child.children));
  }
  return inputs;
}

function collectScreenWebhooks(children) {
  const webhooks = [];
  if (!Array.isArray(children)) return webhooks;
  for (const child of children) {
    const action = child?.['on-click-action'];
    if (action?.payload?.extension_message_response?.params?.flow_token) {
      webhooks.push({ component: child.type, action: action.name });
    }
    if (Array.isArray(child?.children)) webhooks.push(...collectScreenWebhooks(child.children));
  }
  return webhooks;
}

function buildWabaView(screen) {
  const children = screen?.layout?.children || [];
  const parts = [];
  for (const child of children) {
    if (child?.type === 'TextHeading')  parts.push({ kind: 'heading',  text: child.text });
    if (child?.type === 'TextSubheading') parts.push({ kind: 'subheading', text: child.text });
    if (child?.type === 'TextBody')     parts.push({ kind: 'body',     text: child.text });
    if (child?.type === 'TextInput')    parts.push({ kind: 'input',    label: child.label, name: child.name });
    if (child?.type === 'TextArea')     parts.push({ kind: 'textarea', label: child.label, name: child.name });
    if (child?.type === 'DatePicker')   parts.push({ kind: 'date',     label: child.label, name: child.name });
    if (child?.type === 'RadioButtonsGroup') {
      parts.push({
        kind   : 'radio',
        label  : child.label,
        name   : child.name,
        options: (child['data-source'] || []).map((o) => o.title || o.id),
      });
    }
    if (child?.type === 'Footer') parts.push({ kind: 'footer', label: child.label });
  }
  return parts;
}

function simulateDryRun(flowJson, dataContract, maxSteps = 15) {
  const screens = Array.isArray(flowJson?.screens) ? flowJson.screens : [];
  if (screens.length === 0) {
    return {
      steps  : [],
      summary: { totalSteps: 0, terminal: false, error: 'No screens found in flowJson' },
    };
  }

  const routing    = flowJson?.routing_model || {};
  const mockInputs = buildMockInputsFromContract(dataContract?.user_input || {});
  const transcript = [];

  let currentScreenId = screens[0].id;
  const visited = new Set();

  for (let step = 1; step <= maxSteps; step++) {
    if (visited.has(currentScreenId)) {
      transcript.push({
        step,
        screenId : currentScreenId,
        warning  : 'Ciclo detectado — simulacion detenida',
        terminal : true,
      });
      break;
    }
    visited.add(currentScreenId);

    const screen = screens.find((s) => s.id === currentScreenId);
    if (!screen) break;

    const children      = screen?.layout?.children || [];
    const inputsInScreen = collectScreenInputs(children);
    const webhooks      = collectScreenWebhooks(children);

    const providedInputs = {};
    for (const inp of inputsInScreen) {
      providedInputs[inp.name] =
        mockInputs[inp.name] ??
        generateMockValue(
          inp.type === 'DatePicker' ? 'date' :
          inp.type === 'RadioButtonsGroup' ? 'select' : 'text',
          inp.name,
        );
    }

    // Next screen: use routing_model first, then footer on-click-action
    const possibleNext = Array.isArray(routing[currentScreenId])
      ? routing[currentScreenId]
      : [];
    let nextScreenId = possibleNext.length > 0 ? possibleNext[0] : null;
    if (!nextScreenId) {
      for (const child of children) {
        const nav = child?.['on-click-action']?.next?.name ||
                    child?.['on-click-action']?.next?.id;
        if (nav) { nextScreenId = nav; break; }
      }
    }

    const isTerminal = screen.terminal === true || !nextScreenId ||
                       nextScreenId === currentScreenId;

    transcript.push({
      step,
      screenId       : currentScreenId,
      screenTitle    : screen.title || currentScreenId,
      inputs_in_screen: inputsInScreen.map((i) => ({ name: i.name, label: i.label })),
      provided_inputs : providedInputs,
      webhooks_detected: webhooks.length > 0 ? webhooks : undefined,
      mock_webhook_response: webhooks.length > 0
        ? { status: 200, body: { ok: true, message: '[mock response]' } }
        : undefined,
      next_screen_id : isTerminal ? null : nextScreenId,
      terminal       : isTerminal,
      channel        : { waba: buildWabaView(screen) },
    });

    if (isTerminal) break;
    currentScreenId = nextScreenId;
  }

  return {
    steps  : transcript,
    summary: {
      totalSteps      : transcript.length,
      screensTraversed: transcript.map((t) => t.screenId),
      terminal        : transcript[transcript.length - 1]?.terminal ?? false,
      mockInputsUsed  : mockInputs,
    },
  };
}

module.exports = router;
