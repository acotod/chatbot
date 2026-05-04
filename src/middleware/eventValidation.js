'use strict';

const { EVENT_REQUIRED_FIELDS, ALLOWED_DIRECTIONS } = require('../config/eventSchema');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateEventIngest(req, res, next) {
  const body = req.body;

  if (!isPlainObject(body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  for (const field of EVENT_REQUIRED_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      return res.status(400).json({ error: `Field "${field}" is required` });
    }
  }

  if (!isPlainObject(body.payload)) {
    return res.status(400).json({ error: 'Field "payload" must be an object' });
  }

  if (body.metadata !== undefined && !isPlainObject(body.metadata)) {
    return res.status(400).json({ error: 'Field "metadata" must be an object when provided' });
  }

  if (body.direction !== undefined && !ALLOWED_DIRECTIONS.has(body.direction)) {
    return res.status(400).json({
      error: `Field "direction" must be one of: ${Array.from(ALLOWED_DIRECTIONS).join(', ')}`,
    });
  }

  if (body.occurredAt !== undefined && Number.isNaN(Date.parse(body.occurredAt))) {
    return res.status(400).json({ error: 'Field "occurredAt" must be a valid ISO date' });
  }

  next();
}

module.exports = { validateEventIngest };
