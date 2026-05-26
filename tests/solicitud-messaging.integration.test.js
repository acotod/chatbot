const express = require('express');
const request = require('supertest');

const ORIGINAL_WA_APP_SECRET = process.env.WA_APP_SECRET;
const ORIGINAL_FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
process.env.WA_APP_SECRET = '';
process.env.FACEBOOK_APP_SECRET = '';

let mockCurrentAdmin = { adminUserId: 100, email: 'admin@test.local', tenantId: 'tenant-1', superAdmin: false };
let mockCurrentAgent = { agenteId: 7, tenantId: 'tenant-1', nombre: 'Agente Uno', email: 'agente@test.local' };

jest.mock('../src/middleware/requireJwt', () => (req, _res, next) => {
  req.admin = mockCurrentAdmin;
  next();
});

jest.mock('../src/middleware/requirePermiso', () => () => (_req, _res, next) => next());

jest.mock('../src/middleware/requireAgentJwt', () => (req, _res, next) => {
  req.agent = mockCurrentAgent;
  next();
});

jest.mock('../src/services/socketService', () => ({
  emit: jest.fn(),
}));

jest.mock('../src/services/audit', () => ({
  audit: jest.fn(),
}));

jest.mock('../src/services/whatsapp', () => ({
  sendTextMessage: jest.fn(),
}));

jest.mock('../src/services/database', () => ({
  SOLICITUD_STATUS_VALUES: ['open', 'in_progress', 'completed', 'rejected'],
  findTenantBySlug: jest.fn(),
  listMensajesBySolicitud: jest.fn(),
  getSolicitudMessagingContext: jest.fn(),
  getWaCredentials: jest.fn(),
  saveMensaje: jest.fn(),
  findTenantByWaPhoneNumberId: jest.fn(),
  updateMensajeDeliveryStatusByWaMsgId: jest.fn(),
  findMensajeByWaMsgId: jest.fn(),
  findOrCreateUser: jest.fn(),
  getPrismaClient: jest.fn().mockReturnValue(null),
}));

const db = require('../src/services/database');
const wa = require('../src/services/whatsapp');
const socketService = require('../src/services/socketService');
const { audit } = require('../src/services/audit');

const adminRouter = require('../src/routes/admin');
const authRouter = require('../src/routes/auth');
const whatsappRouter = require('../src/routes/whatsapp');

function buildApp(basePath, router) {
  const app = express();
  app.use(express.json({ verify: (_req, _res, buf) => { _req.rawBody = buf; } }));
  app.use(basePath, router);
  return app;
}

function resetCoreMocks() {
  db.findTenantBySlug.mockResolvedValue({ id: 'tenant-1', slug: 'acme' });
  db.listMensajesBySolicitud.mockResolvedValue({
    solicitud: { id: 10, estado: 'open' },
    data: [{ id: 1, direccion: 'entrada', status: 'delivered' }],
    total: 1,
    page: 1,
    limit: 50,
  });
  db.getSolicitudMessagingContext.mockResolvedValue({
    id: 10,
    userId: 42,
    agenteId: 7,
    user: { phone: '593999111222' },
    conversationId: 'conv-1',
  });
  db.getWaCredentials.mockResolvedValue({ phoneNumberId: 'pn-1', accessToken: 'wa-token' });
  db.saveMensaje.mockResolvedValue({ id: 99, waMsgId: 'wamid.123', status: 'sent' });

  db.findTenantByWaPhoneNumberId.mockResolvedValue({ id: 'tenant-1' });
  db.updateMensajeDeliveryStatusByWaMsgId.mockResolvedValue({ id: 99, status: 'delivered' });

  wa.sendTextMessage.mockResolvedValue({ messages: [{ id: 'wamid.123' }] });
}

async function waitForExpectation(check, attempts = 12, waitMs = 20) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      check();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentAdmin = { adminUserId: 100, email: 'admin@test.local', tenantId: 'tenant-1', superAdmin: false };
  mockCurrentAgent = { agenteId: 7, tenantId: 'tenant-1', nombre: 'Agente Uno', email: 'agente@test.local' };
  resetCoreMocks();
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

