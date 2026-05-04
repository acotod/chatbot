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
const LLM_TRANSIENT_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        const isTransient = response.status >= 500 || response.status === 429 || response.status === 529;
        const canRetry = attempt < LLM_TRANSIENT_RETRIES && isTransient;
        const delayMs = Math.min(1000 * 2 ** attempt, 8000); // 1s, 2s, 4s, max 8s
        logger.warn({ tenantId, status: response.status, attempt: attempt + 1, canRetry, delayMs, errText }, 'llmService: provider returned error');
        if (canRetry) { await sleep(delayMs); continue; }
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

const GENERATE_FLOW_SYSTEM = `Eres un generador de flujos conversacionales estructurados para WhatsApp (WABA).

Reglas obligatorias:
1) Estructura obligatoria por pantalla:
- id
- mensaje
- botones (si aplica)
- inputs (si aplica)
- acciones (guardar / webhook cuando corresponda)
- routing (siempre requerido)

2) Menus y decisiones:
- Toda decision debe representarse con botones.
- Nunca usar texto libre para decisiones.
- Minimo 2 opciones y maximo 4.

3) Inputs:
- Si se piden datos, usar inputs[].
- Cada input debe incluir nombre_campo, tipo, validacion.
- Cuando haya inputs, acciones debe guardar esos datos con formato guardar.campo = valor.

4) Memoria obligatoria:
Debe existir y usarse en el flujo:
{
  "tipo_necesidad": null,
  "nombre": null,
  "telefono": null,
  "horario": null,
  "estado": null
}

5) Webhooks:
- Si hay confirmacion o accion final, definir webhook con endpoint, metodo y payload.

6) Routing:
- Cada pantalla debe tener routing claro, sin ambiguedad y sin caminos muertos.

7) Tono:
- Empatico, claro, conversacional, no tecnico.

8) Prohibido:
- No describir: estructurar siempre.
- No omitir botones en decisiones.
- No dejar pasos implicitos.

Formato de salida obligatorio:
- Responde SOLO con JSON valido (sin markdown ni texto adicional).
- Usa exactamente este schema de nivel superior:
{
  "memoria_inicial": {
    "tipo_necesidad": null,
    "nombre": null,
    "telefono": null,
    "horario": null,
    "estado": null
  },
  "pantallas": [
    {
      "id": "PANTALLA_1",
      "mensaje": "",
      "botones": [],
      "inputs": [],
      "acciones": [],
      "routing": {}
    }
  ]
}`;

const FLOW_OUTPUT_SCHEMA_SAMPLE = {
  memoria_inicial: {
    tipo_necesidad: null,
    nombre: null,
    telefono: null,
    horario: null,
    estado: null,
  },
  pantallas: [
    {
      id: 'PANTALLA_1',
      mensaje: '',
      botones: [],
      inputs: [],
      acciones: [],
      routing: {},
    },
  ],
};

const FLOW_GENERATION_MAX_ATTEMPTS = 3;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
}

function collectActionStrings(actions) {
  return asArray(actions).map((action) => {
    if (typeof action === 'string') return action;
    if (action && typeof action === 'object') return JSON.stringify(action);
    return '';
  }).filter(Boolean);
}

function hasWebhookAction(actions) {
  return asArray(actions).some((action) => {
    if (!action || typeof action !== 'object') return false;
    if (!action.webhook || typeof action.webhook !== 'object') return false;
    const endpoint = normalizeText(action.webhook.endpoint || action.webhook.url);
    const metodo = normalizeText(action.webhook.metodo || action.webhook.method).toUpperCase();
    const payload = action.webhook.payload;
    return Boolean(endpoint) && (metodo === 'POST' || metodo === 'GET') && payload && typeof payload === 'object';
  });
}

