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
const { getLlmStatus, generateFlow } = require('../services/llmService');
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
 * SuperAdmins may pass an explicit tenantId; if none provided, falls back to
 * the first available tenant so the LLM features work without a scoped user.
 */
async function resolveTenantId(req, explicitId) {
  if (req.admin.superAdmin) {
    if (explicitId) return explicitId;
    if (req.admin.tenantId) return req.admin.tenantId;
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

// ── POST /llm/generate-flow ──────────────────────────────────────────────────
// Generate a Meta WhatsApp Flow JSON from a natural language prompt using LLM.

router.post('/generate-flow', requirePermiso('MANAGE_LLM_RESCUE'), [
  body('prompt').notEmpty().withMessage('prompt is required').isLength({ max: 2000 }),
  body('tenantId').optional({ checkFalsy: true }).isUUID(),
], async (req, res, next) => {
  if (!validateRequest(req, res)) return;
  try {
    const tenantId = await resolveTenantId(req, req.body.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

    const { prompt } = req.body;
    logger.info({ tenantId, promptLen: prompt.length }, 'llm/generate-flow: generating');

    const result = await generateFlow(tenantId, prompt);
    if (!result) {
      return res.status(503).json({ error: 'LLM not configured or unavailable for this tenant' });
    }

    audit({
      adminUserId : req.admin.adminUserId,
      tenantId,
      accion      : 'GENERATE_FLOW',
      entidad     : 'flow',
      entidadId   : null,
      metadata    : { provider: result.provider, model: result.model, promptLen: prompt.length },
    });

    res.json({ json: result.json, provider: result.provider, model: result.model });
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return { raw: str }; }
}

module.exports = router;
