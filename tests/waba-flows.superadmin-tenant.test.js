const express = require('express');
const request = require('supertest');

const mockPrisma = {
  tenant: {
    findUnique: jest.fn(),
  },
  flow: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  },
  flowVersion: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  },
  configuracion: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
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

  test('returns the designated flow for the explicitly resolved tenant', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1' });
    mockPrisma.configuracion.findUnique.mockResolvedValue({ valor: { flowId: 3 } });
    mockPrisma.flow.findFirst.mockResolvedValue({ id: 3, nombre: 'Recordatorio Cita', activo: true });

    const res = await request(createApp())
      .get('/waba-flows/outbound-reminder-flow')
      .query({ tenantSlug: 'global-med' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flowId: 3, flow: { id: 3, nombre: 'Recordatorio Cita', activo: true } });
    expect(mockPrisma.configuracion.findUnique).toHaveBeenCalledWith({
      where: { tenantId_clave: { tenantId: 'tenant-1', clave: 'outbound_reminder_flow_id' } },
      select: { valor: true },
    });
    expect(mockPrisma.flow.findFirst).toHaveBeenCalledWith({
      where: { id: 3, tenantId: 'tenant-1' },
      select: { id: true, nombre: true, activo: true },
    });
  });

  test('rejects designating a flow without a published outbound recipient rule', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1' });
    mockPrisma.flow.findFirst.mockResolvedValue({ id: 3, nombre: 'Recordatorio Cita' });
    mockPrisma.flowVersion.findFirst.mockResolvedValue({
      versionNumber: 3,
      definition: { metadata: { flow_mode: 'inbound', outbound_rules: [] } },
    });

    const res = await request(createApp())
      .put('/waba-flows/outbound-reminder-flow')
      .send({ tenantSlug: 'global-med', flowId: 3 });

    expect(res.status).toBe(400);
    expect(mockPrisma.configuracion.upsert).not.toHaveBeenCalled();
  });

  test('stores a valid flow selection under the resolved tenant config key', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1' });
    mockPrisma.flow.findFirst.mockResolvedValue({ id: 3, nombre: 'Recordatorio Cita' });
    mockPrisma.flowVersion.findFirst.mockResolvedValue({
      versionNumber: 4,
      definition: {
        metadata: {
          flow_mode: 'outbound',
          outbound_rules: [{ enabled: true, recipients: ['agent'] }],
        },
      },
    });
    mockPrisma.configuracion.upsert.mockResolvedValue({});

    const res = await request(createApp())
      .put('/waba-flows/outbound-reminder-flow')
      .send({ tenantSlug: 'global-med', flowId: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flowId: 3, flow: { id: 3, nombre: 'Recordatorio Cita' }, versionNumber: 4 });
    expect(mockPrisma.configuracion.upsert).toHaveBeenCalledWith({
      where: { tenantId_clave: { tenantId: 'tenant-1', clave: 'outbound_reminder_flow_id' } },
      update: { valor: { flowId: 3 } },
      create: { tenantId: 'tenant-1', clave: 'outbound_reminder_flow_id', valor: { flowId: 3 } },
    });
  });

  test('clears the designation only for the resolved tenant', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1' });
    mockPrisma.configuracion.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .put('/waba-flows/outbound-reminder-flow')
      .send({ tenantSlug: 'global-med', flowId: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.configuracion.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', clave: 'outbound_reminder_flow_id' },
    });
  });
});