function validateStructuredFlow(flowJson, requestedScreenCount) {
  const errors = [];
  if (!flowJson || typeof flowJson !== 'object') {
    return { valid: false, errors: ['La salida no es un objeto JSON valido.'] };
  }

  const memoria = flowJson.memoria_inicial;
  const requiredMemoryFields = ['tipo_necesidad', 'nombre', 'telefono', 'horario', 'estado'];
  if (!memoria || typeof memoria !== 'object') {
    errors.push('Falta memoria_inicial obligatoria.');
  } else {
    for (const field of requiredMemoryFields) {
      if (!(field in memoria)) {
        errors.push(`Falta memoria_inicial.${field}.`);
      }
    }
  }

  const pantallas = asArray(flowJson.pantallas);
  if (pantallas.length === 0) {
    errors.push('Debe existir pantallas[] con al menos una pantalla.');
    return { valid: false, errors };
  }

  if (!pantallas.some((p) => normalizeText(p?.id) === 'PANTALLA_1')) {
    errors.push('Debe existir una pantalla con id PANTALLA_1.');
  }

  if (requestedScreenCount && pantallas.length !== requestedScreenCount) {
    errors.push(`Se solicitaron ${requestedScreenCount} pantallas y se generaron ${pantallas.length}.`);
  }

  const screenIds = new Set(pantallas.map((p) => normalizeText(p?.id)).filter(Boolean));
  let foundConfirmation = false;
  let foundWebhook = false;

  for (const pantalla of pantallas) {
    const id = normalizeText(pantalla?.id);
    if (!id) {
      errors.push('Toda pantalla debe tener id.');
      continue;
    }

    if (!normalizeText(pantalla?.mensaje)) {
      errors.push(`${id}: falta mensaje.`);
    }

    if (!pantalla || typeof pantalla.routing !== 'object' || Array.isArray(pantalla.routing) || pantalla.routing == null) {
      errors.push(`${id}: cada pantalla debe tener routing objeto.`);
    }

    const botones = asArray(pantalla?.botones);
    if (botones.length > 0 && (botones.length < 2 || botones.length > 4)) {
      errors.push(`${id}: las decisiones deben tener entre 2 y 4 botones.`);
    }

    for (const boton of botones) {
      const destino = normalizeText(boton?.destino);
      if (!destino) {
        errors.push(`${id}: todos los botones deben tener destino.`);
        continue;
      }
      if (destino !== 'FIN' && !screenIds.has(destino)) {
        errors.push(`${id}: destino de boton invalido (${destino}).`);
      }

      const buttonText = normalizeText(boton?.texto).toLowerCase();
      if (buttonText.includes('confirm')) foundConfirmation = true;
    }

    const routingValues = Object.values(pantalla?.routing || {});
    for (const destino of routingValues) {
      const nextId = normalizeText(destino);
      if (!nextId) {
        errors.push(`${id}: routing contiene destino vacio.`);
        continue;
      }
      if (nextId !== 'FIN' && !screenIds.has(nextId)) {
        errors.push(`${id}: routing apunta a pantalla inexistente (${nextId}).`);
      }
    }

    const inputs = asArray(pantalla?.inputs);
    for (const input of inputs) {
      const fieldName = normalizeText(input?.nombre_campo);
      const inputType = normalizeText(input?.tipo);
      const validation = normalizeText(input?.validacion);

      if (!fieldName || !inputType || !validation) {
        errors.push(`${id}: cada input debe tener nombre_campo, tipo y validacion.`);
      }

      const actionStrings = collectActionStrings(pantalla?.acciones).map((s) => s.toLowerCase());
      if (fieldName && !actionStrings.some((s) => s.includes(`guardar.${fieldName.toLowerCase()}`))) {
        errors.push(`${id}: falta guardar.${fieldName} en acciones para inputs.`);
      }
    }

    if (normalizeText(pantalla?.mensaje).toLowerCase().includes('confirm')) {
      foundConfirmation = true;
    }
    if (hasWebhookAction(pantalla?.acciones)) {
      foundWebhook = true;
    }
  }

  if (foundConfirmation && !foundWebhook) {
    errors.push('Si hay confirmacion, debe existir webhook con endpoint, metodo y payload.');
  }

  return { valid: errors.length === 0, errors };
}

function extractRequestedScreenCount(prompt) {
  const text = String(prompt || '').toLowerCase();
  const match = text.match(/\b(\d{1,2})\s*(pantallas|pantalla|screens|screen)\b/);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 1 || count > 25) return null;
  return count;
}

