'use strict';

const express = require('express');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const db = require('../services/database');
const { audit } = require('../services/audit');
const whatsappRouter = require('./whatsapp');

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

async function resolveTenant(req, body) {
  const directTenantId = resolveTenantId(req, body);
  if (directTenantId) {
    return { tenantId: directTenantId, tenant: { id: directTenantId } };
  }

  const tenantSlug = typeof body?.tenantSlug === 'string' ? body.tenantSlug.trim() : '';
  if (!tenantSlug) {
    return { tenantId: null, tenant: null };
  }

  const tenant = await db.findTenantBySlug(tenantSlug);
  return {
    tenantId: tenant?.id ?? null,
    tenant,
  };
}

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

    await sandboxApi.handleIncomingMessage({
      msg,
      contacts: [{ wa_id: phone, profile: { name: req.body?.contactName ?? 'Sandbox User' } }],
      tenant: tenant ?? { id: tenantId },
      phoneNumberId,
      accessToken,
      correlationId: req.correlationId,
    });

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
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;