describe('Solicitud messaging integration - admin endpoints', () => {
  const app = buildApp('/admin', adminRouter);

  test('GET messages returns standardized envelope and forwards filters', async () => {
    const res = await request(app)
      .get('/admin/tenants/acme/solicitudes/10/messages')
      .query({ q: 'hola', direccion: 'entrada', start: '2026-05-01', end: '2026-05-09', lectura: 'no_leido' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toEqual({ page: 1, limit: 50, total: 1 });

    expect(db.listMensajesBySolicitud).toHaveBeenCalledWith(expect.objectContaining({
      solicitudId: 10,
      tenantId: 'tenant-1',
      q: 'hola',
      direccion: 'entrada',
      start: '2026-05-01',
      end: '2026-05-09',
      lectura: 'no_leido',
    }));
  });

  test('POST send returns envelope + legacy fields and emits socket/audit', async () => {
    const res = await request(app)
      .post('/admin/tenants/acme/solicitudes/10/messages')
      .send({ text: 'Mensaje desde CRM', replyToMensajeId: 1 });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual(expect.objectContaining({ solicitudId: 10 }));
    expect(res.body).toEqual(expect.objectContaining({ solicitudId: 10 }));

    expect(wa.sendTextMessage).toHaveBeenCalledWith('pn-1', '593999111222', 'Mensaje desde CRM', 'wa-token');
    expect(db.saveMensaje).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      userId: 42,
      agenteId: 7,
      status: 'sent',
      replyToMensajeId: 1,
    }));
    expect(socketService.emit).toHaveBeenCalledWith('tenant-1', 'SOLICITUD_MESSAGE_SENT', expect.objectContaining({ solicitudId: 10 }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ accion: 'SEND_SOLICITUD_MESSAGE', entidadId: '10' }));
  });
});

describe('Solicitud messaging integration - agent endpoints', () => {
  const app = buildApp('/auth', authRouter);

  test('GET agent messages enforces ownership and returns standardized envelope', async () => {
    db.getSolicitudMessagingContext.mockResolvedValueOnce({ id: 10, agenteId: 7, user: { phone: '593999111222' }, userId: 42, conversationId: 'conv-1' });

    const res = await request(app)
      .get('/auth/agent/solicitudes/10/messages')
      .query({ q: 'seguimiento' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.meta).toEqual({ page: 1, limit: 50, total: 1 });
    expect(db.listMensajesBySolicitud).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', solicitudId: 10, q: 'seguimiento' }));
  });

  test('GET agent messages rejects cross-agent access with 403', async () => {
    db.getSolicitudMessagingContext.mockResolvedValueOnce({ id: 10, agenteId: 99, user: { phone: '593999111222' }, userId: 42, conversationId: 'conv-1' });

    const res = await request(app).get('/auth/agent/solicitudes/10/messages');

    expect(res.status).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ error: 'Solicitud is not assigned to this agent' }));
  });

  test('POST agent send returns envelope and emits SOLICITUD_MESSAGE_SENT', async () => {
    const res = await request(app)
      .post('/auth/agent/solicitudes/10/messages')
      .send({ text: 'Mensaje desde agente' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual(expect.objectContaining({ solicitudId: 10 }));

    expect(db.saveMensaje).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      agenteId: 7,
      status: 'sent',
    }));
    expect(socketService.emit).toHaveBeenCalledWith('tenant-1', 'SOLICITUD_MESSAGE_SENT', expect.objectContaining({ solicitudId: 10 }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ accion: 'AGENT_SEND_SOLICITUD_MESSAGE', entidadId: '10' }));
  });
});

describe('WhatsApp status bridge integration', () => {
  const app = buildApp('/whatsapp', whatsappRouter);

  test('POST webhook status update maps delivery status and emits socket event', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1' },
                statuses: [
                  { id: 'wamid.123', status: 'delivered', timestamp: '1710000000' },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await request(app)
      .post('/whatsapp')
      .send(payload);

    expect(res.status).toBe(200);

    await waitForExpectation(() => {
      expect(db.updateMensajeDeliveryStatusByWaMsgId).toHaveBeenCalledWith('wamid.123', 'delivered');
      expect(socketService.emit).toHaveBeenCalledWith('tenant-1', 'SOLICITUD_MESSAGE_STATUS', expect.objectContaining({ waMsgId: 'wamid.123', status: 'delivered' }));
    });
  });
});
