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
// Enterprise-ready orchestration response with backward-compatible payload.

router.post('/design-intelligent-flow', requirePermiso('MANAGE_LLM_RESCUE'), [
  body('prompt').notEmpty().withMessage('prompt is required').isLength({ max: 10000 }),
  body('tenantId').optional({ checkFalsy: true }).isUUID(),
], async (req, res, next) => {
  if (!validateRequest(req, res)) return;
  try {
    const tenantId = await resolveTenantId(req, req.body.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const { prompt } = req.body;
    logger.info({ tenantId, promptLen: prompt.length }, 'llm/design-intelligent-flow: designing');

    const generation = await generateFlowOrFallback(req, tenantId, prompt);
    const validation = buildValidationSummary(generation.json);
    const integrations = await buildIntegrationSuggestions(generation.resolvedTenantId, prompt);
    const stageStatus = validation.status === 'failed'
      ? 'failed'
      : validation.status === 'passed_with_warnings'
        ? 'completed_with_warnings'
        : 'completed';
    const screenCount = Array.isArray(generation.json?.screens) ? generation.json.screens.length : 0;

    audit({
      adminUserId : req.admin.adminUserId,
      tenantId: generation.resolvedTenantId,
      accion      : 'DESIGN_INTELLIGENT_FLOW',
      entidad     : 'flow',
      entidadId   : null,
      metadata    : {
        provider: generation.provider,
        model: generation.model,
        promptLen: prompt.length,
        fallback: generation.fallback === true,
        validationStatus: validation.status,
        suggestedIntegrations: integrations.suggested.length,
      },
    });

    return res.json({
      orchestration: {
        pipelineVersion: '1.0',
        stages: [
          { key: 'interpret_requirement', label: 'Interpretar requerimiento', status: 'completed' },
          { key: 'synthesize_flow', label: 'Proponer flujo estructurado', status: 'completed' },
          { key: 'integration_mapping', label: 'Sugerir integraciones', status: 'completed' },
          { key: 'validate_logic', label: 'Validar logica', status: stageStatus },
          { key: 'simulate', label: 'Simular ejecucion', status: 'ready' },
        ],
      },
      proposal: {
        flowJson: generation.json,
        summary: { screenCount },
      },
      integrations: {
        suggested: integrations.suggested,
        catalogSize: integrations.catalogSize,
      },
      dataContract: {
        user_input: {},
        validated_data: {},
        api_responses: {},
        context_memory: {},
      },
      validation,
      simulation: {
        channels: ['waba', 'web'],
        dryRunReady: true,
      },
      approval: {
        required: true,
        status: 'pending_human_approval',
      },
      legacy: {
        json: generation.json,
        provider: generation.provider,
        model: generation.model,
        warning: generation.warning,
        fallback: generation.fallback === true,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function buildValidationSummary(flowJson) {
  const validation = validateWabaJson(flowJson);
  const hasErrors = Array.isArray(validation?.errors) && validation.errors.length > 0;
  const hasWarnings = Array.isArray(validation?.warnings) && validation.warnings.length > 0;
  return {
    status: hasErrors ? 'failed' : hasWarnings ? 'passed_with_warnings' : 'passed',
    errors: validation.errors || [],
    warnings: validation.warnings || [],
  };
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

module.exports = router;