function buildGenerateFlowUserPrompt(prompt, requestedScreenCount) {
  const directives = [
    'Brief del usuario (usar literalmente para generar el flujo):',
    '',
    String(prompt || '').trim(),
    '',
    'Combina este brief con las reglas del system prompt y ejecutalas sin excepcion.',
    'La salida debe ser JSON estricto y parseable.',
    'Schema obligatorio de salida:',
    JSON.stringify(FLOW_OUTPUT_SCHEMA_SAMPLE, null, 2),
    '',
  ];

  if (requestedScreenCount) {
    directives.push(
      `Regla adicional: generar exactamente ${requestedScreenCount} pantallas (ni mas ni menos).`,
      '',
    );
  }

  directives.push('Responde solo JSON.');
  return directives.join('\n');
}

function getScreenCountFromFlowJson(flowJson) {
  return Array.isArray(flowJson?.pantallas) ? flowJson.pantallas.length : 0;
}

function toScreenId(value, fallback) {
  const raw = normalizeText(value) || fallback;
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || fallback;
}

function normalizeStructuredFlowToMetaJson(flowJson) {
  if (!flowJson || typeof flowJson !== 'object') return flowJson;
  if (Array.isArray(flowJson.screens) && flowJson.screens.length > 0) return flowJson;

  const pantallas = asArray(flowJson.pantallas);
  if (pantallas.length === 0) return flowJson;

  const idMap = {};
  pantallas.forEach((pantalla, idx) => {
    const fallbackId = `PANTALLA_${idx + 1}`;
    const idMapKey = normalizeText(pantalla?.id) || fallbackId;
    idMap[idMapKey] = toScreenId(pantalla?.id, fallbackId);
  });

  const mapDestino = (destino) => {
    const d = normalizeText(destino);
    if (!d || d === 'FIN') return null;
    return idMap[d] || toScreenId(d, d);
  };

  const screens = pantallas.map((pantalla, idx) => {
    const fallbackId = `PANTALLA_${idx + 1}`;
    const id = idMap[normalizeText(pantalla?.id) || fallbackId] || fallbackId;

    const children = [
      { type: 'TextHeading', text: `Paso ${idx + 1}` },
      { type: 'TextBody', text: normalizeText(pantalla?.mensaje) || 'Continuemos con el flujo.' },
    ];

    const inputs = asArray(pantalla?.inputs);
    for (const input of inputs) {
      const fieldName = normalizeText(input?.nombre_campo) || `campo_${idx + 1}`;
      children.push({
        type: 'TextInput',
        name: fieldName,
        label: fieldName,
      });
    }

    const botones = asArray(pantalla?.botones);
    if (botones.length >= 2) {
      children.push({
        type: 'RadioButtonsGroup',
        name: `decision_${idx + 1}`,
        label: 'Selecciona una opcion',
        'data-source': botones.map((b, optionIdx) => ({
          id: `opcion_${optionIdx + 1}`,
          title: normalizeText(b?.texto) || `Opcion ${optionIdx + 1}`,
        })),
      });
    }

    const routingValues = Object.values(pantalla?.routing || {})
      .map(mapDestino)
      .filter(Boolean);
    const buttonTargets = botones
      .map((b) => mapDestino(b?.destino))
      .filter(Boolean);
    const nextCandidates = [...new Set([...buttonTargets, ...routingValues])];
    const nextScreen = nextCandidates[0] || null;

    children.push(nextScreen
      ? {
          type: 'Footer',
          label: 'Continuar',
          'on-click-action': { name: 'navigate', next: { type: 'screen', name: nextScreen } },
        }
      : {
          type: 'Footer',
          label: 'Finalizar',
          'on-click-action': { name: 'complete' },
        });

    return {
      id,
      title: id,
      terminal: !nextScreen,
      layout: {
        type: 'SingleColumnLayout',
        children,
      },
    };
  });

  const routing_model = {};
  pantallas.forEach((pantalla, idx) => {
    const fallbackId = `PANTALLA_${idx + 1}`;
    const sourceId = idMap[normalizeText(pantalla?.id) || fallbackId] || fallbackId;

    const botones = asArray(pantalla?.botones);
    const buttonTargets = botones
      .map((b) => mapDestino(b?.destino))
      .filter(Boolean);
    const routingTargets = Object.values(pantalla?.routing || {})
      .map(mapDestino)
      .filter(Boolean);

    routing_model[sourceId] = [...new Set([...buttonTargets, ...routingTargets])];
  });

  return {
    version: '7.1',
    data_api_version: '3.0',
    routing_model,
    screens,
    _structured_source: flowJson,
  };
}

