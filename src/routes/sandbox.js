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
const SANDBOX_SETTINGS_KEY = 'sandbox_settings';

router.use(requireJwt);
router.use(requirePermiso(SANDBOX_PERMISSION));

async function getSandboxSettings(tenantId) {
  if (!tenantId) {
    return { outboundMetaMock: false };
  }

  const config = await db.getConfig(tenantId, SANDBOX_SETTINGS_KEY);
  return {
    outboundMetaMock: Boolean(config?.valor?.outboundMetaMock),
  };
}

async function setSandboxSettings(tenantId, nextSettings) {
  const current = await getSandboxSettings(tenantId);
  const normalized = {
    outboundMetaMock: Boolean(nextSettings?.outboundMetaMock ?? current.outboundMetaMock),
  };

  await db.setConfig(tenantId, SANDBOX_SETTINGS_KEY, normalized);
  return normalized;
}

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

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeEventType(event) {
  return String(event?.eventType ?? '').trim().toLowerCase();
}

function hasReplayablePayload(event) {
  const payload = event?.payload ?? {};
  const input = String(payload.raw_input ?? payload.value ?? payload.text ?? '').trim();
  const selected = String(payload.selected_id ?? payload.selected ?? '').trim();
  return Boolean(input || selected);
}

function getReplayInputsFromEvents(events) {
  if (!Array.isArray(events)) return [];

  return events.reduce((steps, event) => {
    const eventType = normalizeEventType(event);

    if (eventType === 'user_input') {
      const rawInput = String(
        event?.payload?.raw_input ?? event?.payload?.value ?? event?.payload?.text ?? ''
      ).trim();
      if (rawInput) {
        steps.push({ type: 'user_input', text: rawInput, createdAt: event.createdAt });
      }
      return steps;
    }

    if (eventType === 'menu_selection') {
      const selectedId = String(
        event?.payload?.selected_id ?? event?.payload?.value ?? event?.payload?.selected ?? ''
      ).trim();
      if (selectedId) {
        steps.push({ type: 'menu_selection', text: selectedId, createdAt: event.createdAt });
      }
    }

    return steps;
  }, []);
}

