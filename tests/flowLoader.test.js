const mockPrisma = {
  flow: { findFirst: jest.fn() },
  flowVersion: { findFirst: jest.fn() },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { loadFlowDefinition, loadFlowDefinitionForFlow } = require('../src/engine/flowLoader');

describe('flowLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('loads the latest published version only for the designated tenant flow', async () => {
    mockPrisma.flowVersion.findFirst.mockResolvedValue({
      flow: { id: 3 },
      definition: {
        entry_point: 'reminder-start',
        nodes: [{ id: 'reminder-start', type: 'start', config: {}, next: 'reminder-message' }],
        metadata: { flow_mode: 'outbound' },
      },
      versionNumber: 3,
    });

    const result = await loadFlowDefinitionForFlow('tenant-global-med', 3);

    expect(mockPrisma.flowVersion.findFirst).toHaveBeenCalledWith({
      where: {
        flowId: 3,
        published: true,
        flow: { tenantId: 'tenant-global-med', activo: true },
      },
      orderBy: { versionNumber: 'desc' },
      include: { flow: { select: { id: true } } },
    });
    expect(result).toMatchObject({
      flowId: 3,
      versionId: undefined,
      metadata: { flow_mode: 'outbound' },
    });
    expect(result.nodesMap['reminder-start'].next).toBe('reminder-message');
  });

  test('fails closed when the designated flow has no published version', async () => {
    mockPrisma.flowVersion.findFirst.mockResolvedValue(null);

    await expect(loadFlowDefinitionForFlow('tenant-global-med', 3)).resolves.toBeNull();
    expect(mockPrisma.flow.findFirst).not.toHaveBeenCalled();
  });

  test('keeps the existing tenant-level loader behavior for inbound flows', async () => {
    mockPrisma.flowVersion.findFirst.mockResolvedValue({
      flow: { id: 84 },
      definition: {
        entry_point: 'waba-start',
        nodes: [{ id: 'waba-start', type: 'start', config: {}, next: null }],
        metadata: { flow_mode: 'inbound' },
      },
      versionNumber: 84,
    });

    const result = await loadFlowDefinition('tenant-global-med');

    expect(mockPrisma.flowVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { published: true, flow: { tenantId: 'tenant-global-med', activo: true } },
      orderBy: { versionNumber: 'desc' },
    }));
    expect(result.flowId).toBe(84);
  });
});
