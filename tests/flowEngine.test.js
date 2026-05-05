'use strict';

jest.mock('@prisma/client', () => {
  const flowVariable = { findMany: jest.fn() };
  return {
    PrismaClient: jest.fn(() => ({ flowVariable })),
    __mock: { flowVariable },
  };
});

jest.mock('../src/engine/flowLoader', () => ({
  loadFlowDefinition: jest.fn(),
}));

jest.mock('../src/engine/nodeExecutors', () => ({
  executeNode: jest.fn(),
}));

jest.mock('../src/engine/contextStore', () => ({
  getState: jest.fn(),
  saveState: jest.fn(),
  appendLog: jest.fn(),
}));

jest.mock('../src/engine/integrationRunner', () => ({
  run: jest.fn(),
}));

jest.mock('../src/engine/conversationLogger', () => ({
  getOrCreate: jest.fn(),
  log: jest.fn(),
  end: jest.fn(),
  updateContext: jest.fn(),
  EVENT: {
    FLOW_START: 'FLOW_START',
    MESSAGE_SENT: 'MESSAGE_SENT',
    USER_INPUT: 'USER_INPUT',
    MENU_SELECTION: 'MENU_SELECTION',
    CONDITION_EVAL: 'CONDITION_EVAL',
    API_CALL: 'API_CALL',
    TASK_CREATED: 'TASK_CREATED',
    TASK_WAITING: 'TASK_WAITING',
    TASK_COMPLETED: 'TASK_COMPLETED',
    LLM_CALL: 'LLM_CALL',
    FLOW_END: 'FLOW_END',
    FLOW_HANDOFF: 'FLOW_HANDOFF',
    CALENDAR_AVAILABILITY_SHOWN: 'CALENDAR_AVAILABILITY_SHOWN',
    CALENDAR_SLOT_SELECTED: 'CALENDAR_SLOT_SELECTED',
    APPOINTMENT_CREATED: 'APPOINTMENT_CREATED',
    APPOINTMENT_RESCHEDULED: 'APPOINTMENT_RESCHEDULED',
    APPOINTMENT_CANCELLED: 'APPOINTMENT_CANCELLED',
    FLOW_ERROR: 'FLOW_ERROR',
  },
}));

jest.mock('../src/services/database', () => ({
  createOrReuseFlowTask: jest.fn(),
  findTaskForWait: jest.fn(),
}));

jest.mock('../src/services/endpointCatalog', () => ({
  getCatalog: jest.fn(),
}));

jest.mock('../src/services/llmService', () => ({}));

const { __mock } = require('@prisma/client');
const { loadFlowDefinition } = require('../src/engine/flowLoader');
const { executeNode } = require('../src/engine/nodeExecutors');
const contextStore = require('../src/engine/contextStore');
const integrationRunner = require('../src/engine/integrationRunner');
const convLogger = require('../src/engine/conversationLogger');
const { getCatalog } = require('../src/services/endpointCatalog');
const { executeStep } = require('../src/services/flowEngine');

describe('flowEngine bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadFlowDefinition.mockResolvedValue({
      source: 'version',
      flowId: 7,
      versionId: 11,
      entryPoint: 'node_1',
      nodesMap: {
        node_1: { id: 'node_1', type: 'message', config: { text: 'Hola' }, next: null, branches: {} },
      },
      variables: {
        fromDefinition: { default: 'def-value' },
      },
      metadata: {},
    });
    contextStore.getState.mockResolvedValue({
      source: 'execution',
      executionId: null,
      currentNodeRef: null,
      currentNodeId: null,
      variables: {},
    });
    contextStore.saveState.mockResolvedValue({ executionId: 99 });
    __mock.flowVariable.findMany.mockResolvedValue([
      { nombre: 'globalVar', valorDefault: 'global-default', flowId: null },
      { nombre: 'flowVar', valorDefault: 123, flowId: 7 },
    ]);
    getCatalog.mockResolvedValue({
      endpoints: [
        { id: 'getSessionData', name: 'Cargar Datos de Sesión', sessionInit: true },
      ],
    });
    integrationRunner.run.mockResolvedValue({
      responseVars: { clienteId: 'cli_1' },
      rawResponse: { ok: true },
    });
    convLogger.getOrCreate.mockResolvedValue('conv-1');
    executeNode.mockResolvedValue({
      output: { type: 'text', text: 'Hola' },
      nextNodeId: null,
      updatedVars: {},
      terminal: false,
      fallback: false,
    });
  });

  test('hydrates db defaults and session init outputs before first node execution', async () => {
    await executeStep({
      tenantId: 'tenant-1',
      currentNodeId: null,
      input: 'hola',
      userId: 42,
      sessionKey: '58412121212',
    });

    expect(__mock.flowVariable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1' }),
      })
    );
    expect(integrationRunner.run).toHaveBeenCalledWith(
      'tenant-1',
      'getSessionData',
      expect.objectContaining({
        globalVar: 'global-default',
        flowVar: 123,
        fromDefinition: 'def-value',
        telefono: '58412121212',
      })
    );
    expect(executeNode).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'node_1' }),
      expect.objectContaining({
        variables: expect.objectContaining({
          globalVar: 'global-default',
          flowVar: 123,
          fromDefinition: 'def-value',
          clienteId: 'cli_1',
        }),
      })
    );
    expect(contextStore.saveState).toHaveBeenCalledWith(
      'tenant-1',
      42,
      expect.objectContaining({
        variables: expect.objectContaining({
          globalVar: 'global-default',
          flowVar: 123,
          clienteId: 'cli_1',
        }),
      })
    );
  });
});
