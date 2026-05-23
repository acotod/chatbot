const {
  DEFAULT_TRANSCRIPTION_CONFIG,
  normalizeTranscriptionConfig,
} = require('../src/services/audioTranscription');

describe('audioTranscription config normalization', () => {
  test('uses defaults when config is missing', () => {
    const cfg = normalizeTranscriptionConfig(undefined);
    expect(cfg.enabled).toBe(DEFAULT_TRANSCRIPTION_CONFIG.enabled);
    expect(cfg.useForBotInput).toBe(DEFAULT_TRANSCRIPTION_CONFIG.useForBotInput);
    expect(cfg.provider).toBe(DEFAULT_TRANSCRIPTION_CONFIG.provider);
    expect(cfg.model).toBe(DEFAULT_TRANSCRIPTION_CONFIG.model);
  });

  test('falls back missing booleans to defaults while preserving explicit flags', () => {
    const cfgWithMissingFlags = normalizeTranscriptionConfig({ provider: 'openai' });
    expect(cfgWithMissingFlags.enabled).toBe(DEFAULT_TRANSCRIPTION_CONFIG.enabled);
    expect(cfgWithMissingFlags.useForBotInput).toBe(DEFAULT_TRANSCRIPTION_CONFIG.useForBotInput);

    const cfgExplicitOff = normalizeTranscriptionConfig({ enabled: false, useForBotInput: false });
    expect(cfgExplicitOff.enabled).toBe(false);
    expect(cfgExplicitOff.useForBotInput).toBe(false);
  });
});
