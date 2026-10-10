'use strict';

const nodemailer = require('nodemailer');
const db = require('./database');
const { getRedisClient } = require('./redis');
const logger = require('../utils/logger');

const EMAIL_QUEUE_KEY = 'queue:email_send';

class EmailServiceError extends Error {
  constructor(message, code = 'EMAIL_SEND_FAILED') {
    super(message);
    this.name = 'EmailServiceError';
    this.code = code;
  }
}

const NON_RETRYABLE_ERROR_CODES = new Set([
  'EMAIL_RECIPIENT_REQUIRED',
  'EMAIL_RECIPIENT_INVALID',
  'EMAIL_SUBJECT_REQUIRED',
  'EMAIL_BODY_REQUIRED',
  'EMAIL_FROM_NOT_ALLOWED',
]);

function isRetryableError(err) {
  return !(err instanceof EmailServiceError) || !NON_RETRYABLE_ERROR_CODES.has(err.code);
}

const tenantTransportCache = new Map();

function getTransportKey(config) {
  return JSON.stringify({
    smtpUrl: config.smtpUrl || '',
    host: config.host || '',
    port: config.port || '',
    secure: config.secure || false,
    user: config.user || '',
    pass: config.pass || '',
  });
}

function getEnvEmailConfig() {
  return {
    smtpUrl: process.env.SMTP_URL || '',
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT || '',
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.ADMIN_EMAIL || '',
    adminBaseUrl: process.env.AGENT_PORTAL_BASE_URL || process.env.ADMIN_BASE_URL || process.env.CUSTOMER_PORTAL_BASE_URL || '',
  };
}

async function getEmailConfig(tenantId = null) {
  const envConfig = getEnvEmailConfig();
  if (!tenantId) {
    return envConfig;
  }

  try {
    const tenantConfig = await db.getEmailSettings(tenantId);
    return {
      smtpUrl: tenantConfig.smtpUrl || envConfig.smtpUrl,
      host: tenantConfig.smtpHost || envConfig.host,
      port: tenantConfig.smtpPort || envConfig.port,
      secure: (typeof tenantConfig.smtpSecure === 'boolean') ? tenantConfig.smtpSecure : envConfig.secure,
      user: tenantConfig.smtpUser || envConfig.user,
      pass: tenantConfig.smtpPass || envConfig.pass,
      from: tenantConfig.emailFrom || envConfig.from,
      adminBaseUrl: tenantConfig.adminBaseUrl || envConfig.adminBaseUrl,
    };
  } catch (err) {
    logger.warn({ tenantId, message: err.message }, 'emailService: failed to load tenant email settings; falling back to env');
    return envConfig;
  }
}

function hasEmailTransportConfig(config) {
  return Boolean(
    config.smtpUrl
    || (config.host && config.port)
  );
}

function buildTransportConfig(config) {
  if (config.smtpUrl) {
    let url;
    try {
      url = new URL(config.smtpUrl);
    } catch (_err) {
      throw new EmailServiceError('SMTP URL is invalid', 'EMAIL_SMTP_URL_INVALID');
    }
    if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
      throw new EmailServiceError('SMTP URL must use smtp:// or smtps://', 'EMAIL_SMTP_URL_INVALID');
    }

    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'smtps:' ? 465 : 587)),
      secure: url.protocol === 'smtps:',
      auth: url.username
        ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
        : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    };
  }

  if (!config.host || !config.port) {
    throw new EmailServiceError('SMTP transport is not configured', 'EMAIL_NOT_CONFIGURED');
  }

  const port = Number(config.port);
  const secure = Boolean(config.secure) || port === 465;
  const auth = config.user
    ? {
        user: config.user,
        pass: config.pass || '',
      }
    : undefined;

  return {
    host: config.host,
    port,
    secure,
    auth,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

async function getTransporter(tenantId = null) {
  const config = await getEmailConfig(tenantId);

  if (!hasEmailTransportConfig(config)) {
    throw new EmailServiceError('SMTP transport is not configured', 'EMAIL_NOT_CONFIGURED');
  }

  const cacheKey = tenantId || '__env__';
  const nextKey = getTransportKey(config);
  const cached = tenantTransportCache.get(cacheKey);

  if (!cached || cached.key !== nextKey) {
    const transporter = nodemailer.createTransport(buildTransportConfig(config));
    tenantTransportCache.set(cacheKey, { key: nextKey, transporter });
    return { transporter, config };
  }

  return { transporter: cached.transporter, config };
}

function extractEmailAddress(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(value || '')).trim().toLowerCase();
}

