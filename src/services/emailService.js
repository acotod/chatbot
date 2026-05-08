'use strict';

const nodemailer = require('nodemailer');
const db = require('./database');
const logger = require('../utils/logger');

class EmailServiceError extends Error {
  constructor(message, code = 'EMAIL_SEND_FAILED') {
    super(message);
    this.name = 'EmailServiceError';
    this.code = code;
  }
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
    return config.smtpUrl;
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
    tls: { rejectUnauthorized: false },
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

function resolveFromAddress(config, explicitFrom) {
  const value = explicitFrom || config.from || '';
  if (!value) {
    throw new EmailServiceError('Sender email is not configured', 'EMAIL_FROM_NOT_CONFIGURED');
  }
  return value;
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
}) {
  if (!to || !String(to).trim()) {
    throw new EmailServiceError('Recipient email is required', 'EMAIL_RECIPIENT_REQUIRED');
  }
  if (!subject || !String(subject).trim()) {
    throw new EmailServiceError('Email subject is required', 'EMAIL_SUBJECT_REQUIRED');
  }
  if ((!text || !String(text).trim()) && (!html || !String(html).trim())) {
    throw new EmailServiceError('Email body is required', 'EMAIL_BODY_REQUIRED');
  }

  const { transporter, config } = await getTransporter(tenantId);

  try {
    const result = await transporter.sendMail({
      from: resolveFromAddress(config, from),
      to: String(to).trim(),
      subject: String(subject).trim(),
      text: text ? String(text) : undefined,
      html: html ? String(html) : undefined,
      replyTo: replyTo ? String(replyTo).trim() : undefined,
    });

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
    throw new EmailServiceError(err.message, 'EMAIL_SEND_FAILED');
  }
}

module.exports = {
  EmailServiceError,
  hasEmailTransportConfig,
  sendEmail,
};