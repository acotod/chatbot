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

  test('message node interpolates single-brace placeholders with spaced keys', async () => {
    const node = {
      id: 'node_msg',
      type: 'message',
      next: 'node_next',
      config: { text: '¿Cómo te has sentido últimamente? {Cliente Cedula}' },
    };

    const result = await executeNode(node, {
      input: null,
      variables: {
        cliente_cedula: '107910975',
      },
      tenantId: 'tenant-1',
    });

    expect(result.output).toEqual({
      type: 'text',
      text: '¿Cómo te has sentido últimamente? 107910975',
    });
    expect(result.nextNodeId).toBe('node_next');
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

  test('input node runs integration_ref and merges response vars for nombre', async () => {
    const node = {
      id: 'node_input_cedula',
      type: 'input',
      next: 'node_next',
      config: {
        text: 'Dame tu numero de cedula',
        variable: 'cliente_cedula',
        integration_ref: 'updateContactByIdentification',
      },
    };

    const integrationRunner = {
      run: jest.fn().mockResolvedValue({
        responseVars: {
          'variables.nombre': 'ANDRES COTO DOBLES',
          nombre: 'ANDRES COTO DOBLES',
        },
      }),
    };

    const result = await executeNode(node, {
      input: '107910975',
      variables: { __awaiting_input: 'node_input_cedula' },
      tenantId: 'tenant-1',
      integrationRunner,
    });

    expect(integrationRunner.run).toHaveBeenCalledWith(
      'tenant-1',
      'updateContactByIdentification',
      expect.objectContaining({ cliente_cedula: '107910975' }),
      expect.objectContaining({ nodeRef: 'node_input_cedula', nodeType: 'input' }),
    );
    expect(result.updatedVars).toEqual(
      expect.objectContaining({
        cliente_cedula: '107910975',
        nombre: 'ANDRES COTO DOBLES',
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
    const getCalendarsForPuestoSpy = jest
      .spyOn(calendarService, 'getCalendarsForPuesto')
      .mockResolvedValue([
        { id: 'cal-rr-1', name: 'Agenda Psicologia', agenteId: 7, agenteNombre: 'Pedro Perez' },
      ]);
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

    expect(getCalendarsForPuestoSpy).toHaveBeenCalledWith('tenant-1', {
      puestoId: 7,
      puestoNombre: '',
    });
    expect(getAvailableSlotsSpy).toHaveBeenCalledWith('cal-rr-1', 5);
    expect(result.nextNodeId).toBe('node_no_slots');

    getCalendarsForPuestoSpy.mockRestore();
    getAvailableSlotsSpy.mockRestore();
  });

  test('calendar show_availability aggregates psychologist agents and stores llm extraction', async () => {
    const calendarService = require('../src/services/calendarService');
    const getCalendarsForPuestoSpy = jest
      .spyOn(calendarService, 'getCalendarsForPuesto')
      .mockResolvedValue([
        { id: 'cal-1', name: 'Agenda Psicologia A', agenteId: 10, agenteNombre: 'Dra. Ana' },
        { id: 'cal-2', name: 'Agenda Psicologia B', agenteId: 11, agenteNombre: 'Dr. Bruno' },
      ]);
    const getAvailableSlotsSpy = jest
      .spyOn(calendarService, 'getAvailableSlots')
      .mockImplementation(async (calendarId) => {
        if (calendarId === 'cal-1') {
          return [
            { id: 'slot-1', startTime: new Date('2026-06-03T14:00:00.000Z'), endTime: new Date('2026-06-03T15:00:00.000Z') },
          ];
        }
        return [
          { id: 'slot-2', startTime: new Date('2026-06-03T13:00:00.000Z'), endTime: new Date('2026-06-03T14:00:00.000Z') },
          { id: 'slot-3', startTime: new Date('2026-06-04T15:00:00.000Z'), endTime: new Date('2026-06-04T16:00:00.000Z') },
        ];
      });

    const llmService = {
      callLlmForJson: jest.fn().mockResolvedValue({
        json: {
          resumen: 'Los dias mas proximos disponibles son miercoles y jueves, con horarios para Dra. Ana y Dr. Bruno.',
          dias_mas_proximos: [
            { fecha: '2026-06-03', dia: 'miercoles 3 de junio', horas: ['08:00', '09:00'], agentes: ['Dr. Bruno', 'Dra. Ana'] },
          ],
          agentes: [
            { agente: 'Dr. Bruno', primer_dia: 'miercoles 3 de junio', horas: ['08:00', '11:00'] },
          ],
        },
      }),
    };

    const node = {
      id: 'node_calendar',
      type: 'calendar',
      next: 'node_next',
      config: {
        action: 'show_availability',
        agente_puesto_nombre: 'Psicologia',
      },
    };

    const result = await executeNode(node, {
      input: null,
      variables: {},
      tenantId: 'tenant-1',
      llmService,
    });

    expect(getCalendarsForPuestoSpy).toHaveBeenCalledWith('tenant-1', {
      puestoId: null,
      puestoNombre: 'Psicologia',
    });
    expect(result.output).toEqual(expect.objectContaining({
      type: 'buttons',
      buttons: expect.arrayContaining([
        expect.objectContaining({ id: 'slot-2' }),
        expect.objectContaining({ id: 'slot-1' }),
      ]),
    }));
    expect(result.updatedVars).toEqual(expect.objectContaining({
      selected_calendar_id: 'cal-2',
      agenda_horarios_disponibles_summary: 'Los dias mas proximos disponibles son miercoles y jueves, con horarios para Dra. Ana y Dr. Bruno.',
      agenda_horarios_disponibles_llm: expect.objectContaining({
        dias_mas_proximos: expect.any(Array),
        agentes: expect.any(Array),
      }),
    }));
    expect(result.updatedVars.agenda_horarios_disponibles_items).toEqual([
      expect.objectContaining({ slotId: 'slot-2', calendarId: 'cal-2', agenteNombre: 'Dr. Bruno' }),
      expect.objectContaining({ slotId: 'slot-1', calendarId: 'cal-1', agenteNombre: 'Dra. Ana' }),
      expect.objectContaining({ slotId: 'slot-3', calendarId: 'cal-2', agenteNombre: 'Dr. Bruno' }),
    ]);

    getCalendarsForPuestoSpy.mockRestore();
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
      input: '11111111-1111-1111-1111-111111111111',
      variables: {
        selected_calendar_id: 'cal-1',
        cedula: '107910975',
        nombre: 'Andres Coto',
      },
      tenantId: 'tenant-1',
    });

    expect(bookSlotSpy).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'cal-1',
      slotId: '11111111-1111-1111-1111-111111111111',
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

  test('calendar select_slot accepts option index and resolves to slot id', async () => {
    const calendarService = require('../src/services/calendarService');
    const getAvailableSlotsSpy = jest.spyOn(calendarService, 'getAvailableSlots').mockResolvedValue([
      { id: '11111111-1111-1111-1111-111111111111', startTime: new Date('2026-05-29T15:00:00.000Z') },
      { id: '22222222-2222-2222-2222-222222222222', startTime: new Date('2026-05-29T16:00:00.000Z') },
    ]);
    const bookSlotSpy = jest.spyOn(calendarService, 'bookSlot').mockResolvedValue({
      appointment: {
        id: 'appt-idx-1',
        startTime: new Date('2026-05-29T16:00:00.000Z'),
        endTime: new Date('2026-05-29T17:00:00.000Z'),
      },
    });
    const getCalendarAssignmentContextSpy = jest
      .spyOn(calendarService, 'getCalendarAssignmentContext')
      .mockResolvedValue(null);

    const node = {
      id: 'node_calendar',
      type: 'calendar',
      next: 'node_confirm',
      config: {
        action: 'select_slot',
      },
    };

    const result = await executeNode(node, {
      input: '2',
      variables: { selected_calendar_id: 'cal-1' },
      tenantId: 'tenant-1',
    });

    expect(bookSlotSpy).toHaveBeenCalledWith(expect.objectContaining({
      slotId: '22222222-2222-2222-2222-222222222222',
    }));
    expect(result.nextNodeId).toBe('node_confirm');
    expect(result.updatedVars).toEqual(expect.objectContaining({
      appointment_id: 'appt-idx-1',
    }));

    getAvailableSlotsSpy.mockRestore();
    bookSlotSpy.mockRestore();
    getCalendarAssignmentContextSpy.mockRestore();
  });

  test('calendar select_slot uses cached availability item calendar when multiple psychologist agendas were shown', async () => {
    const calendarService = require('../src/services/calendarService');
    const bookSlotSpy = jest.spyOn(calendarService, 'bookSlot').mockResolvedValue({
      appointment: {
        id: 'appt-multi-1',
        startTime: new Date('2026-06-03T13:00:00.000Z'),
        endTime: new Date('2026-06-03T14:00:00.000Z'),
      },
    });
    const getCalendarAssignmentContextSpy = jest
      .spyOn(calendarService, 'getCalendarAssignmentContext')
      .mockResolvedValue(null);

    const node = {
      id: 'node_calendar',
      type: 'calendar',
      next: 'node_confirm',
      config: {
        action: 'select_slot',
      },
    };

    const result = await executeNode(node, {
      input: '2',
      variables: {
        selected_calendar_id: 'cal-1',
        agenda_horarios_disponibles_items: [
          {
            slotId: 'slot-1',
            calendarId: 'cal-1',
            slotLabel: 'mié, 3 jun, 09:00',
          },
          {
            slotId: 'slot-2',
            calendarId: 'cal-2',
            slotLabel: 'mié, 3 jun, 10:00',
          },
        ],
      },
      tenantId: 'tenant-1',
    });

    expect(bookSlotSpy).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'cal-2',
      slotId: 'slot-2',
    }));
    expect(result.updatedVars).toEqual(expect.objectContaining({
      selected_calendar_id: 'cal-2',
      appointment_id: 'appt-multi-1',
    }));

    bookSlotSpy.mockRestore();
    getCalendarAssignmentContextSpy.mockRestore();
  });

  test('calendar select_slot can resolve a natural-language psychologist choice with llm and reserve it', async () => {
    const calendarService = require('../src/services/calendarService');
    const bookSlotSpy = jest.spyOn(calendarService, 'bookSlot').mockResolvedValue({
      appointment: {
        id: 'appt-llm-1',
        startTime: new Date('2026-06-03T13:00:00.000Z'),
        endTime: new Date('2026-06-03T14:00:00.000Z'),
      },
    });
    const getCalendarAssignmentContextSpy = jest
      .spyOn(calendarService, 'getCalendarAssignmentContext')
      .mockResolvedValue(null);

    const llmService = {
      callLlmForJson: jest.fn().mockResolvedValue({
        json: {
          matched: true,
          slot_id: 'slot-2',
          calendar_id: 'cal-2',
          reason: 'El usuario eligio a Bruno el miercoles temprano.',
        },
      }),
    };

    const node = {
      id: 'node_calendar',
      type: 'calendar',
      next: 'node_confirm',
      config: {
        action: 'select_slot',
      },
    };

    const result = await executeNode(node, {
      input: 'prefiero con Bruno el miercoles a las 8',
      variables: {
        selected_calendar_id: 'cal-1',
        agenda_horarios_disponibles_items: [
          {
            slotId: 'slot-1',
            calendarId: 'cal-1',
            agenteNombre: 'Dra. Ana',
            slotLabel: 'mié, 3 jun, 09:00',
            dayLabel: 'miercoles 3 de junio',
            hourLabel: '09:00',
            startTime: '2026-06-03T14:00:00.000Z',
          },
          {
            slotId: 'slot-2',
            calendarId: 'cal-2',
            agenteNombre: 'Dr. Bruno',
            slotLabel: 'mié, 3 jun, 08:00',
            dayLabel: 'miercoles 3 de junio',
            hourLabel: '08:00',
            startTime: '2026-06-03T13:00:00.000Z',
          },
        ],
      },
      tenantId: 'tenant-1',
      llmService,
    });

    expect(bookSlotSpy).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'cal-2',
      slotId: 'slot-2',
    }));
    expect(result.updatedVars).toEqual(expect.objectContaining({
      selected_calendar_id: 'cal-2',
      appointment_id: 'appt-llm-1',
    }));

    bookSlotSpy.mockRestore();
    getCalendarAssignmentContextSpy.mockRestore();
  });

  test('calendar select_slot retries with friendly error when input is not a valid slot', async () => {
    const calendarService = require('../src/services/calendarService');
    const getAvailableSlotsSpy = jest.spyOn(calendarService, 'getAvailableSlots').mockResolvedValue([
      { id: '11111111-1111-1111-1111-111111111111', startTime: new Date('2026-05-29T15:00:00.000Z') },
    ]);
    const getCalendarAssignmentContextSpy = jest
      .spyOn(calendarService, 'getCalendarAssignmentContext')
      .mockResolvedValue(null);
    const bookSlotSpy = jest.spyOn(calendarService, 'bookSlot').mockResolvedValue({ error: 'SLOT_NOT_FOUND' });

    const node = {
      id: 'node_calendar',
      type: 'calendar',
      next: 'node_confirm',
      config: {
        action: 'select_slot',
        error_text: 'La opcion no es valida. Selecciona una fecha y hora de la lista.',
      },
    };

    const result = await executeNode(node, {
      input: 'hola',
      variables: {
        selected_calendar_id: 'cal-1',
        agenda_horarios_disponibles_summary: 'Horarios disponibles: jueves 10:00 y jueves 11:00.',
      },
      tenantId: 'tenant-1',
    });

    expect(bookSlotSpy).not.toHaveBeenCalled();
    expect(result.nextNodeId).toBe('node_calendar');
    expect(result.output).toEqual(expect.objectContaining({
      text: expect.stringContaining('La opcion no es valida. Selecciona una fecha y hora de la lista.'),
    }));

    getAvailableSlotsSpy.mockRestore();
    getCalendarAssignmentContextSpy.mockRestore();
    bookSlotSpy.mockRestore();
  });

  test('calendar select_slot advances when user no longer wants the reservation', async () => {
    const calendarService = require('../src/services/calendarService');
    const bookSlotSpy = jest.spyOn(calendarService, 'bookSlot').mockResolvedValue({ error: 'SHOULD_NOT_CALL' });

    const node = {
      id: 'node_calendar',
      type: 'calendar',
      next: 'node_next',
      config: {
        action: 'select_slot',
        cancel_text: 'Entendido, continuo sin agendar la cita.',
      },
      branches: {
        cancel: 'node_skip_booking',
      },
    };

    const result = await executeNode(node, {
      input: 'ya no lo quiero',
      variables: { selected_calendar_id: 'cal-1' },
      tenantId: 'tenant-1',
    });

    expect(bookSlotSpy).not.toHaveBeenCalled();
    expect(result.nextNodeId).toBe('node_skip_booking');
    expect(result.output).toEqual({
      type: 'text',
      text: 'Entendido, continuo sin agendar la cita.',
    });
    expect(result.updatedVars).toEqual(expect.objectContaining({
      appointment_status: 'cancelled_by_user',
      selected_slot_id: null,
    }));

    bookSlotSpy.mockRestore();
  });

  test('calendar select_slot maps cliente_cedula alias into task payload', async () => {
    const calendarService = require('../src/services/calendarService');
    const bookSlotSpy = jest.spyOn(calendarService, 'bookSlot').mockResolvedValue({
      appointment: {
        id: 'appt-alias-1',
        startTime: new Date('2026-05-29T09:00:00.000Z'),
        endTime: new Date('2026-05-29T10:00:00.000Z'),
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
      input: '11111111-1111-1111-1111-111111111111',
      variables: {
        selected_calendar_id: 'cal-1',
        cliente_cedula: '107910975',
      },
      tenantId: 'tenant-1',
    });

    expect(bookSlotSpy).toHaveBeenCalled();
    expect(result.updatedVars).toEqual(expect.objectContaining({
      appointment_customer_cedula: '107910975',
      appointment_agente_id: 2,
    }));

    bookSlotSpy.mockRestore();
    getCalendarAssignmentContextSpy.mockRestore();
  });
});