/**
 * Generate a Meta WhatsApp Flow JSON from a natural-language prompt.
 * @param {string} tenantId
 * @param {string} prompt
 * @returns {{ json: object, provider: string, model: string }|null}
 */
async function generateFlow(tenantId, prompt) {
  const requestedScreenCount = extractRequestedScreenCount(prompt);
  const userPrompt = buildGenerateFlowUserPrompt(prompt, requestedScreenCount);
  let currentPrompt = userPrompt;
  let lastResult = null;

  for (let attempt = 1; attempt <= FLOW_GENERATION_MAX_ATTEMPTS; attempt += 1) {
    const result = await callLlmForJson(tenantId, GENERATE_FLOW_SYSTEM, currentPrompt);
    if (!result?.json) return null;

    const validation = validateStructuredFlow(result.json, requestedScreenCount);
    lastResult = {
      ...result,
      json: normalizeStructuredFlowToMetaJson(result.json),
    };
    if (validation.valid) {
      return lastResult;
    }

    const produced = getScreenCountFromFlowJson(result.json);
    logger.warn({ tenantId, attempt, produced, errors: validation.errors }, 'generateFlow: validation failed, requesting correction');

    if (attempt >= FLOW_GENERATION_MAX_ATTEMPTS) {
      break;
    }

    currentPrompt = [
      'Corrige el flujo para cumplir TODAS las reglas del system prompt.',
      'Checklist obligatorio (si falla cualquiera, corrige):',
      '- Debe existir PANTALLA_1',
      '- Cada pantalla debe tener routing',
      '- En decisiones debe haber botones',
      '- En pantallas con inputs debe existir guardar.campo',
      '- Si hay confirmacion debe haber webhook',
      requestedScreenCount
        ? `- Debe haber exactamente ${requestedScreenCount} pantallas`
        : null,
      '',
      'Errores detectados:',
      ...validation.errors.map((e) => `- ${e}`),
      '',
      'JSON actual a corregir:',
      JSON.stringify(result.json),
      '',
      'Devuelve solo JSON valido y estricto con el schema exigido.',
    ].filter(Boolean).join('\n');
  }

  return lastResult;
}

// ─── Intent classifier ────────────────────────────────────────────────────────

const CLASSIFY_INTENT_SYSTEM = `You are an intent classifier for a conversational chatbot.
Given the user's free-text input and a closed list of possible intents, return a JSON object
with a single key "intent" containing the best matching intent from the list.
Rules:
- You MUST choose one of the provided intents — never invent new ones.
- Respond ONLY with JSON, no prose. Example: {"intent": "crisis"}`;

/**
 * Classify free-text user input into one of the provided intents using the LLM.
 *
 * @param {string}   tenantId
 * @param {string}   userInput       - raw text from the user
 * @param {string[]} possibleIntents - closed list of valid intent names
 * @returns {Promise<string|null>} The matched intent, or null if classification failed.
 */
async function classifyIntent(tenantId, userInput, possibleIntents) {
  if (!possibleIntents?.length) return null;

  const userPrompt = [
    `User input: "${userInput}"`,
    `Possible intents: ${JSON.stringify(possibleIntents)}`,
    '',
    'Return only {"intent": "<best_match>"}.',
  ].join('\n');

  const result = await callLlmForJson(tenantId, CLASSIFY_INTENT_SYSTEM, userPrompt);
  if (!result) return null;

  const intent = result.json?.intent;
  if (!possibleIntents.includes(intent)) {
    logger.warn({ tenantId, intent, possibleIntents }, 'classifyIntent: LLM returned unknown intent — ignoring');
    return null;
  }

  logger.info({ tenantId, intent, provider: result.provider }, 'classifyIntent: resolved');
  return intent;
}

module.exports = { callLlm, callLlmForJson, getLlmConfig, getLlmStatus, generateFlow, classifyIntent };
