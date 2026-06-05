const express = require('express');
const request = require('supertest');

const ORIGINAL_WA_APP_SECRET = process.env.WA_APP_SECRET;
const ORIGINAL_FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
process.env.WA_APP_SECRET = '';
process.env.FACEBOOK_APP_SECRET = '';

jest.mock('../src/middleware/requireJwt', () => (_req, _res, next) => next());

jest.mock('../src/services/database', () => ({
  findTenantByWaPhoneNumberId: jest.fn(),
  getConfig: jest.fn(),
  getWaCredentials: jest.fn(),
  getPrismaClient: jest.fn(() => ({
    appointment: {
      findFirst: jest.fn(),
    },
  })),
  getWaAppSecret: jest.fn(),
  updateMensajeDeliveryStatusByWaMsgId: jest.fn(),
  findMensajeByWaMsgId: jest.fn(),
  findOrCreateUser: jest.fn(),
  saveMensaje: jest.fn(),
  findOpenSolicitudForUser: jest.fn(),
  getSolicitudById: jest.fn(),
  saveSolicitud: jest.fn(),
  updateSolicitudEstado: jest.fn(),
  addSolicitudComment: jest.fn(),
}));

jest.mock('../src/services/socketService', () => ({
  emit: jest.fn(),
}));

jest.mock('../src/services/whatsapp', () => ({
  markAsRead: jest.fn().mockResolvedValue({}),
  sendTextMessage: jest.fn().mockResolvedValue({ messages: [{ id: 'wa_out_1' }] }),
  sendButtonMessage: jest.fn().mockResolvedValue({ messages: [{ id: 'wa_out_1' }] }),
}));

jest.mock('../src/services/chatbotRouter', () => ({
  routeMessage: jest.fn().mockResolvedValue({ response: null, fallbackToHuman: false }),
}));

jest.mock('../src/services/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true, messageId: 'mail_1', accepted: [], rejected: [] }),
}));

jest.mock('../src/services/flowNavigation', () => ({
  getNextScreen: jest.fn(),
}));

jest.mock('../src/services/redis', () => ({
  getRedisClient: jest.fn(() => null),
}));

jest.mock('../src/services/eventGateway', () => ({
  ingestEvent: jest.fn().mockResolvedValue({ duplicate: false, queued: false }),
}));

const sharedPrisma = {
  appointment: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
  configuracion: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
  },
  flowVersion: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
  solicitud: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
  mensaje: {
    update: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  },
};

const whatsappRouter = require('../src/routes/whatsapp');
const db = require('../src/services/database');
const wa = require('../src/services/whatsapp');
const socketService = require('../src/services/socketService');
const eventGateway = require('../src/services/eventGateway');
const emailService = require('../src/services/emailService');

function createApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use('/whatsapp', whatsappRouter);
  return app;
}

