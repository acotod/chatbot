'use strict';

const crypto = require('crypto');
const db = require('./database');
const { audit } = require('./audit');

const WEBHOOK_EVENTS = new Set([
  'solicitud.created',
  'solicitud.updated',
  'solicitud.status_changed',
  'solicitud.assigned',
  'solicitud.escalated',
  'solicitud.comment_added',
]);

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_err) {
    return false;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function signPayload(secret, payloadRaw) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadRaw, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

function sanitizeHeaders(inputHeaders = {}) {
  const out = {};
  for (const [key, value] of Object.entries(inputHeaders || {})) {
    const rawKey = String(key || '').trim();
    if (!rawKey) continue;
    if (/^content-length$/i.test(rawKey)) continue;
    out[rawKey] = String(value ?? '');
  }
  return out;
}

async function getTenantWebhookSecret(tenantId) {
  const cfg = await db.getConfig(tenantId, 'solicitudes_webhook_secret');
  const raw = cfg?.valor;
  const secret = typeof raw === 'string' ? raw.trim() : '';
  if (secret) return secret;

  const generated = crypto.randomBytes(32).toString('hex');
  await db.setConfig(tenantId, 'solicitudes_webhook_secret', generated);
  return generated;
}

async function dispatchSolicitudesWebhookEvent({
  tenant,
  req,
  event,
  solicitudId,
  payload,
}) {
  if (!tenant?.id || !WEBHOOK_EVENTS.has(String(event || ''))) return;

  const tenantConfig = await db.getSolicitudesEnterpriseConfig(tenant.id);
  if (!tenantConfig?.webhooksEnabled) return;

  const configs = await db.listWebhookConfigs(tenant.id, { event });
  const activeHooks = configs.filter((w) => w.active && isValidHttpUrl(w.url));
  if (!activeHooks.length) return;

  const secret = await getTenantWebhookSecret(tenant.id);
  const deliveryBase = {
    event,
    tenantId: tenant.id,
    solicitudId: solicitudId ?? null,
    occurredAt: new Date().toISOString(),
    payload,
  };

  const adminUserId = req?.admin?.adminUserId ?? null;
  const ip = req?.ip;
  const userAgent = req?.headers?.['user-agent'];

  for (const hook of activeHooks) {
    const deliveryId = crypto.randomUUID();
    const startedAt = Date.now();
    const body = {
      id: deliveryId,
      ...deliveryBase,
    };
    const rawBody = JSON.stringify(body);
    const signature = signPayload(secret, rawBody);

    const headers = {
      'Content-Type': 'application/json',
      'X-Chatbot-Event': String(event),
      'X-Chatbot-Delivery-Id': deliveryId,
      'X-Chatbot-Signature': signature,
      ...sanitizeHeaders(),
    };

    let ok = false;
    let status = null;
    let errMessage = null;

    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      ok = response.ok;
    } catch (err) {
      errMessage = err?.message || 'Webhook request failed';
    }

    const durationMs = Date.now() - startedAt;
    await db.markWebhookDeliveryResult(tenant.id, hook.id, { ok });

    audit({
      adminUserId,
      tenantId: tenant.id,
      accion: ok ? 'SOLICITUD_WEBHOOK_DELIVERED' : 'SOLICITUD_WEBHOOK_FAILED',
      entidad: 'webhook_config',
      entidadId: String(hook.id),
      ip,
      userAgent,
      metadata: {
        deliveryId,
        webhookId: hook.id,
        event,
        solicitudId: solicitudId ?? null,
        status,
        ok,
        durationMs,
        url: hook.url,
        payloadHash: sha256(rawBody),
        error: errMessage,
      },
    });
  }
}

module.exports = {
  WEBHOOK_EVENTS,
  dispatchSolicitudesWebhookEvent,
};
