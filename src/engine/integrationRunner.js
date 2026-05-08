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
const logger = require('../utils/logger');
const { resolveTemplate, resolveConfig } = require('./nodeExecutors');
const convLogger = require('./conversationLogger');

const prisma = new PrismaClient();

// Simple in-process cache to avoid hitting DB on every action node.
// TTL: 60 seconds. Cache is keyed by tenantId+nombre.
const _cache = new Map();
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

  // Resolve templates in endpoint, headers, and body
  const endpoint = normalizeEndpointUrl(resolveTemplate(cfg.endpoint ?? '', variables));
  const method   = (cfg.method ?? 'POST').toUpperCase();
  const timeoutMs = cfg.timeout_ms ?? 8000;
  const retries   = cfg.retry_count ?? 1;

  // Build headers
  const headers = { ...(cfg.headers ?? {}) };
  _applyAuth(headers, cfg.auth, variables);

  // Build body
  const bodyMap  = resolveConfig(cfg.body_mapping ?? {}, variables);
  const bodyJson = JSON.stringify(bodyMap);

  await convLogger.log(
    opts.conversationId ?? null,
    tenantId,
    opts.nodeRef ?? null,
    convLogger.EVENT.API_CALL,
    {
      integration_ref: integrationRef,
      integration_id : integration.id ?? null,
      integration_type: integration.tipo ?? null,
      node_type      : opts.nodeType ?? null,
      trigger        : opts.trigger ?? 'flow_node',
      endpoint,
      method,
      request_body   : bodyMap,
    },
  );

  // Execute with retry
  let lastError;
  for (let attempt = 1; attempt <= Math.max(1, retries); attempt++) {
    try {
      const raw = await _fetch(endpoint, method, headers, bodyJson, timeoutMs);
      const responseVars = _mapResponse(raw, cfg.response_mapping ?? {});
      await convLogger.log(
        opts.conversationId ?? null,
        tenantId,
        opts.nodeRef ?? null,
        convLogger.EVENT.API_RESPONSE,
        {
          integration_ref: integrationRef,
          node_type      : opts.nodeType ?? null,
          trigger        : opts.trigger ?? 'flow_node',
          endpoint,
          method,
          attempt,
          raw_response   : raw,
          response_vars  : responseVars,
        },
      );
      logger.info({ tenantId, integrationRef, attempt }, 'integrationRunner: success');
      return { responseVars, rawResponse: raw };
    } catch (err) {
      lastError = err;
      await convLogger.log(
        opts.conversationId ?? null,
        tenantId,
        opts.nodeRef ?? null,
        convLogger.EVENT.FLOW_ERROR,
        {
          integration_ref: integrationRef,
          node_type      : opts.nodeType ?? null,
          trigger        : opts.trigger ?? 'flow_node',
          endpoint,
          method,
          attempt,
          error_message  : err.message,
        },
      );
      logger.warn({ tenantId, integrationRef, attempt, message: err.message }, 'integrationRunner: attempt failed');
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
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
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
