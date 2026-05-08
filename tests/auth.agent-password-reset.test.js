const express = require('express');
const request = require('supertest');

const mockPrisma = {
  agente: {
    findFirst: jest.fn(),
  },
  agentPasswordReset: {
    updateMany: jest.fn(),
    create: jest.fn(),
  },
};

const mockDb = {
  getEmailSettings: jest.fn(),
  getWaCredentials: jest.fn(),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/services/audit', () => ({
  audit: jest.fn(),
}));

jest.mock('../src/services/database', () => mockDb);

jest.mock('../src/services/redis', () => ({
  getRedisClient: jest.fn(() => null),
}));

jest.mock('../src/services/whatsapp', () => ({
  sendTextMessage: jest.fn(),
}));

jest.mock('../src/services/emailService', () => ({
  EmailServiceError: class EmailServiceError extends Error {
    constructor(message, code = 'EMAIL_SEND_FAILED') {
      super(message);
      this.code = code;
    }
  },
  sendEmail: jest.fn().mockResolvedValue({ ok: true, messageId: 'msg-reset-1' }),
}));

const authRouter = require('../src/routes/auth');
const { audit } = require('../src/services/audit');
const { sendEmail } = require('../src/services/emailService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  return app;
}

describe('POST /auth/agent/forgot-password', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      ADMIN_BASE_URL: 'https://admin.example.com',
      NODE_ENV: 'test',
    };

    mockDb.getEmailSettings.mockResolvedValue({
      smtpUrl: '',
      smtpHost: '',
      smtpPort: '',
      smtpSecure: false,
      smtpUser: '',
      smtpPass: '',
      emailFrom: 'noreply@example.com',
      adminBaseUrl: 'https://tenant-admin.example.com',
    });
    mockDb.getWaCredentials.mockResolvedValue({ phoneNumberId: '', accessToken: '' });

    mockPrisma.agente.findFirst.mockResolvedValue({
      id: 11,
      tenantId: 'tenant-1',
      nombre: 'Ana',
      email: 'agente@example.com',
      estado: 'activo',
      passwordHash: 'hash-123',
      tenant: { id: 'tenant-1', slug: 'demo', nombre: 'Tenant Demo' },
      puesto: null,
    });
    mockPrisma.agentPasswordReset.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.agentPasswordReset.create.mockResolvedValue({ id: 99 });
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('creates a reset token and sends an email', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/auth/agent/forgot-password')
      .send({ tenantSlug: 'demo', email: 'AGENTE@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/se generó un enlace de recuperación/i);
    expect(res.body.resetUrl).toMatch(/^https:\/\/tenant-admin\.example\.com\/agente\/reset-password\?token=/);
    expect(typeof res.body.resetToken).toBe('string');
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'agente@example.com',
      tenantId: 'tenant-1',
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      accion: 'PASSWORD_RESET_REQUEST',
      metadata: expect.objectContaining({ delivered: true }),
    }));
  });
});