async function flushAsync(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('POST /whatsapp dual-write UEG', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.getPrismaClient.mockReturnValue(sharedPrisma);
    db.findTenantByWaPhoneNumberId.mockResolvedValue({ id: 'tenant-1', activo: true });
    db.getWaCredentials.mockResolvedValue({ accessToken: 'token-123', phoneNumberId: '1234567890' });
    db.getConfig.mockResolvedValue({ valor: { accessToken: 'token-123' } });
    db.updateMensajeDeliveryStatusByWaMsgId.mockResolvedValue({});
    db.findMensajeByWaMsgId.mockResolvedValue(null);
    db.findOrCreateUser.mockResolvedValue({ id: 7, phone: '573001112233' });
    db.saveMensaje.mockResolvedValue({
      id: 101,
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      waMsgId: 'wamid.inbound.123',
      tipo: 'text',
    });
    sharedPrisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-1',
      startTime: new Date('2026-06-05T17:41:18.354Z'),
      endTime: new Date('2026-06-05T18:11:18.354Z'),
      calendar: { timezone: 'America/Costa_Rica' },
    });
    eventGateway.ingestEvent.mockResolvedValue({ duplicate: false, queued: false });
  });

  afterAll(() => {
    if (ORIGINAL_WA_APP_SECRET === undefined) {
      delete process.env.WA_APP_SECRET;
    } else {
      process.env.WA_APP_SECRET = ORIGINAL_WA_APP_SECRET;
    }

    if (ORIGINAL_FACEBOOK_APP_SECRET === undefined) {
      delete process.env.FACEBOOK_APP_SECRET;
    } else {
      process.env.FACEBOOK_APP_SECRET = ORIGINAL_FACEBOOK_APP_SECRET;
    }
  });

  test('status updates are dual-written to UEG', async () => {
    const app = createApp();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: '1234567890' },
            statuses: [{
              id: 'wamid.status.1',
              status: 'delivered',
              timestamp: '1717171717',
            }],
          },
        }],
      }],
    };

    const res = await request(app).post('/whatsapp').send(payload);

    expect(res.status).toBe(200);
    await flushAsync();

    expect(eventGateway.ingestEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      idempotencyKeyHeader: 'wa_status:wamid.status.1:delivered',
      rawEvent: expect.objectContaining({
        eventType: 'message_status_updated',
        channel: 'whatsapp',
      }),
    }));
  });

  test('incoming message keeps legacy flow when UEG dual-write fails', async () => {
    const app = createApp();
    eventGateway.ingestEvent.mockRejectedValue(new Error('ueg unavailable'));

    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: '1234567890' },
            contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }],
            messages: [{
              id: 'wamid.inbound.123',
              from: '573001112233',
              type: 'text',
              timestamp: '1717171717',
              text: { body: 'hola' },
            }],
          },
        }],
      }],
    };

    const res = await request(app).post('/whatsapp').send(payload);

    expect(res.status).toBe(200);
    await flushAsync();

    expect(db.saveMensaje).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      direccion: 'entrada',
      waMsgId: 'wamid.inbound.123',
    }));
    expect(eventGateway.ingestEvent).toHaveBeenCalled();
  });

  test('open solicitud does not block inbound when initial WABA flow is configured', async () => {
    const app = createApp();
    db.findOpenSolicitudForUser.mockResolvedValueOnce({ id: 999, estado: 'open' });
    db.getConfig.mockImplementation(async (_tenantId, key) => {
      if (key === 'initial_waba_flow') {
        return {
          valor: {
            meta_flow_id: '977764588581125',
            flow_cta: 'Abrir flujo',
            body_text: 'Hola 👋',
            initial_screen: 'NODE',
          },
        };
      }
      return { valor: { accessToken: 'token-123' } };
    });

    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: '1234567890' },
            contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }],
            messages: [{
              id: 'wamid.inbound.456',
              from: '573001112233',
              type: 'text',
              timestamp: '1717171717',
              text: { body: 'hola' },
            }],
          },
        }],
      }],
    };

    const res = await request(app).post('/whatsapp').send(payload);

    expect(res.status).toBe(200);
    await flushAsync();

    expect(db.saveMensaje).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      direccion: 'entrada',
      waMsgId: 'wamid.inbound.456',
    }));
    expect(db.findOpenSolicitudForUser).toHaveBeenCalledWith(7, 'tenant-1');
  });

  test('open solicitud offers actionable options when no initial WABA flow is configured', async () => {
    const app = createApp();
    db.findOpenSolicitudForUser.mockResolvedValueOnce({
      id: 999,
      estado: 'open',
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      variablesJson: {
        appointment_id: 'appt-1',
        appointment_start: '2026-06-05T17:41:18.354Z',
      },
    });
    db.getConfig.mockImplementation(async (_tenantId, key) => {
      if (key === 'initial_waba_flow') {
        return { valor: null };
      }
      return { valor: { accessToken: 'token-123' } };
    });

    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: '1234567890' },
            contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }],
            messages: [{
              id: 'wamid.inbound.789',
              from: '573001112233',
              type: 'text',
              timestamp: '1717171717',
              text: { body: 'hola' },
            }],
          },
        }],
      }],
    };

    const res = await request(app).post('/whatsapp').send(payload);

    expect(res.status).toBe(200);
    await flushAsync();

    expect(wa.sendTextMessage).toHaveBeenCalledWith(
      '1234567890',
      '573001112233',
      'Hola Ana ya tienes una solicitud activa para 5 de junio de 2026, 11:41. Que deseas hacer?',
      'token-123',
    );

    expect(wa.sendButtonMessage).toHaveBeenCalledWith(
      '1234567890',
      '573001112233',
      expect.stringContaining('Ya tienes una solicitud activa'),
      expect.arrayContaining([
        expect.objectContaining({ id: 'solicitud_activa_cancelar' }),
        expect.objectContaining({ id: 'solicitud_activa_comentar' }),
        expect.objectContaining({ id: 'solicitud_activa_agente' }),
      ]),
      'token-123',
    );
  });

  test('open solicitud can be cancelled from WhatsApp action button', async () => {
    const app = createApp();
    db.findOpenSolicitudForUser.mockResolvedValueOnce({ id: 999, estado: 'open' });
    db.getConfig.mockImplementation(async (_tenantId, key) => {
      if (key === 'initial_waba_flow') {
        return { valor: null };
      }
      return { valor: { accessToken: 'token-123' } };
    });
    db.updateSolicitudEstado.mockResolvedValueOnce({ id: 999, estado: 'rejected' });

    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: '1234567890' },
            contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }],
            messages: [{
              id: 'wamid.inbound.790',
              from: '573001112233',
              type: 'interactive',
              timestamp: '1717171717',
              interactive: {
                type: 'button_reply',
                button_reply: {
                  id: 'solicitud_activa_cancelar',
                  title: 'Cancelar solicitud',
                },
              },
            }],
          },
        }],
      }],
    };

    const res = await request(app).post('/whatsapp').send(payload);

    expect(res.status).toBe(200);
    await flushAsync();

    expect(db.updateSolicitudEstado).toHaveBeenCalledWith(999, 'tenant-1', 'rejected');
    expect(wa.sendTextMessage).toHaveBeenCalledWith(
      '1234567890',
      '573001112233',
      expect.stringContaining('cancelamos tu solicitud activa'),
      'token-123',
    );
  });

  test('open solicitud reroutes customer message via internal agent chat and email', async () => {
    const app = createApp();
    db.findOpenSolicitudForUser.mockResolvedValueOnce({ id: 999, estado: 'open', agenteId: 23 });
    db.getSolicitudById.mockResolvedValueOnce({
      id: 999,
      agente: { id: 23, nombre: 'Pedro Perez', whatsapp: '+506 8888-7777', email: 'andres.coto@pmc-dev.com' },
    });
    db.addSolicitudComment.mockResolvedValueOnce({ id: 1001 });
    db.getConfig.mockImplementation(async (_tenantId, key) => {
      if (key === 'initial_waba_flow') {
        return { valor: null };
      }
      return { valor: { accessToken: 'token-123' } };
    });

    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: '1234567890' },
            contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }],
            messages: [{
              id: 'wamid.inbound.791',
              from: '573001112233',
              type: 'text',
              timestamp: '1717171717',
              text: { body: 'agente: por favor llamame despues de las 4pm' },
            }],
          },
        }],
      }],
    };

    const res = await request(app).post('/whatsapp').send(payload);

    expect(res.status).toBe(200);
    await flushAsync();

    expect(db.addSolicitudComment).toHaveBeenCalledWith(expect.objectContaining({
      solicitudId: 999,
      tenantId: 'tenant-1',
      userId: null,
      content: 'por favor llamame despues de las 4pm',
      visibility: 'customer',
    }));
    expect(wa.sendTextMessage).toHaveBeenCalledWith(
      '1234567890',
      '573001112233',
      expect.stringContaining('chat interno del agente'),
      'token-123',
    );
    expect(wa.sendTextMessage).not.toHaveBeenCalledWith(
      '1234567890',
      '50688887777',
      expect.any(String),
      'token-123',
    );
    expect(emailService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'andres.coto@pmc-dev.com',
      tenantId: 'tenant-1',
      subject: expect.stringContaining('Nueva solicitud asignada #999'),
    }));
    expect(socketService.emit).toHaveBeenCalledWith(
      'tenant-1',
      'SOLICITUD_MESSAGE_SENT',
      expect.objectContaining({
        solicitudId: 999,
        tenantId: 'tenant-1',
        userId: 7,
        source: 'customer',
        via: 'assigned_agent_internal',
      }),
    );
  });
});
