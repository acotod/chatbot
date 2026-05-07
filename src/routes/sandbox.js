'use strict';

const express = require('express');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const db = require('../services/database');
const { audit } = require('../services/audit');
const whatsappRouter = require('./whatsapp');
const { getPrismaClient } = require('../services/database');

const router = express.Router();

const SANDBOX_PERMISSION = 'VIEW_SANDBOX';

router.use(requireJwt);
router.use(requirePermiso(SANDBOX_PERMISSION));

function resolveTenantId(req, body) {
  if (req.admin?.superAdmin) {
    return body?.tenantId ?? null;
  }
  return req.admin?.tenantId ?? null;
}

async function resolveTenant(req, source) {
  const directTenantId = resolveTenantId(req, source);
  if (directTenantId) {
    return { tenantId: directTenantId, tenant: { id: directTenantId } };
  }

  const tenantSlug = typeof source?.tenantSlug === 'string' ? source.tenantSlug.trim() : '';
  if (!tenantSlug) {
    return { tenantId: null, tenant: null };
  }

  const tenant = await db.findTenantBySlug(tenantSlug);
  return {
    tenantId: tenant?.id ?? null,
    tenant,
  };
}

function parseLimit(value, fallback = 10, max = 50) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function buildUserKeyVariants(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];

  const digits = raw.replace(/\D+/g, '');
  const variants = [raw];

  if (digits && !variants.includes(digits)) {
    variants.push(digits);
  }

  const withPlus = digits ? `+${digits}` : null;
  if (withPlus && !variants.includes(withPlus)) {
    variants.push(withPlus);
  }

  return variants;
}

function sandboxConversationWhere(tenantId, userKey) {
  const where = {
    tenantId,
    context: { path: ['meta', 'sandbox'], equals: true },
  };

  const userKeys = buildUserKeyVariants(userKey);
  if (userKeys.length === 1) {
    where.userKey = userKeys[0];
  } else if (userKeys.length > 1) {
    where.userKey = { in: userKeys };
  }

  return where;
}

async function findLatestSandboxConversation({ tenantId, userKey }) {
  const prisma = getPrismaClient();
  return prisma.conversation.findFirst({
    where: sandboxConversationWhere(tenantId, userKey),
    orderBy: { startedAt: 'desc' },
    select: { id: true, status: true, startedAt: true },
  });
}

