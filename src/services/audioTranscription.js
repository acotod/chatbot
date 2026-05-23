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

function resolveOpenAiKey(configValue) {
  if (configValue && typeof configValue === 'object' && configValue.openaiApiKey) {
    const key = String(configValue.openaiApiKey).trim();
    if (key) return key;
  }
  return '';
}

async function resolveOpenAiKeyForTenant(_tenantId, configValue) {
  const directKey = resolveOpenAiKey(configValue);
  if (directKey) {
    return { key: directKey, source: 'audio_transcription_provider', reason: null };
  }
  return {
    key: '',
    source: null,
    reason: 'Per-tenant transcription key missing. Configure wa_audio_transcription_provider.openaiApiKey for this tenant.',
  };
}

async function resolveTranscriptionCredentials(tenantId, providerCfgValue, requestedProvider) {
  if (requestedProvider !== 'openai') {
    return {
      provider: requestedProvider,
      key: '',
      source: null,
      reason: 'Only provider=openai is supported for audio transcription. Configure wa_audio_transcription.provider=openai and set wa_audio_transcription_provider.openaiApiKey per tenant.',
      llmModel: null,
    };
  }

  const openai = await resolveOpenAiKeyForTenant(tenantId, providerCfgValue);
  return {
    provider: 'openai',
    key: openai.key,
    source: openai.source,
    reason: openai.reason,
    llmModel: null,
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

  if (config.provider !== 'openai') {
    return {
      ok: false,
      text: null,
      error: 'Only provider=openai is supported for audio transcription. Configure it per tenant in wa_audio_transcription_provider.openaiApiKey.',
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
  } = await resolveTranscriptionCredentials(tenantId, providerCfgRow?.valor, config.provider);
  if (!apiKey) {
    return {
      ok: false,
      text: null,
      error: keyMissingReason || 'Per-tenant transcription key missing. Configure wa_audio_transcription_provider.openaiApiKey for this tenant.',
      provider: resolvedProvider,
      meta: {},
    };
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
