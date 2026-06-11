const express = require('express');
const request = require('supertest');

const mockPrisma = {
  flow: {
    findUnique: jest.fn(),
  },
  flowVersion: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  },
  flowVariable: {
    findMany: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/middleware/requireJwt', () => (req, _res, next) => {
  req.admin = { superAdmin: true };
  next();
});

jest.mock('../src/services/wabaFlowService', () => ({
  validateInternalDefinition: jest.fn(),
  validateWabaJson: jest.fn(),
  importFromWaba: jest.fn(),
  exportToWaba: jest.fn(),
  enrichDefinition: jest.fn(),
  simulateFlow: jest.fn(),
  simulateAllPaths: jest.fn(),
  buildSimulationVerdict: jest.fn(),
}));

jest.mock('../src/engine/conversationLogger', () => ({
  EVENT: {},
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const wabaFlowsRouter = require('../src/routes/waba-flows');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/waba-flows', wabaFlowsRouter);
  return app;
}

describe('waba-flows tenant resolution for super-admins', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('requires tenantSlug instead of inferring tenant from the flow', async () => {
    const app = createApp();

    const res = await request(app).get('/waba-flows/123/versions');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'tenantSlug is required for WABA flows' });
    expect(mockPrisma.flow.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.flowVersion.findMany).not.toHaveBeenCalled();
  });
});