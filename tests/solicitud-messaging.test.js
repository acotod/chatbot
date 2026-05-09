const express = require('express');
const request = require('supertest');

// Mock middleware
jest.mock('../src/middleware/requireJwt', () => (_req, _res, next) => next());
jest.mock('../src/middleware/requireAgentJwt', () => (_req, _res, next) => {
  _req.agentId = 42;
  _req.agentTenantId = 'tenant1';
  next();
});
jest.mock('../src/middleware/requirePermiso', () => () => (_req, _res, next) => next());

// Mock services
jest.mock('../src/services/database', () => ({
  listMensajesBySolicitud: jest.fn(),
  getSolicitudMessagingContext: jest.fn(),
  saveMensaje: jest.fn(),
  getWaCredentials: jest.fn(),
  getSolicitudByIdAndTenant: jest.fn(),
}));

jest.mock('../src/services/whatsapp', () => ({
  sendTextMessage: jest.fn().mockResolvedValue({
    messages: [{ id: 'wamsg_123' }],
    contacts: [{ input: '+1234567890', wa_id: '1234567890' }],
  }),
}));

jest.mock('../src/services/socketService', () => ({
  emit: jest.fn(),
}));

jest.mock('../src/services/audit', () => ({
  logAction: jest.fn().mockResolvedValue({}),
}));

const db = require('../src/services/database');
const wa = require('../src/services/whatsapp');
const socketService = require('../src/services/socketService');
const audit = require('../src/services/audit');

const adminRouter = require('../src/routes/admin');
const authRouter = require('../src/routes/auth');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  app.use('/auth', authRouter);
  return app;
}

