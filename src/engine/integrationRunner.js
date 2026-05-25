'use strict';
/**
 * IntegrationRunner — resolves and executes dynamic integrations.
 *
 * Action nodes reference an integration by name (integration_ref).
 * This module loads the Integration config from the DB, applies variable
 * interpolation, executes the HTTP call, and maps the response back to
 * session variables.
 *
 * Config JSONB shape (stored in integrations.config):
 *   {
 *     "endpoint":    "https://api.cliente.com/webhook",
 *     "method":      "POST",
 *     "timeout_ms":  5000,
 *     "retry_count": 2,
 *     "headers":     { "Content-Type": "application/json" },
 *     "auth": {
 *       "type":   "apikey",    // "none" | "apikey" | "bearer" | "basic"
 *       "header": "X-Api-Key",
 *       "value":  "sk-secret-key"
 *     },
 *     "body_mapping":     { "nombre": "{{name}}", "phone": "{{phone}}" },
 *     "response_mapping": { "ticket_id": "data.id", "status": "status" }
 *   }
 *
 * Auth types:
 *   none    → no auth header
 *   apikey  → adds config.auth.header: config.auth.value
 *   bearer  → adds Authorization: Bearer <value>
 *   basic   → adds Authorization: Basic base64(user:pass)
 */

const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const { resolveTemplate, resolveConfig } = require('./nodeExecutors');
const convLogger = require('./conversationLogger');

const prisma = new PrismaClient();

// Simple in-process cache to avoid hitting DB on every action node.
// TTL: 60 seconds. Cache is keyed by tenantId+nombre.
const _cache = new Map();
const _tenantMetaCache = new Map();
const CACHE_TTL_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run an integration by its registered name for a given tenant.
 *
 * @param {string} tenantId
 * @param {string} integrationRef   - nombre in integrations table
 * @param {object} variables        - current session variables for template resolution
 * @param {object} [opts]
 * @param {string|null} [opts.conversationId]
 * @param {string|null} [opts.nodeRef]
 * @param {string|null} [opts.nodeType]
 * @param {string|null} [opts.trigger]
 * @returns {Promise<{ responseVars: object, rawResponse: any }>}
 */
