'use strict';

const { executeGenericStep, evaluateCondition } = require('../src/services/genericFlowEngine');

describe('genericFlowEngine', () => {
  test('evaluateCondition supports basic boolean logic', () => {
    const vars = { risk_level: 'high', requires_human: false, score: 8 };

    expect(evaluateCondition("risk_level == 'high' || requires_human == true", vars)).toBe(true);
    expect(evaluateCondition('score >= 7 && requires_human == false', vars)).toBe(true);
    expect(evaluateCondition("risk_level == 'low'", vars)).toBe(false);
  });

  test('executeGenericStep captures input and routes to next screen', async () => {
    const flowJson = {
      flow_name: 'demo',
      screens: [
        {
          id: 'screen_1',
          type: 'input',
          title: 'Inicio',
          content: 'Hola',
          input: { type: 'text', variable_name: 'mood_text' },
          actions: [
            { condition: "mood_text == ''", next_screen: 'screen_error' },
            { condition: "mood_text != ''", next_screen: 'screen_ok' },
          ],
        },
        {
          id: 'screen_error',
          type: 'message',
          title: 'Error',
          content: 'Falta dato',
          actions: [],
        },
        {
          id: 'screen_ok',
          type: 'terminal',
          title: 'OK',
          content: 'Continuar',
          actions: [],
        },
      ],
    };

    const result = await executeGenericStep({
      flowJson,
      currentScreenId: null,
      input: 'ansioso',
      variables: {},
      businessContext: { tenant: 'demo' },
      fetchImpl: global.fetch,
    });

    expect(result.nextScreenId).toBe('screen_ok');
    expect(result.terminal).toBe(true);
    expect(result.variables.mood_text).toBe('ansioso');
    expect(result.variables.business.tenant).toBe('demo');
  });

  test('executeGenericStep applies webhook response mapping', async () => {
    const flowJson = {
      flow_name: 'demo_webhook',
      screens: [
        {
          id: 'screen_1',
          type: 'input',
          title: 'Inicio',
          content: 'Hola',
          input: { type: 'text', variable_name: 'mood_text' },
          actions: [
            {
              condition: 'always',
              next_screen: 'screen_2',
              webhook: {
                url: 'https://example.test/analyze',
                method: 'POST',
                payload: { mood: '{{mood_text}}' },
                response_mapping: {
                  'risk.level': 'risk_level',
                },
              },
            },
          ],
        },
        {
          id: 'screen_2',
          type: 'message',
          title: 'Siguiente',
          content: 'ok',
          actions: [],
        },
      ],
    };

    const fakeFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ risk: { level: 'medium' } }),
      text: async () => '',
    }));

    const result = await executeGenericStep({
      flowJson,
      input: 'preocupado',
      variables: {},
      fetchImpl: fakeFetch,
    });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(result.variables.risk_level).toBe('medium');
    expect(result.nextScreenId).toBe('screen_2');
  });
});