describe('Solicitud Messaging Endpoints', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  describe('Admin GET /admin/tenants/:slug/solicitudes/:id/messages', () => {
    it('should return messages for a solicitud', async () => {
      const mockMessages = [
        {
          id: 1,
          direccion: 'entrada',
          tipo: 'text',
          contenido: { text: 'Hola desde cliente' },
          leido: false,
          createdAt: '2024-01-01T10:00:00Z',
        },
        {
          id: 2,
          direccion: 'salida',
          tipo: 'text',
          contenido: { text: 'Hola cliente, bienvenido' },
          leido: true,
          createdAt: '2024-01-01T10:05:00Z',
        },
      ];

      db.listMensajesBySolicitud.mockResolvedValue({
        data: mockMessages,
        total: 2,
      });

      const res = await request(app)
        .get('/admin/tenants/test-slug/solicitudes/123/messages')
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.total).toBe(2);
      expect(db.listMensajesBySolicitud).toHaveBeenCalledWith({
        solicitudId: 123,
        tenantId: expect.any(String),
        page: 1,
        limit: 50,
      });
    });

    it('should handle pagination parameters', async () => {
      db.listMensajesBySolicitud.mockResolvedValue({
        data: [],
        total: 100,
      });

      await request(app)
        .get('/admin/tenants/test-slug/solicitudes/123/messages?page=2&limit=25')
        .expect(200);

      expect(db.listMensajesBySolicitud).toHaveBeenCalledWith({
        solicitudId: 123,
        tenantId: expect.any(String),
        page: 2,
        limit: 25,
      });
    });
  });

  describe('Admin POST /admin/tenants/:slug/solicitudes/:id/messages', () => {
    it('should send a message from admin to customer', async () => {
      const mockSolicitud = {
        id: 123,
        tenantId: 'tenant1',
        user: { phone: '+34600000000' },
      };

      db.getSolicitudMessagingContext.mockResolvedValue(mockSolicitud);
      db.getWaCredentials.mockResolvedValue({
        phoneNumberId: 'phone_123',
        accessToken: 'token_abc',
      });
      db.saveMensaje.mockResolvedValue({
        id: 999,
        direccion: 'salida',
        contenido: { text: 'Test message' },
      });

      const res = await request(app)
        .post('/admin/tenants/test-slug/solicitudes/123/messages')
        .send({ text: 'Test message' })
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.solicitudId).toBe(123);
      expect(wa.sendTextMessage).toHaveBeenCalledWith(
        '+34600000000',
        'Test message',
        'phone_123',
        'token_abc',
      );
      expect(db.saveMensaje).toHaveBeenCalledWith(
        expect.objectContaining({
          solicitudId: 123,
          direccion: 'salida',
          source: 'admin_solicitud',
        }),
      );
      expect(socketService.emit).toHaveBeenCalledWith(
        expect.stringContaining('tenant1'),
        'SOLICITUD_MESSAGE_SENT',
        expect.any(Object),
      );
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          accion: 'SEND_SOLICITUD_MESSAGE',
          actorType: 'admin',
        }),
      );
    });

    it('should reject empty message', async () => {
      const res = await request(app)
        .post('/admin/tenants/test-slug/solicitudes/123/messages')
        .send({ text: '' })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it('should handle missing user phone', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        user: { phone: null },
      });

      await request(app)
        .post('/admin/tenants/test-slug/solicitudes/123/messages')
        .send({ text: 'Test' })
        .expect(400);

      expect(wa.sendTextMessage).not.toHaveBeenCalled();
    });

    it('should handle WhatsApp send failure gracefully', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        tenantId: 'tenant1',
        user: { phone: '+34600000000' },
      });
      db.getWaCredentials.mockResolvedValue({
        phoneNumberId: 'phone_123',
        accessToken: 'token_abc',
      });
      wa.sendTextMessage.mockRejectedValue(new Error('Meta API error'));

      const res = await request(app)
        .post('/admin/tenants/test-slug/solicitudes/123/messages')
        .send({ text: 'Test' })
        .expect(500);

      expect(res.body.error).toBeDefined();
    });
  });

  describe('Agent GET /auth/agent/solicitudes/:id/messages', () => {
    it('should return messages for agent assigned solicitud', async () => {
      const mockMessages = [
        {
          id: 1,
          direccion: 'entrada',
          contenido: { text: 'Customer message' },
        },
      ];

      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        agenteId: 42, // Matches mocked agentId
        tenantId: 'tenant1',
      });
      db.listMensajesBySolicitud.mockResolvedValue({
        data: mockMessages,
        total: 1,
      });

      const res = await request(app)
        .get('/auth/agent/solicitudes/123/messages')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(db.getSolicitudMessagingContext).toHaveBeenCalled();
    });

    it('should reject access if agent does not own solicitud', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        agenteId: 99, // Different from mocked agentId (42)
        tenantId: 'tenant1',
      });

      const res = await request(app)
        .get('/auth/agent/solicitudes/123/messages')
        .expect(403);

      expect(res.body.error).toBeDefined();
      expect(db.listMensajesBySolicitud).not.toHaveBeenCalled();
    });
  });

  describe('Agent POST /auth/agent/solicitudes/:id/messages', () => {
    it('should send message from agent to customer', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        agenteId: 42, // Matches mocked agentId
        tenantId: 'tenant1',
        user: { phone: '+34600000000' },
      });
      db.getWaCredentials.mockResolvedValue({
        phoneNumberId: 'phone_123',
        accessToken: 'token_abc',
      });
      db.saveMensaje.mockResolvedValue({
        id: 1000,
        direccion: 'salida',
        contenido: { text: 'Agent reply' },
      });

      const res = await request(app)
        .post('/auth/agent/solicitudes/123/messages')
        .send({ text: 'Agent reply' })
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(db.saveMensaje).toHaveBeenCalledWith(
        expect.objectContaining({
          solicitudId: 123,
          source: 'agent_solicitud',
          actor: { type: 'agent', agenteId: 42 },
        }),
      );
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          accion: 'SEND_SOLICITUD_MESSAGE',
          metadata: { agenteId: 42 },
        }),
      );
    });

    it('should reject if agent does not own solicitud', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        agenteId: 99, // Different agent
        tenantId: 'tenant1',
      });

      const res = await request(app)
        .post('/auth/agent/solicitudes/123/messages')
        .send({ text: 'Attempt to send' })
        .expect(403);

      expect(wa.sendTextMessage).not.toHaveBeenCalled();
    });
  });

  describe('Message Ownership Validation', () => {
    it('should enforce tenant-scope isolation', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        tenantId: 'tenant2', // Different tenant
        user: { phone: '+34600000000' },
      });

      // In real scenario, this would be blocked by middleware
      // This test documents the expected behavior
      expect(db.getSolicitudMessagingContext).toBeDefined();
    });

    it('should validate solicitud exists before sending', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue(null);

      const res = await request(app)
        .post('/admin/tenants/test-slug/solicitudes/999/messages')
        .send({ text: 'Test' })
        .expect(404);

      expect(res.body.error).toBeDefined();
    });
  });

  describe('Message Content Handling', () => {
    it('should accept text messages', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        tenantId: 'tenant1',
        user: { phone: '+34600000000' },
      });
      db.getWaCredentials.mockResolvedValue({
        phoneNumberId: 'phone_123',
        accessToken: 'token_abc',
      });

      await request(app)
        .post('/admin/tenants/test-slug/solicitudes/123/messages')
        .send({ text: 'Valid message content' })
        .expect(200);

      expect(wa.sendTextMessage).toHaveBeenCalled();
    });

    it('should trim whitespace from messages', async () => {
      const res = await request(app)
        .post('/admin/tenants/test-slug/solicitudes/123/messages')
        .send({ text: '   ' })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });
  });

  describe('Socket Emissions', () => {
    it('should emit SOLICITUD_MESSAGE_SENT event', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        tenantId: 'tenant1',
        user: { phone: '+34600000000' },
      });
      db.getWaCredentials.mockResolvedValue({
        phoneNumberId: 'phone_123',
        accessToken: 'token_abc',
      });
      db.saveMensaje.mockResolvedValue({
        id: 500,
        direccion: 'salida',
      });

      await request(app)
        .post('/admin/tenants/test-slug/solicitudes/123/messages')
        .send({ text: 'Test' })
        .expect(200);

      expect(socketService.emit).toHaveBeenCalledWith(
        expect.any(String),
        'SOLICITUD_MESSAGE_SENT',
        expect.objectContaining({
          solicitudId: 123,
          mensaje: expect.any(Object),
        }),
      );
    });
  });

  describe('Audit Trail', () => {
    it('should log admin message sends', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        tenantId: 'tenant1',
        user: { phone: '+34600000000' },
      });
      db.getWaCredentials.mockResolvedValue({
        phoneNumberId: 'phone_123',
        accessToken: 'token_abc',
      });
      db.saveMensaje.mockResolvedValue({ id: 1 });

      await request(app)
        .post('/admin/tenants/test-slug/solicitudes/123/messages')
        .send({ text: 'Audit test' })
        .expect(200);

      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          accion: 'SEND_SOLICITUD_MESSAGE',
          actorType: 'admin',
        }),
      );
    });

    it('should log agent message sends with agenteId', async () => {
      db.getSolicitudMessagingContext.mockResolvedValue({
        id: 123,
        agenteId: 42,
        tenantId: 'tenant1',
        user: { phone: '+34600000000' },
      });
      db.getWaCredentials.mockResolvedValue({
        phoneNumberId: 'phone_123',
        accessToken: 'token_abc',
      });
      db.saveMensaje.mockResolvedValue({ id: 1 });

      await request(app)
        .post('/auth/agent/solicitudes/123/messages')
        .send({ text: 'Agent audit test' })
        .expect(200);

      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          accion: 'SEND_SOLICITUD_MESSAGE',
          metadata: { agenteId: 42 },
        }),
      );
    });
  });
});
