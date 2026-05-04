'use strict';

const CANONICAL_EVENT_VERSION = '1.0';

const EVENT_REQUIRED_FIELDS = [
  'channel',
  'source',
  'eventType',
  'payload',
];

const ALLOWED_DIRECTIONS = new Set(['inbound', 'outbound', 'internal']);

module.exports = {
  CANONICAL_EVENT_VERSION,
  EVENT_REQUIRED_FIELDS,
  ALLOWED_DIRECTIONS,
};
