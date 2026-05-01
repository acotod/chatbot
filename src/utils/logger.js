const { createLogger, format, transports } = require('winston');

// Redact sensitive fields from log output
const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'password_hash', 'token', 'accessToken', 'refreshToken', 'apiKey', 'api_key', 'authorization', 'jwt', 'secret']);

function redactSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_KEYS.has(k) || SENSITIVE_KEYS.has(lk)) {
      out[k] = REDACTED;
    } else if (v && typeof v === 'object') {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const redactFormat = format((info) => {
  return redactSecrets(info);
});

const logger = createLogger({
  level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
  format: format.combine(
    redactFormat(),
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      silent: process.env.NODE_ENV === 'test',
    }),
  ],
});

module.exports = logger;
