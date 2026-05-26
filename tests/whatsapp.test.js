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
  getPrismaClient: jest.fn(() => null),
  getWaAppSecret: jest.fn(),
  updateMensajeDeliveryStatusByWaMsgId: jest.fn(),
  findMensajeByWaMsgId: jest.fn(),
  findOrCreateUser: jest.fn(),
  saveMensaje: jest.fn(),
  findOpenSolicitudForUser: jest.fn(),
  saveSolicitud: jest.fn(),
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

jest.mock('../src/services/flowNavigation', () => ({
  getNextScreen: jest.fn(),
}));

jest.mock('../src/services/redis', () => ({
  getRedisClient: jest.fn(() => null),
}));

jest.mock('../src/services/eventGateway', () => ({
  ingestEvent: jest.fn().mockResolvedValue({ duplicate: false, queued: false }),
}));

const whatsappRouter = require('../src/routes/whatsapp');
const db = require('../src/services/database');
const eventGateway = require('../src/services/eventGateway');

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
});
