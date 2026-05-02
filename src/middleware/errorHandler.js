const logger = require('../utils/logger');

/**
 * Global error handler middleware.
 * Only exposes error messages to the client for operational errors
 * (those that explicitly set err.status / err.statusCode). Internal
 * errors (DB crashes, unexpected throws, etc.) return a generic message
 * so that stack traces and schema details are never leaked.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });

  const status = err.status || err.statusCode || 500;
  const isOperational = !!(err.status || err.statusCode);
  res.status(status).json({ error: isOperational ? err.message : 'Internal server error' });
}

module.exports = errorHandler;
