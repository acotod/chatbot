'use strict';

const { buildWhatsAppSimulation } = require('../src/services/whatsappFlowSimulation');

describe('whatsappFlowSimulation', () => {
  test('builds generic flow simulation with webhook expectations', () => {
    const flow = { id: 10, nombre: 'Demo Generic', version: 2 };
    const flowJson = {
      screens: [
        {
          id: 'screen_1',
          type: 'input',
          title: 'Inicio',
          content: 'Hola, cuentame como te sientes',
          input: { type: 'text', variable_name: 'mood_text' },
          actions: [
            {
              condition: "mood_text == 'mal'",
              next_screen: 'screen_2',
              webhook: {
                method: 'POST',
                url: 'https://example.test/risk',
                payload: { text: '{{mood_text}}' },
                response_mapping: {
                  'risk.level': 'risk_level',
                },
              },
            },
          ],
        },
        {
          id: 'screen_2',
          type: 'terminal',
          title: 'Cierre',
          content: 'Gracias por responder',
          actions: [],
        },
      ],
    };

    const result = buildWhatsAppSimulation({ flow, flowJson });

    expect(result.flow.format).toBe('generic');
    expect(result.summary.screens).toBe(2);
    expect(result.summary.webhookCalls).toBe(1);
    expect(result.screens[0].userView.menu[0].label).toBe('mal');
    expect(result.screens[0].actions[0].webhook.shouldRespond.status).toBe('2xx');
    expect(result.screens[0].actions[0].webhook.shouldRespond.bodyExample).toEqual({
      risk: { level: '<valor>' },
    });
  });

  test('builds meta flow simulation with data_exchange webhook hint', () => {
    const flow = { id: 20, nombre: 'Demo Meta', version: 1 };
    const flowJson = {
      screens: [
        {
          id: 'INICIO',
          title: 'Inicio',
          layout: {
            type: 'SingleColumnLayout',
            children: [
              { type: 'TextBody', text: 'Selecciona una opcion' },
              {
                type: 'RadioButtonsGroup',
                name: 'opcion_inicio',
                'data-source': [
                  { id: 'hablar_alguien', title: 'Hablar con alguien' },
                  { id: 'informacion', title: 'Solo informacion' },
                ],
              },
              {
                type: 'Footer',
                label: 'Continuar',
                'on-click-action': { name: 'data_exchange' },
              },
            ],
          },
          data: {
            response_mapping: {
              'result.next_screen': 'next_screen',
            },
          },
        },
      ],
    };

    const result = buildWhatsAppSimulation({ flow, flowJson });

    expect(result.flow.format).toBe('meta');
    expect(result.summary.webhookCalls).toBe(1);
    expect(result.screens[0].userView.menu).toHaveLength(2);
    expect(result.screens[0].actions[0].webhook.urlHint).toBe('/whatsapp/flows');
    expect(result.screens[0].actions[0].webhook.shouldRespond.bodyExample).toEqual({
      result: { next_screen: '<valor>' },
    });
  });
});
