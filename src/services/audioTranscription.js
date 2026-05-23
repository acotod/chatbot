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
  return String(process.env.OPENAI_API_KEY || '').trim();
}

async function resolveOpenAiKeyForTenant(tenantId, configValue) {
  const directKey = resolveOpenAiKey(configValue);
  if (directKey) {
    return { key: directKey, source: 'audio_transcription_provider' };
  }

  try {
    const llmCfg = await db.getConfig(tenantId, 'llm_config');
    const provider = String(llmCfg?.valor?.provider || '').trim().toLowerCase();
    const llmApiKey = String(llmCfg?.valor?.api_key || '').trim();

    // Reuse tenant LLM key only when it's clearly OpenAI-based.
    if (llmApiKey && (!provider || provider === 'openai')) {
      return { key: llmApiKey, source: 'llm_config' };
    }
  } catch (err) {
    logger.warn('Could not resolve llm_config fallback for audio transcription', {
      tenantId,
      message: err.message,
    });
  }

  return { key: '', source: null };
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
      error: `Unsupported transcription provider: ${config.provider}`,
      provider: config.provider,
      meta: {},
    };
  }

  const providerCfgRow = await db.getConfig(tenantId, 'wa_audio_transcription_provider');
  const { key: apiKey, source: apiKeySource } = await resolveOpenAiKeyForTenant(tenantId, providerCfgRow?.valor);
  if (!apiKey) {
    return {
      ok: false,
      text: null,
      error: 'OPENAI_API_KEY is not configured',
      provider: 'openai',
      meta: {},
    };
  }

  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = `${baseUrl}/audio/transcriptions`;
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
      return {
        ok: false,
        text: null,
        error: String(errorText).slice(0, 500),
        provider: 'openai',
        meta: {
          model: config.model,
          status: response.status,
          keySource: apiKeySource,
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
      },
    };
  } catch (err) {
    logger.warn('Audio transcription failed', { tenantId, message: err.message });
    return {
      ok: false,
      text: null,
      error: err.message,
      provider: 'openai',
      meta: {
        model: config.model,
        keySource: apiKeySource,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TRANSCRIPTION_CONFIG,
  normalizeTranscriptionConfig,
  getTenantTranscriptionConfig,
  transcribeAudioBuffer,
};
