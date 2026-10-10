'use strict';
require('dotenv').config();
const os = require('os');
const db = require('../services/database');
const { getRedisClient } = require('../services/redis');
const { sendEmail, isRetryableError, EMAIL_QUEUE_KEY } = require('../services/emailService');
const logger = require('../utils/logger');

const WORKER_ID = process.env.EMAIL_WORKER_ID || os.hostname();
const PROCESSING_QUEUE_KEY = `${EMAIL_QUEUE_KEY}:processing:${WORKER_ID}`;
const DELAYED_QUEUE_KEY = `${EMAIL_QUEUE_KEY}:delayed`;
const DEAD_QUEUE_KEY = `${EMAIL_QUEUE_KEY}:dead`;
const BLOCK_TIMEOUT = 2; // seconds
const MAX_ATTEMPTS   = Number(process.env.EMAIL_MAX_ATTEMPTS || 4);
const BACKOFF_BASE_S = 10; // seconds; doubles each retry

async function updateEmailLog(payload, status, data) {
  if (!payload.emailLogId || typeof db.updateEmailLogStatus !== 'function') return;
  try {
    await db.updateEmailLogStatus(payload.emailLogId, status, data);
  } catch (err) {
    logger.error({ emailLogId: payload.emailLogId, message: err.message }, 'emailSendWorker: failed to update email log');
  }
}

async function processEmail(payload, redis) {
  const { to, subject, tenantId, attempts = 0 } = payload;

  if (!to || !subject) {
    logger.warn('emailSendWorker: invalid payload', { payload });
    await redis.lpush(DEAD_QUEUE_KEY, JSON.stringify({ payload, error: 'Missing recipient or subject' }));
    await updateEmailLog(payload, 'failed', { attempts, lastError: 'Missing recipient or subject' });
    return;
  }

  try {
    const result = await sendEmail({ ...payload, manageLogState: false });
    await updateEmailLog(payload, 'sent', {
      attempts: attempts + 1,
      messageId: result?.messageId || null,
      lastError: null,
    });
    logger.info('emailSendWorker: email sent', { tenantId, to, subject, messageId: result?.messageId });
    return;
  } catch (err) {
    const nextAttempt = attempts + 1;
    logger.error('emailSendWorker: send failed', {
      tenantId,
      to,
      subject,
      attempt: nextAttempt,
      code: err.code,
      message: err.message,
    });

    if (!isRetryableError(err)) {
      logger.error('emailSendWorker: non-retryable error, dropping message', { tenantId, to, subject, code: err.code });
      await redis.lpush(DEAD_QUEUE_KEY, JSON.stringify({ payload, error: err.message, code: err.code }));
      await updateEmailLog(payload, 'failed', { attempts: nextAttempt, lastError: err.message });
      return;
    }

    if (nextAttempt < MAX_ATTEMPTS) {
      const delay = BACKOFF_BASE_S * Math.pow(2, attempts);
      logger.info(`emailSendWorker: re-enqueuing in ${delay}s`, { tenantId, to, subject });
      const retryPayload = JSON.stringify({ ...payload, attempts: nextAttempt });
      await redis.zadd(DELAYED_QUEUE_KEY, Date.now() + delay * 1000, retryPayload);
      await updateEmailLog(payload, 'retrying', { attempts: nextAttempt, lastError: err.message });
    } else {
      logger.error('emailSendWorker: max attempts reached, dropping message', { tenantId, to, subject });
      await redis.lpush(DEAD_QUEUE_KEY, JSON.stringify({ payload, error: err.message, code: err.code }));
      await updateEmailLog(payload, 'failed', { attempts: nextAttempt, lastError: err.message });
    }
  }
}

async function recoverInFlight(redis) {
  const script = `
    local moved = 0
    while redis.call('LLEN', KEYS[1]) > 0 do
      redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
      moved = moved + 1
    end
    return moved
  `;
  return redis.eval(script, 2, PROCESSING_QUEUE_KEY, EMAIL_QUEUE_KEY);
}

async function promoteDueRetries(redis) {
  const script = `
    local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
    for _, job in ipairs(due) do
      if redis.call('ZREM', KEYS[1], job) == 1 then
        redis.call('LPUSH', KEYS[2], job)
      end
    end
    return #due
  `;
  return redis.eval(script, 2, DELAYED_QUEUE_KEY, EMAIL_QUEUE_KEY, Date.now(), 25);
}

async function processQueuedJob(raw, redis) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    await redis.lpush(DEAD_QUEUE_KEY, JSON.stringify({ raw, error: err.message }));
    await redis.lrem(PROCESSING_QUEUE_KEY, 1, raw);
    logger.error('emailSendWorker: invalid job moved to dead-letter queue', { message: err.message });
    return;
  }

  try {
    await processEmail(payload, redis);
    await redis.lrem(PROCESSING_QUEUE_KEY, 1, raw);
  } catch (err) {
    await redis.lrem(PROCESSING_QUEUE_KEY, 1, raw);
    await redis.lpush(EMAIL_QUEUE_KEY, raw);
    throw err;
  }
}

async function start() {
  const redis = getRedisClient();
  if (!redis) {
    logger.error('Redis not available — emailSendWorker cannot start');
    process.exit(1);
  }

  logger.info('emailSendWorker started', { queue: EMAIL_QUEUE_KEY });
  const recovered = await recoverInFlight(redis);
  if (recovered) logger.warn('emailSendWorker: recovered in-flight jobs', { count: recovered });

  while (true) {
    try {
      await promoteDueRetries(redis);
      const raw = await redis.brpoplpush(EMAIL_QUEUE_KEY, PROCESSING_QUEUE_KEY, BLOCK_TIMEOUT);
      if (!raw) continue;
      await processQueuedJob(raw, redis);
    } catch (err) {
      logger.error('emailSendWorker loop error', { message: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

if (require.main === module) {
  start().catch((err) => {
    logger.error('emailSendWorker failed to start', { message: err.message });
    process.exit(1);
  });
}

module.exports = {
  PROCESSING_QUEUE_KEY,
  processEmail,
  processQueuedJob,
  promoteDueRetries,
  recoverInFlight,
};
