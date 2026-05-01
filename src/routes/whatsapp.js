'use strict';
/**
 * GET  /whatsapp              — Meta webhook verification
 * POST /whatsapp              — WhatsApp Cloud API incoming webhook
 * POST /whatsapp/send         — Send outbound text (admin panel)
 * GET  /whatsapp/conversaciones — List conversation threads (admin panel)
 * GET  /whatsapp/mensajes     — Full message history for a user (admin panel)
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const db = require('../services/database');
const socketService = require('../services/socketService');
const wa = require('../services/whatsapp');
const requireJwt = require('../middleware/requireJwt');

const router = express.Router();

// ── Meta Webhook Signature Verification ─────────────────────────────────────
// Validates X-Hub-Signature-256 sent by Meta on every POST.
// Requires WA_APP_SECRET env var. If not set, skips verification (dev mode).
function verifyMetaSignature(req, res, next) {
  const appSecret = process.env.WA_APP_SECRET;
  if (!appSecret) {
    // Secret not configured — allow through but warn once
    logger.warn('WA_APP_SECRET not set: webhook signature verification is disabled');
    return next();
  }

  const sig = req.headers['x-hub-signature-256'];
  if (!sig) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  if (!req.rawBody) {
    logger.error('rawBody unavailable — ensure express.json verify is configured');
    return res.status(400).json({ error: 'Raw body unavailable for signature check' });
  }

  const expected = 'sha256=' +
    crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      logger.warn('WhatsApp webhook signature mismatch');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  next();
}

// ── GET: Meta webhook verification ──────────────────────────────────────────

router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verification failed', { mode, token });
  return res.sendStatus(403);
});

// ── POST: incoming events ────────────────────────────────────────────────────

router.post('/', verifyMetaSignature, async (req, res) => {
  // Always acknowledge immediately — Meta expects 200 within 20 s
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value;

        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // Resolve tenant by phone_number_id
        const tenant = await db.findTenantByWaPhoneNumberId(phoneNumberId);
        if (!tenant) {
          logger.warn('No tenant for phone_number_id', { phoneNumberId });
          continue;
        }

        // Get access token for outbound replies
        const creds = await db.getConfig(tenant.id, 'wa_credentials');
        const accessToken = creds?.valor?.accessToken;

        // Handle status updates (delivery receipts)
        for (const status of value.statuses ?? []) {
          logger.info('WhatsApp status update', {
            tenantId: tenant.id,
            msgId: status.id,
            status: status.status,
          });
          socketService.emit(tenant.id, 'wa_status', {
            waMsgId: status.id,
            status: status.status,
            timestamp: status.timestamp,
          });
        }

        // Handle incoming messages
        for (const msg of value.messages ?? []) {
          await _handleIncomingMessage(msg, value.contacts, tenant, phoneNumberId, accessToken);
        }
      }
    }
  } catch (err) {
    logger.error('Error processing WhatsApp webhook', { message: err.message, stack: err.stack });
  }
});

// ── Private ──────────────────────────────────────────────────────────────────

async function _handleIncomingMessage(msg, contacts, tenant, phoneNumberId, accessToken) {
  const phone    = msg.from;
  const waMsgId  = msg.id;
  const tipo     = msg.type;

  // Resolve / create user
  const user   = await db.findOrCreateUser(phone, tenant.id);
  const userId = user?.id ?? null;

  // Build contenido based on type
  let contenido;
  switch (tipo) {
    case 'text':
      contenido = { text: msg.text?.body };
      break;
    case 'interactive': {
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      contenido = { interactive: { type: msg.interactive?.type, reply } };
      break;
    }
    case 'image':
      contenido = { image: msg.image };
      break;
    case 'audio':
      contenido = { audio: msg.audio };
      break;
    case 'document':
      contenido = { document: msg.document };
      break;
    default:
      contenido = { raw: msg };
  }

  // Persist message
  const mensaje = await db.saveMensaje({
    tenantId:  tenant.id,
    userId,
    waMsgId,
    direccion: 'entrada',
    tipo,
    contenido,
  });

  const contactName = contacts?.find((c) => c.wa_id === phone)?.profile?.name ?? null;

  logger.info('WhatsApp message received', {
    tenantId: tenant.id,
    userId,
    phone,
    tipo,
    waMsgId,
  });

  // Emit real-time event to admin dashboard
  socketService.emit(tenant.id, 'nuevo_mensaje', {
    id:          mensaje.id,
    userId,
    phone,
    contactName,
    tipo,
    contenido,
    waMsgId,
    createdAt:   mensaje.createdAt,
  });

  // Mark as read (best-effort)
  if (accessToken) {
    wa.markAsRead(phoneNumberId, waMsgId, accessToken).catch((err) => {
      logger.warn('Could not mark message as read', { waMsgId, message: err.message });
    });
  }
}

// ── Send outbound message (used by admin routes) ─────────────────────────────

/**
 * POST /whatsapp/send
 * Body: { tenantId, to, text }
 * Auth: JWT required (handled by caller middleware)
 */
router.post('/send', async (req, res, next) => {
  try {
    const { tenantId, to, text } = req.body;
    if (!tenantId || !to || !text) {
      return res.status(400).json({ error: 'tenantId, to and text are required' });
    }

    const creds = await db.getConfig(tenantId, 'wa_credentials');
    if (!creds?.valor?.phoneNumberId || !creds?.valor?.accessToken) {
      return res.status(422).json({ error: 'WhatsApp credentials not configured for this tenant' });
    }

    const { phoneNumberId, accessToken } = creds.valor;

    const user    = await db.findOrCreateUser(to, tenantId);
    const waResp  = await wa.sendTextMessage(phoneNumberId, to, text, accessToken);

    const mensaje = await db.saveMensaje({
      tenantId,
      userId:    user?.id ?? null,
      waMsgId:   waResp.messages?.[0]?.id ?? null,
      direccion: 'salida',
      tipo:      'text',
      contenido: { text },
    });

    socketService.emit(tenantId, 'nuevo_mensaje', {
      id:        mensaje.id,
      userId:    user?.id ?? null,
      phone:     to,
      tipo:      'text',
      contenido: { text },
      waMsgId:   waResp.messages?.[0]?.id ?? null,
      createdAt: mensaje.createdAt,
      direccion: 'salida',
    });

    return res.json({ ok: true, mensajeId: mensaje.id, waResponse: waResp });
  } catch (err) {
    next(err);
  }
});

// ── Admin: list conversation threads ─────────────────────────────────────────

/**
 * GET /whatsapp/conversaciones?tenantId=
 * Returns the latest message per unique user (conversation thread list).
 * Requires JWT.
 */
router.get('/conversaciones', requireJwt, async (req, res, next) => {
  try {
    const { tenantId } = req.query;
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
    const threads = await db.listConversaciones(tenantId);
    return res.json({ data: threads });
  } catch (err) {
    next(err);
  }
});

// ── Admin: message history for one user ──────────────────────────────────────

/**
 * GET /whatsapp/mensajes?tenantId=&userId=&page=
 * Returns paginated message history for a user in a tenant.
 * Requires JWT.
 */
router.get('/mensajes', requireJwt, async (req, res, next) => {
  try {
    const { tenantId, userId, page } = req.query;
    if (!tenantId || !userId) {
      return res.status(400).json({ error: 'tenantId and userId are required' });
    }
    const mensajes = await db.listMensajes(tenantId, Number(userId), {
      page: page ? Number(page) : 1,
      limit: 50,
    });
    return res.json({ data: mensajes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
