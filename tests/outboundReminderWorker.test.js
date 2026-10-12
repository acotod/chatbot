const mockPrisma = {
  flow: { findFirst: jest.fn() },
  appointment: { findMany: jest.fn(), update: jest.fn() },
};

const mockRedis = { set: jest.fn(), del: jest.fn() };

jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));
jest.mock('../src/services/database', () => ({
  getConfig: jest.fn(),
  getWaCredentials: jest.fn(),
  getEmailLogStatus: jest.fn(),
}));
jest.mock('../src/services/whatsapp', () => ({ sendTextMessage: jest.fn() }));
jest.mock('../src/services/emailService', () => ({ enqueueEmail: jest.fn() }));
jest.mock('../src/services/redis', () => ({ getRedisClient: jest.fn() }));
jest.mock('../src/services/calendarService', () => ({ reconcileOrphanedGoogleEvents: jest.fn() }));
jest.mock('../src/engine/flowLoader', () => ({ loadFlowDefinitionForFlow: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../src/services/database');
const wa = require('../src/services/whatsapp');
const emailService = require('../src/services/emailService');
const redis = require('../src/services/redis');
const flowLoader = require('../src/engine/flowLoader');
const { processTenant } = require('../src/workers/outboundReminderWorker');

function createAppointment(overrides = {}) {
  return {
    id: 'appointment-1',
    tenantId: 'tenant-1',
    status: 'scheduled',
    userKey: '+50611112222',
    startTime: new Date(Date.now() + 60 * 60 * 1000),
    endTime: new Date(Date.now() + 90 * 60 * 1000),
    metadata: { user_name: 'Cliente' },
    calendar: {
      name: 'Consultorio',
      timezone: 'UTC',
      agente: { id: 8, nombre: 'Agente', whatsapp: '50688889999', email: 'AGENTE@example.com' },
    },
    ...overrides,
  };
}

function createOutboundDefinition(recipients = ['agent']) {
  return {
    flowId: 3,
    versionId: 88,
    metadata: {
      flow_mode: 'outbound',
      outbound_rules: [{
        id: 'rule_1',
        label: 'Recordatorio',
        enabled: true,
        triggerType: 'appointment_reminder',
        minutesBefore: 60,
        recipients,
        allowedStatuses: ['scheduled', 'rescheduled'],
        daysOfWeek: [],
        timeWindowStart: '',
        timeWindowEnd: '',
        timezone: 'UTC',
        messageTemplate: 'Tu cita es {{appointment_start_label}}.',
      }],
    },
  };
}

function setup({ appointment = createAppointment(), recipients = ['agent'] } = {}) {
  db.getConfig.mockResolvedValue({ valor: { flowId: 3 } });
  db.getWaCredentials.mockResolvedValue({ phoneNumberId: 'phone-id', accessToken: 'wa-token' });
  db.getEmailLogStatus.mockResolvedValue(null);
  mockPrisma.flow.findFirst.mockResolvedValue({ id: 3, nombre: 'Recordatorio Cita' });
  mockPrisma.appointment.findMany.mockResolvedValue([appointment]);
  mockPrisma.appointment.update.mockImplementation(async ({ data }) => {
    appointment.metadata = data.metadata;
    return appointment;
  });
  flowLoader.loadFlowDefinitionForFlow.mockResolvedValue(createOutboundDefinition(recipients));
  wa.sendTextMessage.mockResolvedValue({ messages: [{ id: 'wa-message-1' }] });
  emailService.enqueueEmail.mockResolvedValue({ ok: true, queued: true, emailLogId: 90 });
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.del.mockResolvedValue(1);
  redis.getRedisClient.mockReturnValue(mockRedis);
  return appointment;
}

describe('outboundReminderWorker multi-channel reminders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('loads the designated tenant flow and sends agent WhatsApp plus email', async () => {
    const appointment = setup();

    await processTenant({ id: 'tenant-1', nombre: 'Global Med' });

    expect(flowLoader.loadFlowDefinitionForFlow).toHaveBeenCalledWith('tenant-1', 3);
    expect(mockPrisma.flow.findFirst).toHaveBeenCalledWith({
      where: { id: 3, tenantId: 'tenant-1', activo: true },
      select: { id: true, nombre: true },
    });
    expect(wa.sendTextMessage).toHaveBeenCalledWith('phone-id', '50688889999', expect.stringContaining('Tu cita es'), 'wa-token');
    expect(emailService.enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'agente@example.com',
      subject: 'Recordatorio de cita',
      text: expect.stringContaining('Tu cita es'),
      tenantId: 'tenant-1',
      metadata: expect.objectContaining({
        event: 'appointment.reminder',
        flowId: 3,
        flowVersionId: 88,
        appointmentId: 'appointment-1',
        ruleId: 'rule_1',
        recipientRole: 'agent',
        channel: 'email',
      }),
    }));
    expect(appointment.metadata.outbound_reminders.rule_1.agent_whatsapp.status).toBe('sent');
    expect(appointment.metadata.outbound_reminders.rule_1.agent_email).toMatchObject({ status: 'queued', email_log_id: 90 });
  });

  test('queues email even when the WhatsApp send fails', async () => {
    setup();
    wa.sendTextMessage.mockRejectedValue(new Error('Meta unavailable'));

    await processTenant({ id: 'tenant-1', nombre: 'Global Med' });

    expect(emailService.enqueueEmail).toHaveBeenCalledTimes(1);
  });

  test('omits only the missing WhatsApp contact and still queues email', async () => {
    setup({ appointment: createAppointment({ calendar: { name: 'Consultorio', timezone: 'UTC', agente: { id: 8, nombre: 'Agente', whatsapp: '', email: 'agente@example.com' } } }) });

    await processTenant({ id: 'tenant-1', nombre: 'Global Med' });

    expect(wa.sendTextMessage).not.toHaveBeenCalled();
    expect(emailService.enqueueEmail).toHaveBeenCalledTimes(1);
  });

  test('queues email when WhatsApp credentials are missing', async () => {
    setup();
    db.getWaCredentials.mockResolvedValue({ phoneNumberId: '', accessToken: '' });

    await processTenant({ id: 'tenant-1', nombre: 'Global Med' });

    expect(wa.sendTextMessage).not.toHaveBeenCalled();
    expect(emailService.enqueueEmail).toHaveBeenCalledTimes(1);
  });

  test('sends agent WhatsApp when the assigned agent has no valid email', async () => {
    setup({
      appointment: createAppointment({
        calendar: { name: 'Consultorio', timezone: 'UTC', agente: { id: 8, nombre: 'Agente', whatsapp: '50688889999', email: 'invalid' } },
      }),
    });

    await processTenant({ id: 'tenant-1', nombre: 'Global Med' });

    expect(wa.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(emailService.enqueueEmail).not.toHaveBeenCalled();
  });

  test('keeps customer recipients on WhatsApp only', async () => {
    setup({ recipients: ['customer'] });

    await processTenant({ id: 'tenant-1', nombre: 'Global Med' });

    expect(wa.sendTextMessage).toHaveBeenCalledWith('phone-id', '50611112222', expect.stringContaining('Tu cita es'), 'wa-token');
    expect(emailService.enqueueEmail).not.toHaveBeenCalled();
  });

  test('does not enqueue another email while a prior EmailLog is pending', async () => {
    const appointment = createAppointment({
      metadata: {
        outbound_reminders: {
          rule_1: {
            agent_whatsapp: { status: 'sent', sent_at: new Date().toISOString() },
            agent_email: { status: 'queued', email_log_id: 77 },
          },
        },
      },
    });
    setup({ appointment });
    appointment.metadata.outbound_reminders.rule_1.agent_email = { status: 'queued', email_log_id: 77 };
    appointment.metadata.outbound_reminders.rule_1.agent_whatsapp = { status: 'sent', sent_at: new Date().toISOString() };
    db.getEmailLogStatus.mockResolvedValue({ id: 77, status: 'pending', attempts: 0, updatedAt: new Date() });

    await processTenant({ id: 'tenant-1', nombre: 'Global Med' });

    expect(wa.sendTextMessage).not.toHaveBeenCalled();
    expect(emailService.enqueueEmail).not.toHaveBeenCalled();
  });

  test('records a terminal EmailLog failure without treating it as delivered', async () => {
    const appointment = createAppointment({
      metadata: {
        outbound_reminders: {
          rule_1: {
            agent_whatsapp: { status: 'sent', sent_at: new Date().toISOString() },
            agent_email: { status: 'queued', email_log_id: 77 },
          },
        },
      },
    });
    setup({ appointment });
    appointment.metadata.outbound_reminders.rule_1.agent_email = { status: 'queued', email_log_id: 77 };
    appointment.metadata.outbound_reminders.rule_1.agent_whatsapp = { status: 'sent', sent_at: new Date().toISOString() };
    db.getEmailLogStatus.mockResolvedValue({ id: 77, status: 'failed', attempts: 4, updatedAt: new Date() });

    await processTenant({ id: 'tenant-1', nombre: 'Global Med' });

    expect(emailService.enqueueEmail).not.toHaveBeenCalled();
    expect(appointment.metadata.outbound_reminders.rule_1.agent_email.status).toBe('failed');
    expect(appointment.metadata.outbound_reminders.rule_1.agent_email.sent_at).toBeUndefined();
  });

  test('marks a reminder failed if its queued EmailLog record is missing', async () => {
    const appointment = createAppointment({
      metadata: {
        outbound_reminders: {
          rule_1: {
            agent_whatsapp: { status: 'sent', sent_at: new Date().toISOString() },
            agent_email: { status: 'queued', email_log_id: 77 },
          },
        },
      },
    });
    setup({ appointment });
    appointment.metadata.outbound_reminders.rule_1.agent_email = { status: 'queued', email_log_id: 77 };
    appointment.metadata.outbound_reminders.rule_1.agent_whatsapp = { status: 'sent', sent_at: new Date().toISOString() };
    db.getEmailLogStatus.mockResolvedValue(null);

    await processTenant({ id: 'tenant-1', nombre: 'Global Med' });

    expect(emailService.enqueueEmail).not.toHaveBeenCalled();
    expect(appointment.metadata.outbound_reminders.rule_1.agent_email.status).toBe('failed');
    expect(appointment.metadata.outbound_reminders.rule_1.agent_email.email_log_id).toBe(77);
  });
});
