'use strict';

const db = require('./database');
const logger = require('../utils/logger');
const { getRedisClient } = require('./redis');
const { normalizeEvent } = require('./eventNormalizer');

const INGEST_QUEUE_KEY = 'queue:events_ingest';

async function enqueueNormalizedEvent(normalized) {
  const redis = getRedisClient();
  if (!redis) return { queued: false, queueKey: null };

  await redis.lpush(INGEST_QUEUE_KEY, JSON.stringify(normalized));
  return { queued: true, queueKey: INGEST_QUEUE_KEY };
}

async function ingestEvent({ tenantId, rawEvent, correlationId, idempotencyKeyHeader }) {
  const normalized = normalizeEvent({ tenantId, rawEvent, correlationId, idempotencyKeyHeader });

  const existing = await db.findEventLogByIdempotencyKey(tenantId, normalized.idempotencyKey);
  if (existing) {
    return {
      duplicate: true,
      eventLog: existing,
      normalized,
      queued: false,
      queueKey: null,
    };
  }

  let eventLog = null;
  try {
    eventLog = await db.saveEventLog(normalized);

    const queueResult = await enqueueNormalizedEvent(normalized);
    await db.markEventLogStatus(eventLog.id, queueResult.queued ? 'queued' : 'ingested');

    return {
      duplicate: false,
      eventLog,
      normalized,
      queued: queueResult.queued,
      queueKey: queueResult.queueKey,
    };
  } catch (err) {
    logger.error('UEG ingest failed', {
      tenantId,
      correlationId,
      message: err.message,
    });

    await db.saveDeadLetter({
      tenantId,
      eventLogId: eventLog?.id,
      reason: 'UEG_INGEST_ERROR',
      error: { message: err.message },
      payload: { rawEvent },
    });

    if (eventLog?.id) {
      await db.markEventLogStatus(eventLog.id, 'failed', {
        lastError: err.message,
        incrementAttempts: true,
      });
    }

    throw err;
  }
}

module.exports = {
  ingestEvent,
  INGEST_QUEUE_KEY,
};