function buildComplianceReport(run) {
  const events = Array.isArray(run?.events) ? run.events : [];
  const checks = [
    {
      key: 'hasFlowStart',
      label: 'La corrida registra inicio de flujo',
      passed: events.some((event) => normalizeEventType(event) === 'flow_start'),
    },
    {
      key: 'hasUserInteraction',
      label: 'La corrida registra interaccion del usuario',
      passed: events.some((event) => {
        const eventType = normalizeEventType(event);
        if (eventType === 'user_input' || eventType === 'menu_selection') return true;
        return hasReplayablePayload(event);
      }),
    },
    {
      key: 'hasOutboundResponse',
      label: 'La corrida emite al menos una respuesta del bot',
      passed: events.some((event) => normalizeEventType(event) === 'message_sent'),
    },
    {
      key: 'hasNoFlowErrors',
      label: 'La corrida no contiene flow_error',
      passed: !events.some((event) => normalizeEventType(event) === 'flow_error'),
    },
    {
      key: 'isFinishedOrTraceable',
      label: 'La corrida termino o quedo trazable para inspeccion',
      passed: run?.status !== 'active' || events.length > 0,
    },
  ];

  const passedCount = checks.filter((check) => check.passed).length;
  const verdict = checks.every((check) => check.passed) ? 'pass' : (passedCount >= 3 ? 'warning' : 'fail');

  return {
    verdict,
    score: `${passedCount}/${checks.length}`,
    checks,
    summary: verdict === 'pass'
      ? 'La corrida cumple los controles basicos del sandbox.'
      : verdict === 'warning'
        ? 'La corrida es parcialmente conforme; revisa los checks pendientes.'
        : 'La corrida no cumple los controles minimos y requiere correccion.',
  };
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
    const resolved = await resolveTenant(req, req.query);
    const tenantId = resolved.tenantId ?? (req.admin?.superAdmin ? null : (req.admin?.tenantId ?? null));
    const settings = await getSandboxSettings(tenantId);

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
          outboundMetaMock: settings.outboundMetaMock,
          replay: true,
          compliance: true,
        },
        tenantScope: tenantId,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/settings', requirePermiso('MANAGE_TENANTS'), async (req, res, next) => {
  try {
    const { tenantId } = await resolveTenant(req, req.body);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId or tenantSlug is required' });
    }

    if (typeof req.body?.outboundMetaMock !== 'boolean') {
      return res.status(400).json({ error: 'outboundMetaMock must be a boolean' });
    }

    const settings = await setSandboxSettings(tenantId, {
      outboundMetaMock: req.body.outboundMetaMock,
    });

    audit({
      adminUserId: req.admin?.adminUserId,
      tenantId,
      accion: 'SANDBOX_SETTINGS_UPDATE',
      entidad: 'sandbox',
      metadata: settings,
    });

    return res.json({ ok: true, sandbox: { settings } });
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
    const settings = await getSandboxSettings(tenantId);
    const creds = await db.getConfig(tenantId, 'wa_credentials');
    const phoneNumberId = String(req.body?.phoneNumberId ?? creds?.valor?.phoneNumberId ?? '').trim();
    const accessToken = typeof req.body?.accessToken === 'string'
      ? req.body.accessToken.trim()
      : String(creds?.valor?.accessToken ?? '').trim();

    if (!phone || !text) {
      return res.status(400).json({ error: 'phone and text are required' });
    }

    if (!settings.outboundMetaMock && (!phoneNumberId || !accessToken)) {
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
        outboundMetaMock: settings.outboundMetaMock,
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
        outboundMetaMock: settings.outboundMetaMock,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/runs/:id/replay', async (req, res, next) => {
  try {
    const { tenantId, tenant } = await resolveTenant(req, req.body);
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
        events: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, eventType: true, payload: true, createdAt: true },
        },
      },
    });

    if (!run) {
      return res.status(404).json({ error: 'Sandbox run not found' });
    }

    const replayInputs = getReplayInputsFromEvents(run.events);
    if (replayInputs.length === 0) {
      return res.status(400).json({ error: 'Sandbox run has no replayable user inputs' });
    }

    const settings = await getSandboxSettings(tenantId);
    const creds = await db.getConfig(tenantId, 'wa_credentials');
    const phoneNumberId = String(req.body?.phoneNumberId ?? creds?.valor?.phoneNumberId ?? '').trim();
    const accessToken = typeof req.body?.accessToken === 'string'
      ? req.body.accessToken.trim()
      : String(creds?.valor?.accessToken ?? '').trim();

    if (!settings.outboundMetaMock && (!phoneNumberId || !accessToken)) {
      return res.status(400).json({
        error: 'WhatsApp credentials are required',
        detail: 'Configure wa_credentials for the tenant or send phoneNumberId and accessToken explicitly.',
      });
    }

    const sandboxApi = whatsappRouter._sandbox;
    if (!sandboxApi?.handleIncomingMessage) {
      return res.status(500).json({ error: 'Sandbox runtime is unavailable' });
    }

    let latestConversation = null;
    for (let index = 0; index < replayInputs.length; index += 1) {
      const step = replayInputs[index];
      const msg = {
        id: `sandbox-replay-${req.params.id}-${index + 1}-${Date.now()}`,
        from: run.userKey,
        type: 'text',
        timestamp: String(Math.floor(Date.now() / 1000)),
        text: { body: step.text },
      };

      const replayResult = await sandboxApi.handleIncomingMessage({
        msg,
        contacts: [{ wa_id: run.userKey, profile: { name: req.body?.contactName ?? 'Sandbox Replay' } }],
        tenant: tenant ?? { id: tenantId },
        phoneNumberId,
        accessToken,
        correlationId: req.correlationId,
        conversationMeta: {
          sandbox: true,
          source: 'sandbox_replay',
          initiatedBy: 'admin',
          replay: true,
          replaySourceRunId: run.id,
          outboundMetaMock: settings.outboundMetaMock,
        },
      });

      latestConversation = replayResult?.conversationId
        ? await prisma.conversation.findFirst({
            where: {
              ...sandboxConversationWhere(tenantId, run.userKey),
              id: replayResult.conversationId,
            },
            select: { id: true, status: true, startedAt: true },
          })
        : latestConversation;

      if (index < replayInputs.length - 1) {
        await sleep(100);
      }
    }

    audit({
      adminUserId: req.admin?.adminUserId,
      tenantId,
      accion: 'SANDBOX_REPLAY_RUN',
      entidad: 'sandbox',
      metadata: {
        sourceRunId: run.id,
        replayedSteps: replayInputs.length,
      },
    });

    return res.json({
      ok: true,
      replay: {
        sourceRunId: run.id,
        replayedSteps: replayInputs.length,
        userKey: run.userKey,
        outboundMetaMock: settings.outboundMetaMock,
        conversationId: latestConversation?.id ?? null,
        conversationStatus: latestConversation?.status ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/runs/:id/compliance', async (req, res, next) => {
  try {
    const { tenantId } = await resolveTenant(req, req.body);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId or tenantSlug is required' });
    }

    const prisma = getPrismaClient();
    const run = await prisma.conversation.findFirst({
      where: {
        ...sandboxConversationWhere(tenantId),
        id: req.params.id,
      },
      select: {
        id: true,
        status: true,
        userKey: true,
        startedAt: true,
        endedAt: true,
        events: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, eventType: true, payload: true, createdAt: true },
        },
      },
    });

    if (!run) {
      return res.status(404).json({ error: 'Sandbox run not found' });
    }

    const report = buildComplianceReport(run);

    audit({
      adminUserId: req.admin?.adminUserId,
      tenantId,
      accion: 'SANDBOX_COMPLIANCE_CHECK',
      entidad: 'sandbox',
      metadata: {
        runId: run.id,
        verdict: report.verdict,
        score: report.score,
      },
    });

    return res.json({ ok: true, compliance: { runId: run.id, ...report } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;