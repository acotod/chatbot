/**
 * Urgencia Worker
 * Consumes the 'queue:urgencias' Redis list (BRPOP) and processes each event.
 *
 * Run standalone:  node src/workers/urgenciaWorker.js
 *
 * For each urgencia event the worker:
 *   1. Logs the alert (structured)
 *   2. Updates the related solicitud estado to 'urgente' if one exists
 *   3. TODO: send email / Slack / push notification
 */
require('dotenv').config();
const { getRedisClient } = require('../services/redis');
const db = require('../services/database');
const logger = require('../utils/logger');

const QUEUE_KEY = 'queue:urgencias';
const BLOCK_TIMEOUT = 5; // seconds

async function processUrgencia(payload) {
  const { tenantId, userId, screen, data, timestamp } = payload;

  logger.warn('URGENCIA detected', { tenantId, userId, screen, data, timestamp });

  // If there is an open solicitud for this user, mark it as urgente
  if (userId && tenantId) {
    try {
      const client = db.getPrismaClient();
      if (client) {
        const solicitud = await client.solicitud.findFirst({
          where: { tenantId, userId, estado: 'pendiente' },
          orderBy: { createdAt: 'desc' },
        });
        if (solicitud) {
          await db.updateSolicitudEstado(solicitud.id, tenantId, 'urgente');
          logger.info('Solicitud marked urgente', { id: solicitud.id, tenantId });
        }
      }
    } catch (err) {
      logger.error('Failed to update solicitud estado', { message: err.message });
    }
  }

  // TODO: integrate email (nodemailer), Slack webhook, or push notification here
}

async function start() {
  const redis = getRedisClient();
  if (!redis) {
    logger.error('Redis not available — urgencia worker cannot start');
    process.exit(1);
  }

  logger.info('Urgencia worker started', { queue: QUEUE_KEY });

  while (true) {
    try {
      const result = await redis.brpop(QUEUE_KEY, BLOCK_TIMEOUT);
      if (result) {
        const [, raw] = result;
        const payload = JSON.parse(raw);
        await processUrgencia(payload);
      }
    } catch (err) {
      logger.error('Worker loop error', { message: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

start();
