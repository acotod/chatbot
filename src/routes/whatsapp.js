'use strict';
/**
 * GET  /whatsapp                    — Meta webhook verification
 * POST /whatsapp                    — WhatsApp Cloud API incoming webhook
 * POST /whatsapp/send               — Send outbound text (admin panel)
 * GET  /whatsapp/conversaciones     — List conversation threads (admin panel)
 * GET  /whatsapp/mensajes           — Full message history for a user (admin panel)
 * GET  /whatsapp/flows              — Meta Flows webhook verification
 * POST /whatsapp/flows              — Meta Flows data_exchange endpoint
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const db = require('../services/database');
const socketService = require('../services/socketService');
const wa = require('../services/whatsapp');
const chatbotRouter = require('../services/chatbotRouter');
const requireJwt = require('../middleware/requireJwt');
const { getRedisClient } = require('../services/redis');
const { getNextScreen } = require('../services/flowNavigation');
const { ingestEvent } = require('../services/eventGateway');
const crmSync = require('../services/crmSync');
const { getPrismaClient } = require('../services/database');

const router = express.Router();

function _toIsoFromUnixSeconds(seconds) {
  const ts = Number(seconds);
  if (!Number.isFinite(ts)) return new Date().toISOString();
  return new Date(ts * 1000).toISOString();
}

async function _ingestUegBestEffort({ tenantId, correlationId, idempotencyKey, rawEvent, context }) {
  try {
    await ingestEvent({
      tenantId,
      correlationId,
      idempotencyKeyHeader: idempotencyKey,
      rawEvent,
    });
  } catch (uegErr) {
    logger.warn('UEG dual-write failed on /whatsapp', {
      tenantId,
      context,
      message: uegErr.message,
    });
  }
}

// ── Meta Webhook Signature Verification ─────────────────────────────────────
// Validates X-Hub-Signature-256 sent by Meta on every POST.
// Requires WA_APP_SECRET env var. If not set, skips verification (dev mode).
function verifyMetaSignature(req, res, next) {
  const appSecret = process.env.WA_APP_SECRET;
  if (!appSecret) {
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

          await _ingestUegBestEffort({
            tenantId: tenant.id,
            correlationId: req.correlationId,
            idempotencyKey: status.id ? `wa_status:${status.id}:${status.status}` : null,
            rawEvent: {
              channel: 'whatsapp',
              source: 'meta_whatsapp_cloud',
              eventType: 'message_status_updated',
              direction: 'inbound',
              occurredAt: _toIsoFromUnixSeconds(status.timestamp),
              payload: {
                phoneNumberId,
                status,
              },
              metadata: {
                route: '/whatsapp',
                type: 'status_update',
              },
            },
            context: 'status_update',
          });

          socketService.emit(tenant.id, 'wa_status', {
            waMsgId: status.id,
            status: status.status,
            timestamp: status.timestamp,
          });
        }

        // Handle incoming messages
        for (const msg of value.messages ?? []) {
          await _handleIncomingMessage({
            msg,
            contacts: value.contacts,
            tenant,
            phoneNumberId,
            accessToken,
            correlationId: req.correlationId,
          });
        }
      }
    }
  } catch (err) {
    logger.error('Error processing WhatsApp webhook', { message: err.message, stack: err.stack });
  }
});

// ── Private ──────────────────────────────────────────────────────────────────

async function _handleIncomingMessage({ msg, contacts, tenant, phoneNumberId, accessToken, correlationId }) {
  const phone   = msg.from;
  const waMsgId = msg.id;
  const tipo    = msg.type;

  // ── Idempotency: skip if already processed (Meta may redeliver) ──────────
  if (waMsgId) {
    const existing = await db.findMensajeByWaMsgId(waMsgId);
    if (existing) {
      logger.info('Duplicate WhatsApp message ignored', { waMsgId });
      return;
    }
  }

  // Resolve / create user
  const user   = await db.findOrCreateUser(phone, tenant.id);
  const userId = user?.id ?? null;

  // ── Build contenido + extract chatbot input ──────────────────────────────
  let contenido;
  let userInput = null;

  switch (tipo) {
    case 'text':
      contenido = { text: msg.text?.body };
      userInput = msg.text?.body ?? null;
      break;
    case 'interactive': {
      const iType = msg.interactive?.type;
      if (iType === 'nfm_reply') {
        // WhatsApp Flows (Native Flow Message) completion
        const nfm = msg.interactive.nfm_reply ?? {};
        let formData = {};
        try { formData = JSON.parse(nfm.response_json ?? '{}'); } catch {}
        contenido = { interactive: { type: 'nfm_reply', data: formData } };
        userInput = nfm.response_json ?? null;
      } else {
        const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
        contenido = { interactive: { type: iType, reply } };
        userInput = reply?.id ?? null;
      }
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
  // Store mensaje.id so we can back-fill conversationId after the chatbot runs
  const mensajeId = mensaje.id;

  await _ingestUegBestEffort({
    tenantId: tenant.id,
    correlationId,
    idempotencyKey: waMsgId,
    rawEvent: {
      channel: 'whatsapp',
      source: 'meta_whatsapp_cloud',
      eventType: 'message_received',
      direction: 'inbound',
      occurredAt: _toIsoFromUnixSeconds(msg.timestamp),
      payload: {
        userId,
        phone,
        waMsgId,
        tipo,
        contenido,
      },
      metadata: {
        route: '/whatsapp',
        type: 'incoming_message',
      },
    },
    context: 'incoming_message',
  });

  const contactName = contacts?.find((c) => c.wa_id === phone)?.profile?.name ?? null;

  // ── CRM auto-sync (best-effort, non-blocking) ────────────────────────────
  if (userId !== null) {
    crmSync.touch({ userId, prisma: getPrismaClient(), canal: 'whatsapp', nombre: contactName }).catch(() => {});
  }

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

  // ── Chatbot engine ───────────────────────────────────────────────────────
  if (userId !== null && userInput !== null && accessToken) {
    _runChatbot({ tenant, userId, phone, userInput, phoneNumberId, accessToken, correlationId, inboundMensajeId: mensajeId })
      .catch((err) => logger.error('_runChatbot error', { tenantId: tenant.id, message: err.message }));
  }
}

// ── Chatbot dispatcher ────────────────────────────────────────────────────────

async function _runChatbot({ tenant, userId, phone, userInput, phoneNumberId, accessToken, correlationId, inboundMensajeId }) {
  const { response, fallbackToHuman, conversationId } = await chatbotRouter.routeMessage({
    tenantId: tenant.id,
    userId,
    input: userInput,
    phone,
  });

  // Back-fill conversationId on the inbound message that triggered this run
  if (conversationId && inboundMensajeId) {
    getPrismaClient().mensaje.update({
      where: { id: inboundMensajeId },
      data:  { conversationId },
    }).catch(() => {});
  }

  if (fallbackToHuman) {
    await _handleFallbackToHuman({
      tenant,
      userId,
      phone,
      response,
      phoneNumberId,
      accessToken,
      correlationId,
      conversationId,
    });
  } else if (response) {
    await _sendChatbotResponse({
      tenant,
      userId,
      phone,
      phoneNumberId,
      accessToken,
      response,
      correlationId,
      conversationId,
    });
  }
}

async function _handleFallbackToHuman({ tenant, userId, phone, response, phoneNumberId, accessToken, correlationId, conversationId }) {
  // Send handoff message to user if provided
  if (response?.text) {
    await _sendText(phoneNumberId, phone, response.text, accessToken, tenant, userId, correlationId);
  }

  // Create solicitud for human agent follow-up (avoid duplicates)
  const openSolicitud = await db.findOpenSolicitudForUser(userId, tenant.id);
  if (!openSolicitud) {
    await db.saveSolicitud(userId, {}, tenant.id);
    logger.info('Solicitud created for human handoff', { tenantId: tenant.id, userId, phone });
  }

  // Emit real-time handoff event to admin panel
  socketService.emit(tenant.id, 'chatbot_handoff', {
    userId,
    phone,
    tenantId: tenant.id,
  });
}

async function _sendChatbotResponse({ tenant, userId, phone, phoneNumberId, accessToken, response, correlationId, conversationId }) {
  const type = response?.type ?? 'text';

  try {
    let waResp;
    if (type === 'buttons') {
      const buttons = (response.buttons ?? []).slice(0, 3);
      waResp = await wa.sendButtonMessage(phoneNumberId, phone, response.text ?? '', buttons, accessToken);
    } else {
      // text or end
      waResp = await wa.sendTextMessage(phoneNumberId, phone, response.text ?? '', accessToken);
    }

    // Persist outbound message
    const outboundMsg = await db.saveMensaje({
      tenantId:       tenant.id,
      userId,
      waMsgId:        waResp?.messages?.[0]?.id ?? null,
      direccion:      'salida',
      tipo:           type === 'buttons' ? 'interactive' : 'text',
      contenido:      response,
      conversationId: conversationId ?? undefined,
    });

    await _ingestUegBestEffort({
      tenantId: tenant.id,
      correlationId,
      idempotencyKey: outboundMsg.waMsgId ?? `wa_outbound:${outboundMsg.id}`,
      rawEvent: {
        channel: 'whatsapp',
        source: 'chatbot_runtime',
        eventType: 'message_sent',
        direction: 'outbound',
        occurredAt: outboundMsg.createdAt,
        payload: {
          userId,
          phone,
          waMsgId: outboundMsg.waMsgId,
          tipo: outboundMsg.tipo,
          contenido: response,
        },
        metadata: {
          route: '/whatsapp',
          type: 'chatbot_response',
        },
      },
      context: 'chatbot_response',
    });

    socketService.emit(tenant.id, 'nuevo_mensaje', {
      id:        outboundMsg.id,
      userId,
      phone,
      tipo:      outboundMsg.tipo,
      contenido: response,
      waMsgId:   outboundMsg.waMsgId,
      createdAt: outboundMsg.createdAt,
      direccion: 'salida',
    });
  } catch (err) {
    logger.error('_sendChatbotResponse failed, enqueueing retry', {
      tenantId: tenant.id,
      phone,
      message: err.message,
    });

    // Enqueue for retry
    const redis = getRedisClient();
    if (redis) {
      const queuePayload = {
        tenantId: tenant.id,
        phone,
        messagePayload: type === 'buttons'
          ? _buildButtonPayload(phone, response)
          : _buildTextPayload(phone, response.text ?? ''),
        attempts: 0,
      };
      await redis.lpush('queue:wa_send', JSON.stringify(queuePayload));
    }
  }
}

function _buildTextPayload(to, text) {
  return {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    type:              'text',
    text:              { preview_url: false, body: text },
  };
}

function _buildButtonPayload(to, response) {
  const buttons = (response.buttons ?? []).slice(0, 3);
  return {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    type:              'interactive',
    interactive: {
      type: 'button',
      body: { text: response.text ?? '' },
      action: {
        buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    },
  };
}

async function _sendText(phoneNumberId, phone, text, accessToken, tenant, userId, correlationId) {
  try {
    const waResp = await wa.sendTextMessage(phoneNumberId, phone, text, accessToken);
    const msg = await db.saveMensaje({
      tenantId:  tenant.id,
      userId,
      waMsgId:   waResp?.messages?.[0]?.id ?? null,
      direccion: 'salida',
      tipo:      'text',
      contenido: { text },
    });

    await _ingestUegBestEffort({
      tenantId: tenant.id,
      correlationId,
      idempotencyKey: msg.waMsgId ?? `wa_outbound:${msg.id}`,
      rawEvent: {
        channel: 'whatsapp',
        source: 'chatbot_runtime',
        eventType: 'message_sent',
        direction: 'outbound',
        occurredAt: msg.createdAt,
        payload: {
          userId,
          phone,
          waMsgId: msg.waMsgId,
          tipo: 'text',
          contenido: { text },
        },
        metadata: {
          route: '/whatsapp',
          type: 'fallback_message',
        },
      },
      context: 'fallback_message',
    });

    socketService.emit(tenant.id, 'nuevo_mensaje', {
      id: msg.id, userId, phone,
      tipo: 'text', contenido: { text }, waMsgId: msg.waMsgId,
      createdAt: msg.createdAt, direccion: 'salida',
    });
  } catch (err) {
    logger.warn('_sendText failed', { tenantId: tenant.id, phone, message: err.message });
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

    await _ingestUegBestEffort({
      tenantId,
      correlationId: req.correlationId,
      idempotencyKey: mensaje.waMsgId ?? `wa_outbound:${mensaje.id}`,
      rawEvent: {
        channel: 'whatsapp',
        source: 'admin_panel',
        eventType: 'message_sent',
        direction: 'outbound',
        occurredAt: mensaje.createdAt,
        payload: {
          userId: user?.id ?? null,
          phone: to,
          waMsgId: mensaje.waMsgId,
          tipo: 'text',
          contenido: { text },
        },
        metadata: {
          route: '/whatsapp/send',
          type: 'admin_message',
        },
      },
      context: 'admin_message',
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

// ── Meta Flows: data_exchange endpoint (Fase 5) ──────────────────────────────
// GET /whatsapp/flows  — Meta Flows webhook verification
// POST /whatsapp/flows — Meta Flows data_exchange (screen navigation)
//
// Tenant resolution: by flow_token stored in configuraciones
//   { clave: "flow_token", valor: { token: "..." } }
// OR fallback: resolves by WA_VERIFY_TOKEN (single tenant setups).
// Meta sends X-Hub-Signature-256 — validated by verifyMetaSignature.

router.get('/flows', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    logger.info('Meta Flows webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('Meta Flows webhook verification failed', { mode, token });
  return res.sendStatus(403);
});

router.post('/flows', verifyMetaSignature, async (req, res, next) => {
  try {
    const { flow_token, action, screen, data = {} } = req.body;

    // Ping health check from Meta
    if (action === 'ping') {
      return res.json({ data: { status: 'active' } });
    }

    if (!screen) {
      return res.status(400).json({ error: 'screen is required' });
    }

    // Resolve tenant
    let tenant = null;
    if (flow_token) {
      tenant = await db.findTenantByFlowToken(flow_token);
    }
    if (!tenant) {
      logger.warn('Meta Flows: tenant not resolved', { flow_token });
      return res.status(400).json({ error: 'Cannot resolve tenant from flow_token' });
    }

    if (!tenant.activo) {
      return res.status(403).json({ error: 'Tenant is inactive' });
    }

    // Resolve user if phone is in data
    let userId = null;
    if (data.phone) {
      const user = await db.findOrCreateUser(data.phone, tenant.id);
      userId = user?.id ?? null;
    }

    // Persist event
    await db.saveEvent(userId, screen, data, tenant.id);

    // Persist solicitud when applicable
    if (screen === 'SOLICITUD_ESPACIO') {
      await db.saveSolicitud(userId, data, tenant.id);
    }

    // Load tenant flow config override (fallback to default)
    const flowConfig = await db.getConfig(tenant.id, 'flow_navigation');
    const navigationOverride = flowConfig ? flowConfig.valor : null;

    const nextScreen = getNextScreen(screen, data, navigationOverride);
    if (nextScreen === null) {
      logger.warn('Meta Flows navigation failed', { tenantId: tenant.id, screen });
      return res.status(400).json({ error: `Unknown screen or option for screen: ${screen}` });
    }

    // Enqueue urgencia async processing
    if (screen === 'URGENCIA' || nextScreen === 'URGENCIA') {
      const redis = getRedisClient();
      if (redis) {
        await redis.lpush('queue:urgencias', JSON.stringify({
          tenantId: tenant.id, userId, screen, nextScreen, data, timestamp: Date.now(),
        }));
      }
    }

    logger.info('Meta Flows navigation', { tenantId: tenant.id, from: screen, to: nextScreen });

    // Load screen templates for the next screen
    const templatesCfg = await db.getConfig(tenant.id, 'screen_templates');
    const templates = templatesCfg?.valor ?? {};
    const screenData = templates[nextScreen] ?? {};

    return res.json({ screen: nextScreen, data: screenData });
  } catch (err) {
    next(err);
  }
});

module.exports = router;