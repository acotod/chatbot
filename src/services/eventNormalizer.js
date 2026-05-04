'use strict';

const crypto = require('crypto');
const { CANONICAL_EVENT_VERSION, ALLOWED_DIRECTIONS } = require('../config/eventSchema');

function makeEventId() {
  return `evt_${crypto.randomUUID().replace(/-/g, '')}`;
}

function normalizeOccurredAt(rawValue) {
  if (!rawValue) return new Date();
  const date = new Date(rawValue);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function buildIdempotencyKey({ tenantId, channel, source, eventType, occurredAt, payload, explicitKey }) {
  if (explicitKey) return String(explicitKey);

  const digestInput = JSON.stringify({
    tenantId,
    channel,
    source,
    eventType,
    occurredAt,
    payload,
  });

  return crypto.createHash('sha256').update(digestInput).digest('hex');
}

function normalizeEvent({ tenantId, rawEvent, correlationId, idempotencyKeyHeader }) {
  const event = rawEvent || {};
  const occurredAt = normalizeOccurredAt(event.occurredAt);
  const direction = ALLOWED_DIRECTIONS.has(event.direction) ? event.direction : 'inbound';

  const metadata = {
    ...(event.metadata || {}),
    correlationId,
  };

  const idempotencyKey = buildIdempotencyKey({
    tenantId,
    channel: event.channel,
    source: event.source,
    eventType: event.eventType,
    occurredAt: occurredAt.toISOString(),
    payload: event.payload,
    explicitKey: idempotencyKeyHeader || event.idempotencyKey || event.externalEventId,
  });

  return {
    tenantId,
    eventId: event.eventId || makeEventId(),
    eventVersion: event.eventVersion || CANONICAL_EVENT_VERSION,
    channel: event.channel,
    source: event.source,
    eventType: event.eventType,
    direction,
    idempotencyKey,
    occurredAt,
    payload: event.payload,
    metadata,
    rawEvent: event,
  };
}

module.exports = { normalizeEvent };
