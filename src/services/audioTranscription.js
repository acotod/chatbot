'use strict';

const logger = require('../utils/logger');
const db = require('./database');

const DEFAULT_TRANSCRIPTION_CONFIG = Object.freeze({
  enabled: true,
  provider: 'openai',
  useForBotInput: true,
  model: 'gpt-4o-mini-transcribe',
  languageHint: null,
  timeoutMs: 30000,
});

function normalizeTranscriptionConfig(raw) {
  const cfg = (raw && typeof raw === 'object') ? raw : {};
  const timeout = Number(cfg.timeoutMs ?? DEFAULT_TRANSCRIPTION_CONFIG.timeoutMs);
  return {
    enabled: (cfg.enabled === undefined || cfg.enabled === null)
      ? DEFAULT_TRANSCRIPTION_CONFIG.enabled
      : Boolean(cfg.enabled),
    provider: String(cfg.provider ?? DEFAULT_TRANSCRIPTION_CONFIG.provider).trim().toLowerCase(),
    useForBotInput: (cfg.useForBotInput === undefined || cfg.useForBotInput === null)
      ? DEFAULT_TRANSCRIPTION_CONFIG.useForBotInput
      : Boolean(cfg.useForBotInput),
    model: String(cfg.model ?? DEFAULT_TRANSCRIPTION_CONFIG.model).trim(),
    languageHint: cfg.languageHint ? String(cfg.languageHint).trim() : null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 120000) : DEFAULT_TRANSCRIPTION_CONFIG.timeoutMs,
  };
}

async function getTenantTranscriptionConfig(tenantId) {
  const row = await db.getConfig(tenantId, 'wa_audio_transcription');
  const normalized = normalizeTranscriptionConfig(row?.valor);
  return normalized;
}

function resolveAnthropicKey(configValue) {
  if (configValue && typeof configValue === 'object' && configValue.anthropicApiKey) {
    const key = String(configValue.anthropicApiKey).trim();
    if (key) return key;
  }
  return String(process.env.ANTHROPIC_API_KEY || '').trim();
}

function resolveOpenAiKey(configValue) {
  if (configValue && typeof configValue === 'object' && configValue.openaiApiKey) {
    const key = String(configValue.openaiApiKey).trim();
    if (key) return key;
  }
  return String(process.env.OPENAI_API_KEY || '').trim();
}

async function resolveOpenAiKeyForTenant(tenantId, configValue) {
  const directKey = resolveOpenAiKey(configValue);
  if (directKey) {
    return { key: directKey, source: 'audio_transcription_provider', reason: null };
  }

  try {
    const llmCfg = await db.getConfig(tenantId, 'llm_config');
    const provider = String(llmCfg?.valor?.provider || '').trim().toLowerCase();
    const llmApiKey = String(llmCfg?.valor?.api_key || '').trim();

    // Reuse tenant LLM key only when it's clearly OpenAI-based.
    if (llmApiKey && (!provider || provider === 'openai')) {
      return { key: llmApiKey, source: 'llm_config', reason: null };
    }

    if (llmApiKey && provider && provider !== 'openai') {
      return {
        key: '',
        source: null,
        reason: `LLM provider '${provider}' is configured for tenant, but audio transcription currently requires an OpenAI key`,
      };
    }
  } catch (err) {
    logger.warn('Could not resolve llm_config fallback for audio transcription', {
      tenantId,
      message: err.message,
    });
  }

  return { key: '', source: null, reason: null };
}

async function resolveAnthropicKeyForTenant(tenantId, configValue) {
  const directKey = resolveAnthropicKey(configValue);
  if (directKey) {
    return { key: directKey, source: 'audio_transcription_provider', reason: null, llmModel: null };
  }

  try {
    const llmCfg = await db.getConfig(tenantId, 'llm_config');
    const provider = String(llmCfg?.valor?.provider || '').trim().toLowerCase();
    const llmApiKey = String(llmCfg?.valor?.api_key || '').trim();
    const llmModel = String(llmCfg?.valor?.model || '').trim() || null;

    // Reuse tenant LLM key when provider is Anthropic-based.
    if (llmApiKey && provider === 'anthropic') {
      return { key: llmApiKey, source: 'llm_config', reason: null, llmModel };
    }

    if (llmApiKey && provider && provider !== 'anthropic') {
      return {
        key: '',
        source: null,
        reason: `LLM provider '${provider}' is configured for tenant, but Anthropic transcription requires an Anthropic key`,
        llmModel,
      };
    }
  } catch (err) {
    logger.warn('Could not resolve llm_config fallback for anthropic transcription', {
      tenantId,
      message: err.message,
    });
  }

  return { key: '', source: null, reason: null, llmModel: null };
}