async function waitForSandboxConversation({ tenantId, userKey, maxAttempts = 8, delayMs = 200 }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const conversation = await findLatestSandboxConversation({ tenantId, userKey });
    if (conversation) {
      return conversation;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

router.get('/runs', async (req, res, next) => {
  try {
    const { tenantId } = await resolveTenant(req, req.query);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId or tenantSlug is required' });
    }

    const userKey = typeof req.query.userKey === 'string' ? req.query.userKey.trim() : '';
    if (!userKey) {
      return res.status(400).json({ error: 'userKey is required' });
    }

    const prisma = getPrismaClient();
    const limit = parseLimit(req.query.limit, 10, 25);
    const runs = await prisma.conversation.findMany({
      where: sandboxConversationWhere(tenantId, userKey),
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        flow: { select: { id: true, nombre: true } },
        _count: { select: { events: true } },
      },
    });

    return res.json({
      ok: true,
      data: runs.map((run) => ({
        id: run.id,
        userKey: run.userKey,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        flow: run.flow,
        flowVersionId: run.flowVersionId,
        eventCount: run._count.events,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/runs/:id', async (req, res, next) => {
  try {
    const { tenantId } = await resolveTenant(req, req.query);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId or tenantSlug is required' });
    }

    const prisma = getPrismaClient();
    const run = await prisma.conversation.findFirst({
      where: {
        ...sandboxConversationWhere(tenantId),
        id: req.params.id,
      },
      include: {
        flow: { select: { id: true, nombre: true } },
        flowVersion: { select: { id: true, versionNumber: true, publishedAt: true } },
        events: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, nodeRef: true, eventType: true, payload: true, createdAt: true },
        },
      },
    });

    if (!run) {
      return res.status(404).json({ error: 'Sandbox run not found' });
    }

    return res.json({ ok: true, data: run });
  } catch (err) {
    next(err);
  }
});

router.get('/capabilities', async (req, res, next) => {
  try {
    const tenantId = req.admin?.superAdmin ? null : (req.admin?.tenantId ?? null);
    return res.json({
      ok: true,
      sandbox: {
        permission: SANDBOX_PERMISSION,
        runtime: {
          webhookInbound: true,
          chatbotRouter: true,
          flowEngine: true,
          nodeExecutors: true,
          integrationRunner: true,
          outboundMetaMock: false,
          replay: false,
          compliance: false,
        },
        tenantScope: tenantId,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/simulate/inbound', async (req, res, next) => {
  try {
    const { tenantId, tenant } = await resolveTenant(req, req.body);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId or tenantSlug is required' });
    }

    const phone = String(req.body?.phone ?? '').trim();
    const text = String(req.body?.text ?? '').trim();
    const creds = await db.getConfig(tenantId, 'wa_credentials');
    const phoneNumberId = String(req.body?.phoneNumberId ?? creds?.valor?.phoneNumberId ?? '').trim();
    const accessToken = typeof req.body?.accessToken === 'string'
      ? req.body.accessToken.trim()
      : String(creds?.valor?.accessToken ?? '').trim();

    if (!phone || !text) {
      return res.status(400).json({ error: 'phone and text are required' });
    }

    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({
        error: 'WhatsApp credentials are required',
        detail: 'Configure wa_credentials for the tenant or send phoneNumberId and accessToken explicitly.',
      });
    }

    const sandboxApi = whatsappRouter._sandbox;
    if (!sandboxApi?.handleIncomingMessage) {
      return res.status(500).json({ error: 'Sandbox runtime is unavailable' });
    }

    const simulatedMsgId = `sandbox-${Date.now()}`;
    const msg = {
      id: simulatedMsgId,
      from: phone,
      type: 'text',
      timestamp: String(Math.floor(Date.now() / 1000)),
      text: { body: text },
    };

    const sandboxResult = await sandboxApi.handleIncomingMessage({
      msg,
      contacts: [{ wa_id: phone, profile: { name: req.body?.contactName ?? 'Sandbox User' } }],
      tenant: tenant ?? { id: tenantId },
      phoneNumberId,
      accessToken,
      correlationId: req.correlationId,
      conversationMeta: {
        sandbox: true,
        source: 'sandbox_emulator',
        initiatedBy: 'admin',
      },
    });

    let latestConversation = sandboxResult?.conversationId
      ? await getPrismaClient().conversation.findFirst({
          where: {
            ...sandboxConversationWhere(tenantId, phone),
            id: sandboxResult.conversationId,
          },
          select: { id: true, status: true, startedAt: true },
        })
      : await waitForSandboxConversation({ tenantId, userKey: phone });

    // Enterprise fallback: always persist a sandbox run so timeline/recent runs are traceable
    // even when the chatbot runtime exits before creating a conversation (e.g. no active flow).
    if (!latestConversation) {
      const prisma = getPrismaClient();
      const fallbackConversation = await prisma.conversation.create({
        data: {
          tenantId,
          userKey: phone,
          status: 'error',
          context: {
            meta: {
              sandbox: true,
              source: 'sandbox_emulator',
              initiatedBy: 'admin',
              fallbackRun: true,
            },
            simulation: {
              phone,
              text,
              msgId: simulatedMsgId,
              correlationId: req.correlationId,
            },
          },
        },
        select: { id: true, status: true, startedAt: true },
      });

      await prisma.conversationEvent.create({
        data: {
          conversationId: fallbackConversation.id,
          tenantId,
          nodeRef: null,
          eventType: 'flow_error',
          payload: {
            reason: 'sandbox_runtime_completed_without_conversation',
            message: 'No se creó conversación desde el runtime. Revisa que exista un flow activo para el tenant.',
            simulatedMsgId,
            phone,
          },
        },
      });

      latestConversation = fallbackConversation;
    }

    audit({
      adminUserId: req.admin?.adminUserId,
      tenantId,
      accion: 'SANDBOX_SIMULATE_INBOUND',
      entidad: 'sandbox',
      metadata: {
        phone,
        phoneNumberId,
        simulatedMsgId,
      },
    });

    return res.json({
      ok: true,
      simulated: {
        tenantId,
        phone,
        text,
        msgId: simulatedMsgId,
        correlationId: req.correlationId,
        conversationId: latestConversation?.id ?? null,
        conversationStatus: latestConversation?.status ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;