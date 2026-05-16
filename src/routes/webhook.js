const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { webhookValidationRules, validate } = require('../middleware/validate');
const { getNextScreen } = require('../services/flowNavigation');
const db = require('../services/database');
const { getRedisClient } = require('../services/redis');
const { ingestEvent } = require('../services/eventGateway');
const crmSync = require('../services/crmSync');

const router = express.Router();

function getSubmittedContactName(data) {
  if (!data || typeof data !== 'object') return null;
  const candidate =
    data.nombre ??
    data.name ??
    data.fullName ??
    data.full_name ??
    data.customerName ??
    data.customer_name;
  const normalized = String(candidate ?? '').trim();
  return normalized || null;
}

// ── Meta HMAC-SHA256 signature verification (same pattern as /whatsapp) ──────────
// Tries tenant-level secret from DB first, then falls back to WA_APP_SECRET env var.
async function verifyFlowsSignature(req, res, next) {
  try {
    const tenantId = req.tenant?.id;
    let appSecret = null;

    if (tenantId) {
      appSecret = await db.getWaAppSecret(tenantId);
    }
    if (!appSecret) {
      appSecret = String(process.env.WA_APP_SECRET ?? '').trim() || null;
    }

    if (!appSecret) {
      logger.warn('WA_APP_SECRET not set: Flows webhook signature verification is disabled');
      return next();
    }

    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return res.status(401).json({ error: 'Missing webhook signature' });
    if (!req.rawBody) {
      logger.error('rawBody unavailable for Flows webhook signature check');
      return res.status(400).json({ error: 'Raw body unavailable for signature check' });
    }

    const expectedHex = crypto
      .createHmac('sha256', appSecret)
      .update(req.rawBody)
      .digest('hex');

    const received = String(sig).trim();
    const signatureMatch = received.match(/^(?:sha256\s*=\s*)?"?([a-f0-9]{64})"?$/i);
    if (!signatureMatch) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    const receivedHex = signatureMatch[1].toLowerCase();

    try {
      const receivedBuf = Buffer.from(receivedHex, 'hex');
      const expectedBuf = Buffer.from(expectedHex, 'hex');

      if (!crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
        logger.warn('Flows webhook signature mismatch', { tenantId });
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } catch (err) {
    return next(err);
  }
  next();
}

// ── GET: Meta Flows webhook verification ─────────────────────────────────────

router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    logger.info('Flows webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('Flows webhook verification failed', { mode, token });
  return res.sendStatus(403);
});

// ── POST: WhatsApp Flows data_exchange ───────────────────────────────────────

router.post('/', verifyFlowsSignature, webhookValidationRules, validate, async (req, res, next) => {
  const { screen, data } = req.body;
  const tenantId = req.tenant.id;

  logger.info('Incoming webhook request', { tenantId, screen });

  try {
    // Resolve user if phone provided
    let userId = null;
    if (data.phone) {
      const user = await db.findOrCreateUser(data.phone, tenantId);
      userId = user ? user.id : null;
    }

    // Persist the flow event
    await db.saveEvent(userId, screen, data, tenantId);

    // ── CRM auto-sync (best-effort) ───────────────────────────────────
    if (userId !== null) {
      const submittedName = getSubmittedContactName(data);
      crmSync.touch({
        userId,
        prisma: db.getPrismaClient(),
        canal: 'flows',
        nombre: submittedName,
      }).catch(() => {});
    }

    // Dual-write to the UEG canonical event log (best-effort)
    // Legacy webhook flow must continue even if UEG ingest fails.
    try {
      await ingestEvent({
        tenantId,
        correlationId: req.correlationId,
        rawEvent: {
          channel: 'whatsapp',
          source: 'meta_flows',
          eventType: 'flow_screen_submitted',
          direction: 'inbound',
          occurredAt: new Date().toISOString(),
          payload: {
            userId,
            screen,
            data,
          },
          metadata: {
            route: '/webhook',
          },
        },
      });
    } catch (uegErr) {
      logger.warn('UEG dual-write failed on /webhook', {
        tenantId,
        message: uegErr.message,
      });
    }

    // Persist solicitud when applicable
    if (screen === 'SOLICITUD_ESPACIO') {
      await db.saveSolicitud(userId, data, tenantId);
    }

    // Load tenant flow config (dynamic engine), fallback to default
    const flowConfig = await db.getConfig(tenantId, 'flow_navigation');
    const navigationOverride = flowConfig ? flowConfig.valor : null;

    // Navigate to the next screen
    const nextScreen = getNextScreen(screen, data, navigationOverride);
    if (nextScreen === null) {
      logger.warn('Navigation failed: unknown screen or option', { tenantId, screen, data });
      return res.status(400).json({ error: `Unknown screen or option for screen: ${screen}` });
    }

    // Enqueue urgencia for async processing
    if (screen === 'URGENCIA' || nextScreen === 'URGENCIA') {
      const redis = getRedisClient();
      if (redis) {
        await redis.lpush('queue:urgencias', JSON.stringify({
          tenantId, userId, screen, nextScreen, data, timestamp: Date.now(),
        }));
        logger.info('Urgencia enqueued', { tenantId, userId });
      }
    }

    logger.info('Navigation decision', { tenantId, from: screen, to: nextScreen });
    return res.json({ screen: nextScreen });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