function extractDomain(value) {
  const address = extractEmailAddress(value);
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

function resolveFromAddress(config, explicitFrom) {
  const configuredFrom = config.from || '';
  if (!configuredFrom) {
    throw new EmailServiceError('Sender email is not configured', 'EMAIL_FROM_NOT_CONFIGURED');
  }

  if (!explicitFrom) {
    return configuredFrom;
  }

  // Allow a custom display name/mailbox, but never a different domain (anti-spoofing).
  const explicitDomain = extractDomain(explicitFrom);
  const configuredDomain = extractDomain(configuredFrom);
  if (!explicitDomain || explicitDomain !== configuredDomain) {
    throw new EmailServiceError('from must match the configured sender domain', 'EMAIL_FROM_NOT_ALLOWED');
  }

  return explicitFrom;
}

const EMAIL_ADDRESS_RE = /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/;

function isValidEmailAddress(value) {
  const address = extractEmailAddress(value);
  return EMAIL_ADDRESS_RE.test(address);
}

function validateRecipients(to) {
  const recipients = String(to).split(',').map((part) => part.trim()).filter(Boolean);
  if (recipients.length === 0 || recipients.some((recipient) => !isValidEmailAddress(recipient))) {
    throw new EmailServiceError('to must be a valid email address', 'EMAIL_RECIPIENT_INVALID');
  }
}

function validateEmailPayload({ to, subject, text, html }) {
  if (!to || !String(to).trim()) {
    throw new EmailServiceError('Recipient email is required', 'EMAIL_RECIPIENT_REQUIRED');
  }
  validateRecipients(to);
  if (!subject || !String(subject).trim()) {
    throw new EmailServiceError('Email subject is required', 'EMAIL_SUBJECT_REQUIRED');
  }
  if ((!text || !String(text).trim()) && (!html || !String(html).trim())) {
    throw new EmailServiceError('Email body is required', 'EMAIL_BODY_REQUIRED');
  }
}

async function sendEmail({
  to,
  subject,
  text,
  html,
  from,
  replyTo,
  tenantId = null,
  metadata = null,
  emailLogId = null,
  attempts = 0,
  manageLogState = true,
}) {
  validateEmailPayload({ to, subject, text, html });

  let currentEmailLogId = emailLogId;
  if (!currentEmailLogId && typeof db.createEmailLog === 'function') {
    try {
      const emailLog = await db.createEmailLog({ to, subject, tenantId, metadata });
      currentEmailLogId = emailLog?.id ?? null;
    } catch (err) {
      logger.warn({ tenantId, to, subject, message: err.message }, 'emailService: failed to create email log');
    }
  }

  try {
    const { transporter, config } = await getTransporter(tenantId);
    const fromAddress = resolveFromAddress(config, from);
    const result = await transporter.sendMail({
      from: fromAddress,
      to: String(to).trim(),
      subject: String(subject).trim(),
      text: text ? String(text) : undefined,
      html: html ? String(html) : undefined,
      replyTo: replyTo ? String(replyTo).trim() : undefined,
    });

    if (manageLogState) {
      await updateEmailLog(currentEmailLogId, 'sent', {
        attempts: Number(attempts) + 1,
        messageId: result.messageId || null,
        lastError: null,
      });
    }

    logger.info({
      tenantId,
      to: String(to).trim(),
      subject: String(subject).trim(),
      messageId: result.messageId,
      metadata,
    }, 'emailService: email sent');

    return {
      ok: true,
      messageId: result.messageId || null,
      accepted: Array.isArray(result.accepted) ? result.accepted : [],
      rejected: Array.isArray(result.rejected) ? result.rejected : [],
    };
  } catch (err) {
    logger.error({ tenantId, to, subject, message: err.message, metadata }, 'emailService: send failed');
    if (manageLogState) {
      await updateEmailLog(currentEmailLogId, 'failed', {
        attempts: Number(attempts) + 1,
        lastError: err.message,
      });
    }
    if (err instanceof EmailServiceError) throw err;
    if (err instanceof EmailServiceError) throw err;
    throw new EmailServiceError(err.message, 'EMAIL_SEND_FAILED');
  }
}

/**
 * Queues an email for async delivery with retries (see src/workers/emailSendWorker.js).
 * Falls back to a synchronous send if Redis is unavailable.
 */
async function enqueueEmail({
  to,
  subject,
  text,
  html,
  from,
  replyTo,
  tenantId = null,
  metadata = null,
}) {
  validateEmailPayload({ to, subject, text, html });

  let emailLogId = null;
  if (typeof db.createEmailLog === 'function') {
    try {
      const emailLog = await db.createEmailLog({ to, subject, tenantId, metadata });
      emailLogId = emailLog?.id ?? null;
    } catch (err) {
      logger.warn({ tenantId, to, subject, message: err.message }, 'emailService: failed to create email log');
    }
  }

  const payload = { to, subject, text, html, from, replyTo, tenantId, metadata, emailLogId, attempts: 0 };
  const redis = getRedisClient();

  if (!redis) {
    logger.warn({ tenantId, to, subject }, 'emailService: Redis unavailable, sending email synchronously');
    try {
      return await sendEmail(payload);
    } catch (err) {
      await updateEmailLog(emailLogId, 'failed', { attempts: 1, lastError: err.message });
      throw err;
    }
  }

  try {
    await redis.lpush(EMAIL_QUEUE_KEY, JSON.stringify(payload));
    logger.info({ tenantId, to, subject, metadata }, 'emailService: email queued');
    return { ok: true, queued: true };
  } catch (err) {
    logger.warn({ tenantId, to, subject, message: err.message }, 'emailService: failed to queue email, sending synchronously');
    try {
      return await sendEmail(payload);
    } catch (sendErr) {
      await updateEmailLog(emailLogId, 'failed', { attempts: 1, lastError: sendErr.message });
      throw sendErr;
    }
  }
}

async function updateEmailLog(emailLogId, status, data) {
  if (!emailLogId || typeof db.updateEmailLogStatus !== 'function') return;
  try {
    await db.updateEmailLogStatus(emailLogId, status, data);
  } catch (err) {
    logger.warn({ emailLogId, message: err.message }, 'emailService: failed to update email log');
  }
}

module.exports = {
  EmailServiceError,
  EMAIL_QUEUE_KEY,
  hasEmailTransportConfig,
  isRetryableError,
  sendEmail,
  enqueueEmail,
};