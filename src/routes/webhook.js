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
// Tries tenant-level secret from DB first, then all known env secrets.
// Accepts the request if ANY secret produces the correct HMAC.
async function verifyFlowsSignature(req, res, next) {
  try {
    const tenantId = req.tenant?.id;

    // Build ordered list of candidate secrets (deduplicated)
    const secretCandidates = [];
    if (tenantId) {
      const dbSecret = await db.getWaAppSecret(tenantId);
      if (dbSecret) secretCandidates.push({ label: 'db', value: String(dbSecret).trim() });
    }
    const waSecret = String(process.env.WA_APP_SECRET ?? '').trim();
    if (waSecret && !secretCandidates.some(s => s.value === waSecret)) {
      secretCandidates.push({ label: 'WA_APP_SECRET', value: waSecret });
    }
    const fbSecret = String(process.env.FACEBOOK_APP_SECRET ?? '').trim();
    if (fbSecret && !secretCandidates.some(s => s.value === fbSecret)) {
      secretCandidates.push({ label: 'FACEBOOK_APP_SECRET', value: fbSecret });
    }

    if (secretCandidates.length === 0) {
      logger.warn('No app secret available: Flows webhook signature verification is disabled');
      return next();
    }

    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return res.status(401).json({ error: 'Missing webhook signature', code: 'WF_SIG_MISSING' });
    if (!req.rawBody) {
      logger.error('rawBody unavailable for Flows webhook signature check');
      return res.status(400).json({ error: 'Raw body unavailable for signature check' });
    }

    const received = String(sig).trim();
    const signatureMatch = received.match(/^(?:sha256\s*=\s*)?"?([a-f0-9]{64})"?$/i);
    if (!signatureMatch) {
      logger.warn('Flows webhook signature invalid format', {
        tenantId,
        correlationId: req.correlationId,
        headerLength: received.length,
        headerSample: received.slice(0, 32),
      });
      return res.status(401).json({ error: 'Invalid webhook signature', code: 'WF_SIG_FORMAT' });
    }
    const receivedHex = signatureMatch[1].toLowerCase();
    const receivedBuf = Buffer.from(receivedHex, 'hex');

    let matched = false;
    const triedHashes = [];
    for (const candidate of secretCandidates) {
      try {
        const expectedHex = crypto
          .createHmac('sha256', candidate.value)
          .update(req.rawBody)
          .digest('hex');
        const expectedBuf = Buffer.from(expectedHex, 'hex');
        if (crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
          matched = true;
          logger.debug('Flows webhook signature matched', { tenantId, secretLabel: candidate.label });
          break;
        }
        triedHashes.push({
          label: candidate.label,
          secretSHA256: crypto.createHash('sha256').update(candidate.value).digest('hex'),
          expectedPrefix: expectedHex.slice(0, 16),
        });
      } catch {
        // skip malformed secret
      }
    }

    if (!matched) {
      const bodyPreview = req.rawBody.slice(0, 200).toString('utf8').replace(/[\x00-\x1f]/g, '?');
      logger.warn('Flows webhook signature mismatch (all secrets tried)', {
        tenantId,
        correlationId: req.correlationId,
        receivedSig: received,
        triedHashes,
        bodyLength: req.rawBody.length,
        bodyPreview,
        contentType: req.headers['content-type'],
      });
      return res.status(401).json({ error: 'Invalid webhook signature', code: 'WF_SIG_MISMATCH' });
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
    let nextScreen = getNextScreen(screen, data, navigationOverride);
    if (nextScreen === null && screen === 'SOLICITUD_ESPACIO') {
      // Defensive fallback: keep flow progressing even if tenant nav override is incomplete.
      nextScreen = 'CIERRE';
      logger.warn('Navigation fallback applied: SOLICITUD_ESPACIO -> CIERRE', { tenantId });
    }
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
