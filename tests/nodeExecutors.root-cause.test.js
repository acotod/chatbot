'use strict';

const { executeNode } = require('../src/engine/nodeExecutors');

describe('nodeExecutors root-cause guards', () => {
  test('menu accepts hour text by matching option title (no hardcoded IDs)', async () => {
    const node = {
      id: 'menu_horario',
      type: 'menu',
      next: null,
      config: {
        text: 'Agenda disponible',
        options: [
          { id: 'opt_a', title: 'Lunes 8:00 a.m', next: 'node_confirm' },
          { id: 'opt_b', title: 'Lunes 2:00 p.m', next: 'node_confirm' },
        ],
      },
      branches: {
        opt_a: 'node_confirm',
        opt_b: 'node_confirm',
      },
    };

    const res14 = await executeNode(node, {
      input: '14',
      variables: {},
      tenantId: 'tenant-1',
    });

    const res8am = await executeNode(node, {
      input: '8:00 a.m.',
      variables: {},
      tenantId: 'tenant-1',
    });

    expect(res14.nextNodeId).toBe('node_confirm');
    expect(res14.output).toBeNull();
    expect(res8am.nextNodeId).toBe('node_confirm');
    expect(res8am.output).toBeNull();
  });

  test('input node uses config.text prompt and waits when input is null', async () => {
    const node = {
      id: 'node_input',
      type: 'input',
      next: 'node_next',
      config: { text: 'Dame tu numero de cedula', variable: 'cedula' },
    };

    const first = await executeNode(node, {
      input: null,
      variables: {},
      tenantId: 'tenant-1',
    });

    const stillWaiting = await executeNode(node, {
      input: null,
      variables: { __awaiting_input: 'node_input' },
      tenantId: 'tenant-1',
    });

    const captured = await executeNode(node, {
      input: '12345678',
      variables: { __awaiting_input: 'node_input' },
      tenantId: 'tenant-1',
    });

    expect(first.output).toEqual({ type: 'text', text: 'Dame tu numero de cedula' });
    expect(first.nextNodeId).toBe('node_input');

    expect(stillWaiting.output).toEqual({ type: 'text', text: 'Dame tu numero de cedula' });
    expect(stillWaiting.nextNodeId).toBe('node_input');

    expect(captured.output).toBeNull();
    expect(captured.nextNodeId).toBe('node_next');
    expect(captured.updatedVars).toEqual(
      expect.objectContaining({
        cedula: '12345678',
        __awaiting_input: null,
      }),
    );
  });

  test('input node validates format and retries when invalid', async () => {
    const node = {
      id: 'node_input',
      type: 'input',
      next: 'node_next',
      config: {
        text: 'Dame tu numero de cedula',
        variable: 'cedula',
        validationType: 'regex',
        validationPattern: '^\\d{6,13}$',
        validationMessage: 'Cedula invalida. Intenta de nuevo.',
      },
    };

    const invalid = await executeNode(node, {
      input: 'abc',
      variables: { __awaiting_input: 'node_input' },
      tenantId: 'tenant-1',
    });

    const valid = await executeNode(node, {
      input: '12345678',
      variables: { __awaiting_input: 'node_input' },
      tenantId: 'tenant-1',
    });

    expect(invalid.output).toEqual({ type: 'text', text: 'Cedula invalida. Intenta de nuevo.' });
    expect(invalid.nextNodeId).toBe('node_input');
    expect(invalid.updatedVars).toEqual(
      expect.objectContaining({
        __awaiting_input: 'node_input',
      }),
    );

    expect(valid.output).toBeNull();
    expect(valid.nextNodeId).toBe('node_next');
    expect(valid.updatedVars).toEqual(
      expect.objectContaining({
        cedula: '12345678',
        __awaiting_input: null,
      }),
    );
  });

  test('handoff creates task control and transfers conversation by default', async () => {
    const node = {
      id: 'node_handoff',
      type: 'handoff',
      next: null,
      config: {
        text: 'Te paso con un agente',
        assignment_mode: 'fixed',
        assign_to: '25',
      },
    };

    const result = await executeNode(node, {
      input: null,
      variables: {},
      tenantId: 'tenant-1',
    });

    expect(result.output).toEqual({ type: 'handoff', text: 'Te paso con un agente' });
    expect(result.fallback).toBe(true);
    expect(result.terminal).toBe(true);
    expect(result.control).toEqual(
      expect.objectContaining({
        type: 'task',
        action: 'create_task',
        config: expect.objectContaining({
          assignment_mode: 'fixed',
          assign_to: '25',
        }),
      }),
    );
  });

  test('handoff can skip transfer and continue to next node', async () => {
    const node = {
      id: 'node_handoff',
      type: 'handoff',
      next: 'node_post_handoff',
      config: {
        text: 'Creamos tu solicitud y seguimos',
        transfer_conversation: false,
      },
    };

    const result = await executeNode(node, {
      input: null,
      variables: {},
      tenantId: 'tenant-1',
    });

    expect(result.output).toEqual({ type: 'text', text: 'Creamos tu solicitud y seguimos' });
    expect(result.nextNodeId).toBe('node_post_handoff');
    expect(result.fallback).toBe(false);
    expect(result.terminal).toBe(false);
    expect(result.control).toEqual(
      expect.objectContaining({
        type: 'task',
        action: 'create_task',
      }),
    );
  });
});
