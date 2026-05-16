const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const mockPrisma = {
  adminUser: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  refreshToken: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/services/audit', () => ({
  audit: jest.fn(),
}));

jest.mock('../src/services/redis', () => ({
  getRedisClient: jest.fn(() => null),
}));

const authRouter = require('../src/routes/auth');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  return app;
}

describe('POST /auth/facebook', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      JWT_SECRET: '12345678901234567890123456789012',
      FACEBOOK_APP_ID: '4224350961162585',
      FACEBOOK_APP_SECRET: 'test-app-secret',
      FACEBOOK_GRAPH_VERSION: 'v25.0',
    };

    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('returns 400 when accessToken is missing', async () => {
    const app = createApp();
    const res = await request(app).post('/auth/facebook').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'accessToken is required' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns JWT tokens when Facebook token is valid and email is linked', async () => {
    const app = createApp();

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { is_valid: true, app_id: '4224350961162585' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [
          { permission: 'email', status: 'granted' },
          { permission: 'public_profile', status: 'granted' },
          { permission: 'whatsapp_business_management', status: 'granted' },
        ] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'biz-1', name: 'PMC Test Business' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'fb-user-1', email: 'admin@example.com', name: 'Admin FB' }),
      });

    mockPrisma.adminUser.findFirst.mockResolvedValue({
      id: 7,
      tenantId: 'aaaaaaaa-0000-0000-0000-000000000001',
      email: 'admin@example.com',
      superAdmin: false,
      lockedUntil: null,
    });

    mockPrisma.adminUser.update.mockResolvedValue({});
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 1 });

    const res = await request(app)
      .post('/auth/facebook')
      .send({ accessToken: 'valid-facebook-token' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    expect(res.body).toHaveProperty('expiresIn');

    const payload = jwt.verify(res.body.accessToken, process.env.JWT_SECRET);
    expect(payload.adminUserId).toBe(7);
    expect(payload.email).toBe('admin@example.com');

    expect(mockPrisma.refreshToken.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.adminUser.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  });

  test('returns 403 when facebook email is not linked to an admin user', async () => {
    const app = createApp();

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { is_valid: true, app_id: '4224350961162585' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [
          { permission: 'email', status: 'granted' },
          { permission: 'public_profile', status: 'granted' },
          { permission: 'whatsapp_business_management', status: 'granted' },
        ] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'biz-2', name: 'Unlinked Business' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'fb-user-2', email: 'no-user@example.com' }),
      });

    mockPrisma.adminUser.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/auth/facebook')
      .send({ accessToken: 'valid-facebook-token' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'No admin account is linked to this Facebook email' });
  });

  test('returns 403 when whatsapp_business_management permission is missing', async () => {
    const app = createApp();

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { is_valid: true, app_id: '4224350961162585' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [
          { permission: 'email', status: 'granted' },
          { permission: 'public_profile', status: 'granted' },
        ] }),
      });

    const res = await request(app)
      .post('/auth/facebook')
      .send({ accessToken: 'valid-facebook-token' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Missing whatsapp_business_management permission' });
  });
});