async function resolveTranscriptionCredentials(tenantId, providerCfgValue, requestedProvider) {
  if (requestedProvider === 'anthropic') {
    const anthropic = await resolveAnthropicKeyForTenant(tenantId, providerCfgValue);
    return {
      provider: 'anthropic',
      key: anthropic.key,
      source: anthropic.source,
      reason: anthropic.reason,
      llmModel: anthropic.llmModel,
    };
  }

  const openai = await resolveOpenAiKeyForTenant(tenantId, providerCfgValue);
  if (openai.key) {
    return {
      provider: 'openai',
      key: openai.key,
      source: openai.source,
      reason: openai.reason,
      llmModel: null,
    };
  }

  // Automatic fallback: if tenant only has Anthropic configured in llm_config,
  // use it for transcription to avoid forcing an extra OpenAI credential.
  const anthropic = await resolveAnthropicKeyForTenant(tenantId, providerCfgValue);
  if (anthropic.key) {
    return {
      provider: 'anthropic',
      key: anthropic.key,
      source: anthropic.source,
      reason: null,
      llmModel: anthropic.llmModel,
    };
  }

  return {
    provider: 'openai',
    key: '',
    source: null,
    reason: openai.reason || anthropic.reason || null,
    llmModel: anthropic.llmModel,
  };
}

function shouldRetryException(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const message = String(err.message || '').toLowerCase();
  return message.includes('network') || message.includes('fetch failed') || message.includes('socket');
}

