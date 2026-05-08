const express = require('express');
const request = require('supertest');

jest.mock('../src/services/emailService', () => ({
  EmailServiceError: class EmailServiceError extends Error {
    constructor(message, code = 'EMAIL_SEND_FAILED') {
      super(message);
      this.code = code;
    }
  },
  sendEmail: jest.fn(),
}));

const notificationsRouter = require('../src/routes/notifications');
const { sendEmail } = require('../src/services/emailService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenant = { id: 'tenant-1' };
    next();
  });
  app.use('/api/notifications', notificationsRouter);
  return app;
}

describe('POST /api/notifications/send', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends an email notification', async () => {
    sendEmail.mockResolvedValue({
      ok: true,
      messageId: 'msg-123',
      accepted: ['destinatario@example.com'],
      rejected: [],
    });

    const app = createApp();
    const res = await request(app)
      .post('/api/notifications/send')
      .send({
        canal: 'email',
        to: 'destinatario@example.com',
        subject: 'Prueba de envio',
        message: 'Hola desde el flujo',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enviado: true,
      notifId: 'msg-123',
      accepted: ['destinatario@example.com'],
      rejected: [],
    });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'destinatario@example.com',
      subject: 'Prueba de envio',
      text: 'Hola desde el flujo',
      tenantId: 'tenant-1',
    }));
  });
});