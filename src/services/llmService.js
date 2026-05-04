'use strict';
/**
 * LLM Service — provider-agnostic, configurable per tenant.
 *
 * Tenant config stored in `configuraciones` table:
 *   clave  = 'llm_config'
 *   valor  = {
 *     provider   : 'openai' | 'anthropic' | 'custom',
 *     api_key    : '...',                          // kept server-side only, never returned to client
 *     model      : 'gpt-4o' | 'claude-3-5-sonnet-20241022' | 'gpt-4o-mini' | ...
 *     base_url   : 'https://api.openai.com/v1',   // optional override
 *     max_tokens : 4096,                           // default 4096
 *     timeout_ms : 30000,                          // default 30 s
 *     temperature: 0.2,                            // default 0.2 (deterministic for JSON tasks)
 *   }
 *
 * A global fallback config can be set via env vars:
 *   LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL
 */

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

const LLM_DEFAULT_TIMEOUT_MS = 90000;
const LLM_TRANSIENT_RETRIES = 1;

// ─── Defaults ────────────────────────────────────────────────────────────────

const GLOBAL_FALLBACK = {
  provider  : process.env.LLM_PROVIDER  || null,
  api_key   : process.env.LLM_API_KEY   || null,
  model     : process.env.LLM_MODEL     || 'gpt-4o-mini',
  base_url  : process.env.LLM_BASE_URL  || 'https://api.openai.com/v1',
  max_tokens: 4096,
  timeout_ms: LLM_DEFAULT_TIMEOUT_MS,
  temperature: 0.2,
};

const PROVIDER_DEFAULTS = {
  openai    : { base_url: 'https://api.openai.com/v1',             model: 'gpt-4o-mini'                    },
  anthropic : { base_url: 'https://api.anthropic.com/v1',          model: 'claude-sonnet-4-20250514'       },
  custom    : { base_url: process.env.LLM_BASE_URL || '',          model: process.env.LLM_MODEL || ''      },
};

const ANTHROPIC_MODEL_ALIASES = {
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-latest':   'claude-sonnet-4-20250514',
  'claude-3-5-haiku-20241022':  'claude-sonnet-4-20250514',
  'claude-3-5-haiku-latest':    'claude-sonnet-4-20250514',
};

// ─── Config loader ────────────────────────────────────────────────────────────

/**
 * Load the LLM config for a tenant (or fall back to global env config).
 * @param {string} tenantId
 * @returns {object|null}  Null if no config is available.
 */
async function getLlmConfig(tenantId) {
  try {
    const cfg = await prisma.configuracion.findUnique({
      where: { tenantId_clave: { tenantId, clave: 'llm_config' } },
    });
    if (cfg?.valor?.api_key) return mergeWithDefaults(cfg.valor);
  } catch (err) {
    logger.warn({ tenantId, err: err.message }, 'llmService: failed to read tenant llm_config');
  }

  // Global fallback
  if (GLOBAL_FALLBACK.provider && GLOBAL_FALLBACK.api_key) {
    return mergeWithDefaults(GLOBAL_FALLBACK);
  }

  return null;
}

function mergeWithDefaults(cfg) {
  const providerDefs = PROVIDER_DEFAULTS[cfg.provider] || PROVIDER_DEFAULTS.custom;
  const provider = cfg.provider || 'openai';
  let model = cfg.model || providerDefs.model;

  if (provider === 'anthropic') {
    model = ANTHROPIC_MODEL_ALIASES[model] || model;
  }

  return {
    provider,
    api_key    : cfg.api_key,
    model,
    base_url   : cfg.base_url    || providerDefs.base_url,
    max_tokens : cfg.max_tokens  || 4096,
    timeout_ms : cfg.timeout_ms  || LLM_DEFAULT_TIMEOUT_MS,
    temperature: cfg.temperature ?? 0.2,
  };
}

// ─── Provider adapters ────────────────────────────────────────────────────────

/**
 * Build fetch options for OpenAI-compatible APIs (openai, custom).
 */