async function transcribeWithOpenAi({ buffer, mimeType, config, apiKey, apiKeySource, tenantId }) {
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = `${baseUrl}/audio/transcriptions`;
  const maxAttempts = 2;
  const retryStatuses = new Set([429, 500, 502, 503, 504]);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const filename = mimeType && mimeType.includes('ogg') ? 'audio.ogg' : 'audio.wav';
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);
      form.append('model', config.model || DEFAULT_TRANSCRIPTION_CONFIG.model);
      if (config.languageHint) form.append('language', config.languageHint);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: controller.signal,
      });

      const bodyText = await response.text();
      let bodyJson = null;
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = null;
      }

      if (!response.ok) {
        const errorText = bodyJson?.error?.message || bodyText || 'OpenAI transcription failed';
        if (attempt < maxAttempts && retryStatuses.has(response.status)) {
          logger.warn('Retrying audio transcription after provider error', {
            tenantId,
            status: response.status,
            attempt,
            provider: 'openai',
          });
          continue;
        }
        return {
          ok: false,
          text: null,
          error: String(errorText).slice(0, 500),
          provider: 'openai',
          meta: {
            model: config.model,
            status: response.status,
            keySource: apiKeySource,
            attempts: attempt,
          },
        };
      }

      const text = String(bodyJson?.text ?? '').trim();
      return {
        ok: Boolean(text),
        text: text || null,
        error: text ? null : 'Empty transcript',
        provider: 'openai',
        meta: {
          model: config.model,
          language: bodyJson?.language || config.languageHint || null,
          keySource: apiKeySource,
          attempts: attempt,
        },
      };
    } catch (err) {
      const timeoutError = err?.name === 'AbortError'
        ? `Transcription request timed out after ${config.timeoutMs}ms`
        : String(err?.message || 'Audio transcription failed');

      if (attempt < maxAttempts && shouldRetryException(err)) {
        logger.warn('Retrying audio transcription after transient failure', {
          tenantId,
          attempt,
          message: timeoutError,
          provider: 'openai',
        });
        continue;
      }

      logger.warn('Audio transcription failed', { tenantId, message: timeoutError, provider: 'openai' });
      return {
        ok: false,
        text: null,
        error: timeoutError,
        provider: 'openai',
        meta: {
          model: config.model,
          keySource: apiKeySource,
          attempts: attempt,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    text: null,
    error: 'Audio transcription exhausted retries',
    provider: 'openai',
    meta: {
      model: config.model,
      keySource: apiKeySource,
      attempts: maxAttempts,
    },
  };
}

async function transcribeWithAnthropic({
  buffer,
  mimeType,
  config,
  apiKey,
  apiKeySource,
  llmModel,
  tenantId,
}) {
  const baseUrl = String(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const url = `${baseUrl}/v1/messages`;
  const maxAttempts = 2;
  const retryStatuses = new Set([429, 500, 502, 503, 504, 529]);
  const selectedModel = (config.model && config.model.toLowerCase().includes('claude'))
    ? config.model
    : (llmModel || 'claude-3-5-sonnet-latest');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const audioB64 = buffer.toString('base64');
      const payload = {
        model: selectedModel,
        max_tokens: 2048,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Transcribe this audio exactly. Return only the transcription text with no explanations.',
              },
              {
                type: 'input_audio',
                source: {
                  type: 'base64',
                  media_type: mimeType || 'audio/ogg',
                  data: audioB64,
                },
              },
            ],
          },
        ],
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': String(process.env.ANTHROPIC_VERSION || '2023-06-01'),
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const bodyText = await response.text();
      let bodyJson = null;
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = null;
      }

      if (!response.ok) {
        const errorText = bodyJson?.error?.message || bodyText || 'Anthropic transcription failed';
        if (attempt < maxAttempts && retryStatuses.has(response.status)) {
          logger.warn('Retrying audio transcription after provider error', {
            tenantId,
            status: response.status,
            attempt,
            provider: 'anthropic',
          });
          continue;
        }
        return {
          ok: false,
          text: null,
          error: String(errorText).slice(0, 500),
          provider: 'anthropic',
          meta: {
            model: selectedModel,
            status: response.status,
            keySource: apiKeySource,
            attempts: attempt,
          },
        };
      }

      const contentBlocks = Array.isArray(bodyJson?.content) ? bodyJson.content : [];
      const textBlock = contentBlocks.find((item) => item && item.type === 'text');
      const text = String(textBlock?.text || '').trim();

      return {
        ok: Boolean(text),
        text: text || null,
        error: text ? null : 'Empty transcript',
        provider: 'anthropic',
        meta: {
          model: selectedModel,
          keySource: apiKeySource,
          attempts: attempt,
        },
      };
    } catch (err) {
      const timeoutError = err?.name === 'AbortError'
        ? `Transcription request timed out after ${config.timeoutMs}ms`
        : String(err?.message || 'Anthropic transcription failed');

      if (attempt < maxAttempts && shouldRetryException(err)) {
        logger.warn('Retrying audio transcription after transient failure', {
          tenantId,
          attempt,
          message: timeoutError,
          provider: 'anthropic',
        });
        continue;
      }

      logger.warn('Audio transcription failed', { tenantId, message: timeoutError, provider: 'anthropic' });
      return {
        ok: false,
        text: null,
        error: timeoutError,
        provider: 'anthropic',
        meta: {
          model: selectedModel,
          keySource: apiKeySource,
          attempts: attempt,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    text: null,
    error: 'Audio transcription exhausted retries',
    provider: 'anthropic',
    meta: {
      model: selectedModel,
      keySource: apiKeySource,
      attempts: maxAttempts,
    },
  };
}

async function transcribeAudioBuffer({ buffer, mimeType, tenantId, config }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return {
      ok: false,
      text: null,
      error: 'Audio buffer is empty',
      provider: config?.provider || 'unknown',
      meta: {},
    };
  }

  if (!config?.enabled) {
    return {
      ok: false,
      text: null,
      error: 'Audio transcription is disabled',
      provider: config?.provider || 'unknown',
      meta: {},
    };
  }

  if (config.provider !== 'openai' && config.provider !== 'anthropic') {
    return {
      ok: false,
      text: null,
      error: `Unsupported transcription provider: ${config.provider}`,
      provider: config.provider,
      meta: {},
    };
  }

  const providerCfgRow = await db.getConfig(tenantId, 'wa_audio_transcription_provider');
  const {
    provider: resolvedProvider,
    key: apiKey,
    source: apiKeySource,
    reason: keyMissingReason,
    llmModel,
  } = await resolveTranscriptionCredentials(tenantId, providerCfgRow?.valor, config.provider);
  if (!apiKey) {
    return {
      ok: false,
      text: null,
      error: keyMissingReason || 'OPENAI_API_KEY is not configured',
      provider: resolvedProvider,
      meta: {},
    };
  }

  if (resolvedProvider === 'anthropic') {
    return transcribeWithAnthropic({
      buffer,
      mimeType,
      config,
      apiKey,
      apiKeySource,
      llmModel,
      tenantId,
    });
  }

  return transcribeWithOpenAi({
    buffer,
    mimeType,
    config,
    apiKey,
    apiKeySource,
    tenantId,
  });
}

module.exports = {
  DEFAULT_TRANSCRIPTION_CONFIG,
  normalizeTranscriptionConfig,
  getTenantTranscriptionConfig,
  transcribeAudioBuffer,
};
