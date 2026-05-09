'use strict';
/**
 * GET /conversations          — paginated list for a tenant (admin)
 * GET /conversations/:id      — single conversation with event timeline
 * GET /conversations/:id/events — timeline only (for lazy loading)
 * PATCH /conversations/:id    — mark as abandoned/completed (manual override)
 *
 * All routes require JWT + tenant context.
 * tenantId is derived from the JWT payload (req.user.tenantId).
 */

const express    = require('express');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');

const router = express.Router();
const prisma = new PrismaClient();

// All conversation routes require a valid JWT
router.use(requireJwt);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveTenantId(req, explicitTenantSlug) {
  const fromAuth =
    req.admin?.tenantId ??
    req.admin?.tenant_id ??
    req.user?.tenantId ??
    req.user?.tenant_id;
  if (fromAuth) return fromAuth;

  const isSuperAdmin = Boolean(req.admin?.superAdmin ?? req.user?.superAdmin);
  if (!isSuperAdmin) return null;

  const slug = typeof explicitTenantSlug === 'string' ? explicitTenantSlug.trim() : '';
  if (!slug) return null;

  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true },
  });
  return tenant?.id ?? null;
}

/** Parse a safe positive integer from a query param, with a default. */
function parseIntParam(val, def, max = 200) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n) || n < 1) return def;
  return Math.min(n, max);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Query params:
 *   page     (default 1)
 *   limit    (default 20, max 100)
 *   status   'active' | 'completed' | 'abandoned' | 'error'
 *   flowId   integer
 *   userKey  exact phone / session key
 *   from     ISO date  (startedAt >=)
 *   to       ISO date  (startedAt <=)
 *
 * Response:
 *   {
 *     data: [ { id, userKey, flowId, flowVersionId, status, startedAt, endedAt,
 *               durationSec, eventCount } ],
 *     total, page, limit
 *   }
 */
router.get('/', async (req, res, next) => {
  try {
    const tid   = await resolveTenantId(req, req.query.tenantSlug);
    if (!tid) return res.status(401).json({ error: 'Tenant context missing' });

    const page  = parseIntParam(req.query.page,  1);
    const limit = parseIntParam(req.query.limit, 20, 100);
    const skip  = (page - 1) * limit;

    // Build where clause
    const where = { tenantId: tid };
    if (req.query.status) where.status = req.query.status;
    if (req.query.flowId) {
      const fid = parseInt(req.query.flowId, 10);
      if (!Number.isNaN(fid)) where.flowId = fid;
    }
    if (req.query.userKey) where.userKey = req.query.userKey;
    if (req.query.from || req.query.to) {
      where.startedAt = {};
      if (req.query.from) where.startedAt.gte = new Date(req.query.from);
      if (req.query.to)   where.startedAt.lte = new Date(req.query.to);
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        skip,
        take   : limit,
        orderBy: { startedAt: 'desc' },
        include: {
          flow: { select: { id: true, nombre: true } },
          _count: { select: { events: true } },
          solicitudes: {
            select: {
              id: true,
              titulo: true,
              estado: true,
              prioridad: true,
              origin: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      prisma.conversation.count({ where }),
    ]);

    const data = conversations.map(c => ({
      id            : c.id,
      userKey       : c.userKey,
      flow          : c.flow ? { id: c.flow.id, nombre: c.flow.nombre } : null,
      flowVersionId : c.flowVersionId,
      status        : c.status,
      startedAt     : c.startedAt,
      endedAt       : c.endedAt,
      durationSec   : c.endedAt
        ? Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000)
        : null,
      eventCount    : c._count.events,
      solicitudes   : c.solicitudes,
    }));

    return res.json({ data, total, page, limit });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns the conversation record + all events (timeline).
 * Scoped to the tenant from JWT — cannot view other tenants.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const tid = await resolveTenantId(req, req.query.tenantSlug);
    if (!tid) return res.status(401).json({ error: 'Tenant context missing' });

    const conversation = await prisma.conversation.findFirst({
      where  : { id: req.params.id, tenantId: tid },
      include: {
        flow        : { select: { id: true, nombre: true } },
        flowVersion : { select: { id: true, versionNumber: true, publishedAt: true } },
        events      : {
          orderBy: { createdAt: 'asc' },
          select : { id: true, nodeRef: true, eventType: true, payload: true, createdAt: true },
        },
        solicitudes: {
          orderBy: { createdAt: 'desc' },
          include: {
            agente: { select: { id: true, nombre: true, email: true, estado: true } },
            user: { select: { id: true, phone: true } },
          },
        },
      },
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    return res.json(conversation);
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /conversations/:id/events
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Query params:
 *   eventType  filter by single event type
 *   after      ISO date — only events after this timestamp
 *   limit      default 200, max 500
 */
router.get('/:id/events', async (req, res, next) => {
  try {
    const tid = await resolveTenantId(req, req.query.tenantSlug);
    if (!tid) return res.status(401).json({ error: 'Tenant context missing' });

    // Verify conversation belongs to tenant
    const conv = await prisma.conversation.findFirst({
      where : { id: req.params.id, tenantId: tid },
      select: { id: true },
    });
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    const limit = parseIntParam(req.query.limit, 200, 500);
    const where = { conversationId: req.params.id };
    if (req.query.eventType) where.eventType = req.query.eventType;
    if (req.query.after)     where.createdAt = { gt: new Date(req.query.after) };

    const events = await prisma.conversationEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take   : limit,
      select : { id: true, nodeRef: true, eventType: true, payload: true, createdAt: true },
    });

    return res.json({ data: events, count: events.length });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /conversations/:id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Manual status override by admin (e.g. force-close an abandoned session).
 * Body: { status: 'completed' | 'abandoned' | 'error' }
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const tid = await resolveTenantId(req, req.body?.tenantSlug ?? req.query?.tenantSlug);
    if (!tid) return res.status(401).json({ error: 'Tenant context missing' });

    const { status } = req.body ?? {};
    const allowed    = ['completed', 'abandoned', 'error'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }

    const updated = await prisma.conversation.updateMany({
      where: { id: req.params.id, tenantId: tid },
      data : {
        status,
        endedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