function buildOpenAiRequest(cfg, systemPrompt, userPrompt) {
  const url = `${cfg.base_url.replace(/\/$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model      : cfg.model,
    max_tokens : cfg.max_tokens,
    temperature: cfg.temperature,
    messages   : [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  });
  const headers = {
    'Content-Type' : 'application/json',
    'Authorization': `Bearer ${cfg.api_key}`,
  };
  return { url, body, headers };
}

/**
 * Build fetch options for Anthropic Messages API.
 */
function buildAnthropicRequest(cfg, systemPrompt, userPrompt) {
  const url = `${cfg.base_url.replace(/\/$/, '')}/messages`;
  const body = JSON.stringify({
    model      : cfg.model,
    max_tokens : cfg.max_tokens,
    temperature: cfg.temperature,
    system     : systemPrompt,
    messages   : [{ role: 'user', content: userPrompt }],
  });
  const headers = {
    'Content-Type'     : 'application/json',
    'x-api-key'        : cfg.api_key,
    'anthropic-version': '2023-06-01',
  };
  return { url, body, headers };
}

/**
 * Extract text from response body depending on provider.
 */
function extractText(provider, data) {
  if (provider === 'anthropic') {
    return data?.content?.[0]?.text ?? null;
  }
  // OpenAI-compatible
  return data?.choices?.[0]?.message?.content ?? null;
}

// ─── Core call ────────────────────────────────────────────────────────────────

/**
 * Call the LLM for a given tenant.
 *
 * @param {string}  tenantId
 * @param {string}  systemPrompt
 * @param {string}  userPrompt
 * @returns {{ text: string, provider: string, model: string }|null}
 *          Returns null if no LLM is configured or the call fails.
 */
async function callLlm(tenantId, systemPrompt, userPrompt) {
  const cfg = await getLlmConfig(tenantId);
  if (!cfg) {
    logger.info({ tenantId }, 'llmService: no LLM config — skipping AI enhancement');
    return null;
  }

  const builder = cfg.provider === 'anthropic' ? buildAnthropicRequest : buildOpenAiRequest;
  const { url, body, headers } = builder(cfg, systemPrompt, userPrompt);

  for (let attempt = 0; attempt <= LLM_TRANSIENT_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);

    try {
      const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });

      if (!response.ok) {
        const errText = await response.text().catch(() => '(unreadable)');
        const canRetry = attempt < LLM_TRANSIENT_RETRIES && (response.status >= 500 || response.status === 429);
        logger.warn({ tenantId, status: response.status, attempt: attempt + 1, canRetry, errText }, 'llmService: provider returned error');
        if (canRetry) continue;
        return null;
      }

      const data = await response.json();
      const text = extractText(cfg.provider, data);

      if (!text) {
        logger.warn({ tenantId, attempt: attempt + 1, data }, 'llmService: empty text in provider response');
        return null;
      }

      return { text, provider: cfg.provider, model: cfg.model };
    } catch (err) {
      const canRetry = attempt < LLM_TRANSIENT_RETRIES;
      if (err.name === 'AbortError') {
        logger.warn({ tenantId, timeout_ms: cfg.timeout_ms, attempt: attempt + 1, canRetry }, 'llmService: request timed out');
      } else {
        logger.error({ tenantId, attempt: attempt + 1, canRetry, err: err.message }, 'llmService: unexpected error');
      }
      if (!canRetry) return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

/**
 * Call the LLM and attempt to extract JSON from the response.
 * Strips markdown code fences if present.
 *
 * @param {string}  tenantId
 * @param {string}  systemPrompt
 * @param {string}  userPrompt
 * @returns {{ json: object, provider: string, model: string }|null}
 */
async function callLlmForJson(tenantId, systemPrompt, userPrompt) {
  const result = await callLlm(tenantId, systemPrompt, userPrompt);
  if (!result) return null;

  // Strip markdown fences: ```json ... ``` or ``` ... ```
  const cleaned = result.text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  try {
    const json = JSON.parse(cleaned);
    return { json, provider: result.provider, model: result.model };
  } catch {
    // Try to extract first {...} or [...] block
    const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) {
      try {
        const json = JSON.parse(match[1]);
        return { json, provider: result.provider, model: result.model };
      } catch { /* fall through */ }
    }
    logger.warn({ tenantId, raw: result.text.slice(0, 200) }, 'llmService: could not parse LLM response as JSON');
    return null;
  }
}

// ─── Config helpers (for admin routes) ───────────────────────────────────────

/**
 * Check if an LLM is available for a tenant (without exposing the key).
 * @param {string} tenantId
 * @returns {{ available: boolean, provider: string|null, model: string|null }}
 */
async function getLlmStatus(tenantId) {
  const cfg = await getLlmConfig(tenantId);
  if (!cfg) return { available: false, provider: null, model: null };
  return { available: true, provider: cfg.provider, model: cfg.model };
}

// ─── Flow generator ───────────────────────────────────────────────────────────

const GENERATE_FLOW_SYSTEM = `You are an expert WhatsApp Business Flows designer.
Generate a valid Meta WhatsApp Flow JSON (version 7.1, data_api_version 3.0) from the user's description.

Rules:
- version must be "7.1", data_api_version must be "3.0"
- routing_model maps screen id -> array of next screen ids
- Every flow needs at least one terminal screen (terminal: true)
- Screen IDs must be SCREAMING_SNAKE_CASE
- Use EmbeddedLink, TextHeading, TextBody, TextInput, RadioButtonsGroup, Footer component types
- Footer must be the last child in each screen with "enabled": true
- Respond ONLY with the JSON object, no markdown, no explanation.`;

/**
 * Generate a Meta WhatsApp Flow JSON from a natural-language prompt.
 * @param {string} tenantId
 * @param {string} prompt
 * @returns {{ json: object, provider: string, model: string }|null}
 */
async function generateFlow(tenantId, prompt) {
  const userPrompt = `Design a WhatsApp Flow for the following use case:\n\n${prompt}\n\nReturn only the JSON.`;
  return callLlmForJson(tenantId, GENERATE_FLOW_SYSTEM, userPrompt);
}

module.exports = { callLlm, callLlmForJson, getLlmConfig, getLlmStatus, generateFlow };
