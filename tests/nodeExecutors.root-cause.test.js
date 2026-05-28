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

  test('action node soft-fails cedula sync on timeout and continues', async () => {
    const node = {
      id: 'node_10',
      type: 'action',
      next: 'node_7',
      config: {
        integration_ref: 'updateContactByIdentification',
      },
      branches: {
        error: 'node_11',
      },
    };

    const integrationRunner = {
      run: jest.fn().mockRejectedValue(new Error('Integration request timed out after 8000ms')),
    };

    const result = await executeNode(node, {
      input: null,
      variables: {},
      tenantId: 'tenant-1',
      integrationRunner,
    });

    expect(result.nextNodeId).toBe('node_7');
    expect(result.fallback).toBe(false);
    expect(result.terminal).toBe(false);
    expect(result.updatedVars).toEqual(
      expect.objectContaining({
        identificacion_sync_status: 'timeout_soft_fail',
        identificacion_sync_timeout: true,
      }),
    );
  });

  test('calendar node resolves by puesto with round_robin strategy before fixed calendar_id', async () => {
    const calendarService = require('../src/services/calendarService');
    const getCalendarIdForPuestoSpy = jest
      .spyOn(calendarService, 'getCalendarIdForPuesto')
      .mockResolvedValue('cal-rr-1');
    const getAvailableSlotsSpy = jest
      .spyOn(calendarService, 'getAvailableSlots')
      .mockResolvedValue([]);

    const node = {
      id: 'node_calendar',
      type: 'calendar',
      next: 'node_next',
      config: {
        action: 'show_availability',
        calendar_id: 'cal-fixed-1',
        assignment_strategy: 'round_robin',
        agente_puesto_id: 7,
      },
      branches: {
        no_slots: 'node_no_slots',
      },
    };

    const result = await executeNode(node, {
      input: null,
      variables: {},
      tenantId: 'tenant-1',
    });

    expect(getCalendarIdForPuestoSpy).toHaveBeenCalledWith('tenant-1', {
      puestoId: 7,
      puestoNombre: null,
      strategy: 'round_robin',
    });
    expect(getAvailableSlotsSpy).toHaveBeenCalledWith('cal-rr-1', 5);
    expect(result.nextNodeId).toBe('node_no_slots');

    getCalendarIdForPuestoSpy.mockRestore();
    getAvailableSlotsSpy.mockRestore();
  });

  test('calendar select_slot creates task control with agreed details and assigned agent', async () => {
    const calendarService = require('../src/services/calendarService');
    const bookSlotSpy = jest.spyOn(calendarService, 'bookSlot').mockResolvedValue({
      appointment: {
        id: 'appt-123',
        startTime: new Date('2026-05-29T15:00:00.000Z'),
        endTime: new Date('2026-05-29T16:00:00.000Z'),
      },
    });
    const getCalendarAssignmentContextSpy = jest
      .spyOn(calendarService, 'getCalendarAssignmentContext')
      .mockResolvedValue({
        calendarId: 'cal-1',
        calendarName: 'Agenda Psicologia',
        agenteId: 2,
        agenteNombre: 'Pedro Perez',
      });

    const node = {
      id: 'node_calendar',
      type: 'calendar',
      next: 'node_confirm',
      config: {
        action: 'select_slot',
        create_task_on_booking: true,
      },
    };

    const result = await executeNode(node, {
      input: 'slot-1',
      variables: {
        selected_calendar_id: 'cal-1',
        cedula: '107910975',
        nombre: 'Andres Coto',
      },
      tenantId: 'tenant-1',
    });

    expect(bookSlotSpy).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'cal-1',
      slotId: 'slot-1',
    }));
    expect(getCalendarAssignmentContextSpy).toHaveBeenCalledWith('cal-1', 'tenant-1');
    expect(result.control).toEqual(expect.objectContaining({
      type: 'task',
      action: 'create_task',
      config: expect.objectContaining({
        assignment_mode: 'fixed',
        assign_to: 2,
      }),
    }));
    expect(result.updatedVars).toEqual(expect.objectContaining({
      appointment_id: 'appt-123',
      appointment_agente_id: 2,
      appointment_agente_nombre: 'Pedro Perez',
      appointment_customer_name: 'Andres Coto',
      appointment_customer_cedula: '107910975',
    }));

    bookSlotSpy.mockRestore();
    getCalendarAssignmentContextSpy.mockRestore();
  });
});