async function run(tenantId, integrationRef, variables, opts = {}) {
  const integration = await _loadIntegration(tenantId, integrationRef);

  if (!integration) {
    throw new Error(`Integration "${integrationRef}" not found or inactive for tenant ${tenantId}`);
  }

  const cfg = integration.config;
  const tenantMeta = await _loadTenantMeta(tenantId);
  const runtimeVars = {
    ...(variables ?? {}),
    tenant_id: tenantId,
    tenantId,
    tenant: tenantMeta?.slug ?? tenantId,
    ...(tenantMeta?.slug ? { tenant_slug: tenantMeta.slug, tenantSlug: tenantMeta.slug } : {}),
  };

  // Resolve templates in endpoint, headers, and body
  const endpoint = normalizeEndpointUrl(resolveTemplate(cfg.endpoint ?? '', runtimeVars));
  const method   = (cfg.method ?? 'POST').toUpperCase();
  const timeoutMs = cfg.timeout_ms ?? 8000;
  const retries   = Number.isFinite(Number(cfg.retry_count)) ? Number(cfg.retry_count) : 1;
  const maxAttempts = Math.max(1, retries);
  const retryBackoffMs = Number.isFinite(Number(cfg.retry_backoff_ms))
    ? Math.max(0, Number(cfg.retry_backoff_ms))
    : 0;
  const callId = randomUUID();

  // Build headers
  const headers = { ...(cfg.headers ?? {}) };
  _applyAuth(headers, cfg.auth, runtimeVars);

  // Build body
  const bodyMap  = resolveConfig(cfg.body_mapping ?? {}, runtimeVars);
  const bodyJson = JSON.stringify(bodyMap);

  // Execute with retry
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();

    await convLogger.log(
      opts.conversationId ?? null,
      tenantId,
      opts.nodeRef ?? null,
      convLogger.EVENT.API_CALL,
      {
        call_id: callId,
        integration_ref: integrationRef,
        integration_id : integration.id ?? null,
        integration_type: integration.tipo ?? null,
        node_type      : opts.nodeType ?? null,
        trigger        : opts.trigger ?? 'flow_node',
        endpoint,
        method,
        timeout_ms: timeoutMs,
        max_attempts: maxAttempts,
        attempt,
        request_body   : _sanitizeForLog(bodyMap),
      },
    );

    try {
      const response = await _fetch(endpoint, method, headers, bodyJson, timeoutMs);
      const durationMs = Date.now() - startedAt;
      const responseVars = _mapResponse(response.data, cfg.response_mapping ?? {});

      await convLogger.log(
        opts.conversationId ?? null,
        tenantId,
        opts.nodeRef ?? null,
        convLogger.EVENT.API_RESPONSE,
        {
          call_id: callId,
          integration_ref: integrationRef,
          integration_id : integration.id ?? null,
          integration_type: integration.tipo ?? null,
          node_type      : opts.nodeType ?? null,
          trigger        : opts.trigger ?? 'flow_node',
          endpoint,
          method,
          max_attempts: maxAttempts,
          attempt,
          duration_ms: durationMs,
          status_code: response.statusCode,
          response_headers: _sanitizeHeaders(response.headers),
          raw_response   : _sanitizeForLog(response.data),
          response_vars  : responseVars,
        },
      );
      logger.info({ tenantId, integrationRef, callId, attempt, durationMs, statusCode: response.statusCode }, 'integrationRunner: success');
      return { responseVars, rawResponse: response.data, callId, attempt, durationMs, statusCode: response.statusCode };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      lastError = err;

      await convLogger.log(
        opts.conversationId ?? null,
        tenantId,
        opts.nodeRef ?? null,
        convLogger.EVENT.FLOW_ERROR,
        {
          call_id: callId,
          integration_ref: integrationRef,
          integration_id : integration.id ?? null,
          integration_type: integration.tipo ?? null,
          node_type      : opts.nodeType ?? null,
          trigger        : opts.trigger ?? 'flow_node',
          endpoint,
          method,
          max_attempts: maxAttempts,
          attempt,
          duration_ms: durationMs,
          status_code: err.statusCode ?? null,
          error_type: _classifyError(err),
          response_body: _sanitizeErrorBody(err.responseBody),
          error_message  : err.message,
        },
      );

      if (attempt < maxAttempts) {
        await convLogger.log(
          opts.conversationId ?? null,
          tenantId,
          opts.nodeRef ?? null,
          convLogger.EVENT.API_RETRY,
          {
            call_id: callId,
            integration_ref: integrationRef,
            endpoint,
            method,
            failed_attempt: attempt,
            next_attempt: attempt + 1,
            retry_backoff_ms: retryBackoffMs,
            reason: err.message,
          },
        );

        if (retryBackoffMs > 0) {
          await _sleep(retryBackoffMs);
        }
      }

      logger.warn({ tenantId, integrationRef, callId, attempt, durationMs, message: err.message }, 'integrationRunner: attempt failed');
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _loadIntegration(tenantId, nombre) {
  const cacheKey = `${tenantId}::${nombre}`;
  const cached   = _cache.get(cacheKey);

  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const integration = await prisma.integration.findFirst({
      where : { tenantId, nombre, activo: true },
      select: { id: true, config: true, tipo: true },
    });
    _cache.set(cacheKey, { value: integration, ts: Date.now() });
    return integration;
  } catch (err) {
    logger.error({ tenantId, nombre, message: err.message }, 'integrationRunner._loadIntegration: DB error');
    return null;
  }
}

async function _loadTenantMeta(tenantId) {
  if (!tenantId) return null;

  const cached = _tenantMetaCache.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true },
    });

    _tenantMetaCache.set(tenantId, { value: tenant, ts: Date.now() });
    return tenant;
  } catch (err) {
    logger.warn({ tenantId, message: err.message }, 'integrationRunner._loadTenantMeta: DB error');
    return null;
  }
}

