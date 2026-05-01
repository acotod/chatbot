'use strict';
const crypto = require('crypto');

/**
 * Correlation-ID middleware.
 * Reads X-Correlation-Id header if provided by the caller; otherwise generates a new UUID.
 * Attaches req.correlationId and echoes it in the response header for traceability.
 */
function correlationId(req, _res, next) {
  const incoming = req.headers['x-correlation-id'];
  req.correlationId = (typeof incoming === 'string' && incoming.length <= 64)
    ? incoming
    : crypto.randomUUID();
  _res.setHeader('X-Correlation-Id', req.correlationId);
  next();
}

module.exports = correlationId;
