const {
  normalizeFlowAutomationMetadata,
  renderTemplate,
  isRuleDue,
  hasReminderBeenSent,
  markReminderSent,
  getRecipientTargets,
} = require('../src/services/outboundFlowService');

describe('outboundFlowService', () => {
  test('normalizes inbound flow mode and outbound rules', () => {
    const metadata = normalizeFlowAutomationMetadata({
      direction: 'outbound',
      outbound_rules: [
        {
          id: 'rule_1',
          label: '24h',
          minutes_before: 1440,
          recipients: ['customer', 'agent'],
          allowed_statuses: ['scheduled'],
          days_of_week: [1, 2, 3],
          time_window_start: '08:00',
          time_window_end: '18:00',
          timezone: 'America/Mexico_City',
          message_template: 'Hola {{customer_name}}',
        },
      ],
    });

    expect(metadata.flow_mode).toBe('outbound');
    expect(metadata.outbound_rules).toHaveLength(1);
    expect(metadata.outbound_rules[0].minutesBefore).toBe(1440);
    expect(metadata.outbound_rules[0].messageTemplate).toContain('{{customer_name}}');
  });

  test('renders reminder templates with appointment context', () => {
    const rendered = renderTemplate('Hola {{customer_name}} tu cita es {{appointment_start_label}}', {
      customer_name: 'Ana',
      appointment_start_label: 'lun, 10 jun, 09:00',
    });

    expect(rendered).toContain('Ana');
    expect(rendered).toContain('lun, 10 jun, 09:00');
  });

  test('marks reminders as sent and detects duplicates', () => {
    const appointment = {
      metadata: {},
    };

    expect(hasReminderBeenSent(appointment, 'rule_1', 'customer')).toBe(false);

    const nextMetadata = markReminderSent(appointment, 'rule_1', 'customer', new Date('2026-06-20T10:00:00Z'));
    expect(nextMetadata.outbound_reminders.rule_1.customer.sent_at).toBe('2026-06-20T10:00:00.000Z');

    const updatedAppointment = { metadata: nextMetadata };
    expect(hasReminderBeenSent(updatedAppointment, 'rule_1', 'customer')).toBe(true);
  });

  test('detects due reminders inside the scan window', () => {
    const rule = {
      enabled: true,
      minutesBefore: 60,
      allowedStatuses: ['scheduled'],
      daysOfWeek: [],
      timeWindowStart: '',
      timeWindowEnd: '',
      timezone: 'America/Mexico_City',
    };

    const appointment = {
      status: 'scheduled',
      startTime: new Date('2026-06-20T13:00:00Z'),
    };

    expect(isRuleDue(rule, appointment, new Date('2026-06-20T12:00:00Z'), 5)).toBe(true);
    expect(isRuleDue(rule, appointment, new Date('2026-06-20T11:45:00Z'), 5)).toBe(false);
  });

  test('extracts recipient phones from appointment data', () => {
    const recipients = getRecipientTargets({
      userKey: '+52 123 456 7890',
      metadata: { user_name: 'Cliente' },
      calendar: {
        agente: {
          whatsapp: '52 222 333 4444',
          nombre: 'Agente',
        },
      },
    });

    expect(recipients.customer.phone).toBe('521234567890');
    expect(recipients.agent.phone).toBe('522223334444');
  });
});