function _applyAuth(headers, auth, variables) {
  if (!auth || auth.type === 'none') return;

  const type  = auth.type ?? 'none';
  const value = resolveTemplate(auth.value ?? '', variables);

  if (type === 'apikey' && auth.header) {
    headers[auth.header] = value;
  } else if (type === 'bearer') {
    headers['Authorization'] = `Bearer ${value}`;
  } else if (type === 'basic') {
    const user = resolveTemplate(auth.user ?? '', variables);
    const pass = resolveTemplate(auth.pass ?? '', variables);
    headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
}

function normalizeEndpointUrl(endpoint) {
  if (typeof endpoint !== 'string') return endpoint;
  const trimmed = endpoint.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.startsWith('/')) return trimmed;

  const base = (process.env.INTERNAL_API_BASE_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`).replace(/\/$/, '');
  return `${base}${trimmed}`;
}

/**
 * Minimal fetch using Node's built-in https/http module (no extra deps).
 */
function _fetch(url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib   = url.startsWith('https') ? require('https') : require('http');
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      port    : urlObj.port || (url.startsWith('https') ? 443 : 80),
      path    : urlObj.pathname + urlObj.search,
      method,
      headers : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const statusCode = Number(res.statusCode || 0);
        const contentType = String(res.headers?.['content-type'] || '');

        // Treat upstream 4xx/5xx as hard failures so flow action nodes
        // can follow their error branch instead of continuing as success.
        if (statusCode >= 400) {
          const err = new Error(`HTTP ${statusCode} from integration endpoint`);
          err.statusCode = statusCode;
          err.contentType = contentType;
          err.responseBody = data;
          err.headers = res.headers;
          return reject(err);
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }

        resolve({
          statusCode,
          headers: res.headers,
          data: parsed,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Integration request timed out after ${timeoutMs}ms`));
    });

    if (body) req.write(body);
    req.end();
  });
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _classifyError(err) {
  if (!err) return 'unknown';
  if (err.statusCode) return 'http_error';
  if (String(err.message || '').toLowerCase().includes('timed out')) return 'timeout';
  return 'network_error';
}

function _sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const hidden = ['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'set-cookie'];
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (hidden.includes(String(key).toLowerCase())) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = value;
  }
  return out;
}

function _sanitizeForLog(value, maxLen = 2000) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > maxLen ? `${value.slice(0, maxLen)}...[truncated]` : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => _sanitizeForLog(item, maxLen));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const lower = String(k).toLowerCase();
      if (['password', 'token', 'authorization', 'cookie', 'secret', 'apikey', 'api_key'].includes(lower)) {
        out[k] = '[redacted]';
      } else {
        out[k] = _sanitizeForLog(v, maxLen);
      }
    }
    return out;
  }

  return value;
}

function _sanitizeErrorBody(body, maxLen = 2000) {
  if (body == null) return null;
  if (typeof body === 'string') {
    return body.length > maxLen ? `${body.slice(0, maxLen)}...[truncated]` : body;
  }
  return _sanitizeForLog(body, maxLen);
}

/**
 * Map response fields to session variables using dot-notation paths.
 * response_mapping: { "ticket_id": "data.id", "status": "status" }
 */
function _mapResponse(response, mapping) {
  const result = {};
  for (const [varName, path] of Object.entries(mapping)) {
    result[varName] = _getByPath(response, path);
  }
  return result;
}

function _getByPath(obj, path) {
  if (!path || obj == null) return undefined;
  return path.split('.').reduce((acc, key) => (acc != null ? acc[key] : undefined), obj);
}

module.exports = { run };
