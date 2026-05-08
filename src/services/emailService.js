'use strict';

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

class EmailServiceError extends Error {
  constructor(message, code = 'EMAIL_SEND_FAILED') {
    super(message);
    this.name = 'EmailServiceError';
    this.code = code;
  }
}

let cachedTransporter = null;
let cachedTransportKey = null;

function getTransportKey() {
  return JSON.stringify({
    smtpUrl: process.env.SMTP_URL || '',
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT || '',
    secure: process.env.SMTP_SECURE || '',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  });
}

function hasEmailTransportConfig() {
  return Boolean(
    process.env.SMTP_URL
    || (process.env.SMTP_HOST && process.env.SMTP_PORT)
  );
}

function buildTransportConfig() {
  if (process.env.SMTP_URL) {
    return process.env.SMTP_URL;
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_PORT) {
    throw new EmailServiceError('SMTP transport is not configured', 'EMAIL_NOT_CONFIGURED');
  }

  const port = Number(process.env.SMTP_PORT);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const auth = process.env.SMTP_USER
    ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS || '',
      }
    : undefined;

  return {
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth,
  };
}

function getTransporter() {
  if (!hasEmailTransportConfig()) {
    throw new EmailServiceError('SMTP transport is not configured', 'EMAIL_NOT_CONFIGURED');
  }

  const nextKey = getTransportKey();
  if (!cachedTransporter || cachedTransportKey !== nextKey) {
    cachedTransporter = nodemailer.createTransport(buildTransportConfig());
    cachedTransportKey = nextKey;
  }

  return cachedTransporter;
}

function resolveFromAddress(explicitFrom) {
  const value = explicitFrom || process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.ADMIN_EMAIL || '';
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

  const transporter = getTransporter();

  try {
    const result = await transporter.sendMail({
      from: resolveFromAddress(from),
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