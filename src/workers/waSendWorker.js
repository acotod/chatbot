'use strict';
/**
 * WA Send Worker
 * Processes outbound WhatsApp messages from the retry queue.
 *
 * Queue key: queue:wa_send
 * Payload:   { tenantId, phone, messagePayload, attempts }
 *   - messagePayload: the full Meta Graph API messages body (pre-built)
 *
 * Retry policy:  up to MAX_ATTEMPTS (3), exponential back-off via re-enqueue
 * Run standalone: node src/workers/waSendWorker.js
 */
require('dotenv').config();
const { getRedisClient } = require('../services/redis');
const db = require('../services/database');
const socketService = require('../services/socketService');
const logger = require('../utils/logger');

const QUEUE_KEY      = 'queue:wa_send';
const BLOCK_TIMEOUT  = 5; // seconds
const MAX_ATTEMPTS   = 3;
const BACKOFF_BASE_S = 10; // seconds; doubles each retry

function mapTipoFromPayload(messagePayload) {
  const rawType = String(messagePayload?.type ?? '').trim().toLowerCase();
  if (rawType === 'interactive') return 'interactive';
  if (rawType === 'image') return 'image';
  if (rawType === 'audio') return 'audio';
  if (rawType === 'video') return 'video';
  if (rawType === 'document') return 'document';
  return 'text';
}

function mapContenidoFromPayload(messagePayload) {
  const type = String(messagePayload?.type ?? '').trim().toLowerCase();

  if (type === 'interactive') {
    const bodyText = messagePayload?.interactive?.body?.text;
    const buttons = messagePayload?.interactive?.action?.buttons;
    return {
      text: typeof bodyText === 'string' ? bodyText : '',
      buttons: Array.isArray(buttons)
        ? buttons.map((b) => ({
          id: b?.reply?.id,
          title: b?.reply?.title,
        }))
        : [],
    };
  }

  if (type === 'text') {
    return { text: messagePayload?.text?.body ?? '' };
  }

  return {
    type,
    payload: messagePayload?.[type] ?? null,
  };
}

async function processSend(payload) {
  const { tenantId, phone, messagePayload, attempts = 0 } = payload;

  if (!tenantId || !phone || !messagePayload) {
    logger.warn('waSendWorker: invalid payload', { payload });
    return;
  }

  // Load credentials
  const creds = await db.getWaCredentials(tenantId);
  const accessToken = creds?.accessToken;
  const phoneNumberId = creds?.phoneNumberId;

  if (!accessToken || !phoneNumberId) {
    logger.warn('waSendWorker: no credentials for tenant', { tenantId });
    return;
  }

  const GRAPH_URL = 'https://graph.facebook.com/v19.0';
  const url = `${GRAPH_URL}/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${accessToken}`,
      },
      body: JSON.stringify(messagePayload),
    });

    const json = await response.json();

    if (!response.ok) {
      throw Object.assign(new Error(json?.error?.message || 'Meta API error'), { waError: json?.error });
    }

    const user = await db.findOrCreateUser(phone, tenantId);
    const tipo = mapTipoFromPayload(messagePayload);
    const contenido = mapContenidoFromPayload(messagePayload);
    const mensaje = await db.saveMensaje({
      tenantId,
      userId: user?.id ?? null,
      waMsgId: json?.messages?.[0]?.id ?? null,
      direccion: 'salida',
      tipo,
      contenido,
    });

    if (mensaje) {
      socketService.emit(tenantId, 'nuevo_mensaje', {
        id: mensaje.id,
        userId: mensaje.userId,
        phone,
        tipo: mensaje.tipo,
        contenido: mensaje.contenido,
        waMsgId: mensaje.waMsgId,
        createdAt: mensaje.createdAt,
        direccion: 'salida',
      });
    }

    logger.info('waSendWorker: message sent', { tenantId, phone, waMsgId: json?.messages?.[0]?.id });
  } catch (err) {
    const nextAttempt = attempts + 1;
    logger.error('waSendWorker: send failed', {
      tenantId,
      phone,
      attempt: nextAttempt,
      message: err.message,
    });

    if (nextAttempt < MAX_ATTEMPTS) {
      const delay = BACKOFF_BASE_S * Math.pow(2, attempts);
      logger.info(`waSendWorker: re-enqueuing in ${delay}s`, { tenantId, phone });

      await new Promise((r) => setTimeout(r, delay * 1000));

      const redis = getRedisClient();
      if (redis) {
        await redis.lpush(QUEUE_KEY, JSON.stringify({ ...payload, attempts: nextAttempt }));
      }
    } else {
      logger.error('waSendWorker: max attempts reached, dropping message', { tenantId, phone });
    }
  }
}

async function start() {
  const redis = getRedisClient();
  if (!redis) {
    logger.error('Redis not available — waSendWorker cannot start');
    process.exit(1);
  }

  logger.info('waSendWorker started', { queue: QUEUE_KEY });

  while (true) {
    try {
      const result = await redis.brpop(QUEUE_KEY, BLOCK_TIMEOUT);
      if (result) {
        const [, raw] = result;
        const payload = JSON.parse(raw);
        await processSend(payload);
      }
    } catch (err) {
      logger.error('waSendWorker loop error', { message: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

start();
