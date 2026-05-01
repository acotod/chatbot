'use strict';
/**
 * Tests for src/services/chatbotRouter.js
 */

jest.mock('../src/services/flowEngine', () => ({
  executeStep: jest.fn(),
}));

jest.mock('../src/services/database', () => ({
  getConfig:               jest.fn().mockResolvedValue(null),
  getConversationContext:  jest.fn().mockResolvedValue(null),
  setConversationContext:  jest.fn().mockResolvedValue({}),
  clearConversationContext: jest.fn().mockResolvedValue(undefined),
  findOpenSolicitudForUser: jest.fn().mockResolvedValue(null),
}));

const { routeMessage } = require('../src/services/chatbotRouter');
const { executeStep }  = require('../src/services/flowEngine');
const db               = require('../src/services/database');

const TENANT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID   = 42;

beforeEach(() => {
  jest.clearAllMocks();
  db.getConfig.mockResolvedValue(null);               // motor_config not set → default flow_engine
  db.getConversationContext.mockResolvedValue(null);  // no prior context
});

describe('routeMessage — flow_engine disabled', () => {
  test('returns {response: null, fallbackToHuman: false} when engine is "off"', async () => {
    db.getConfig.mockResolvedValueOnce({ valor: { engine: 'off' } });

    const result = await routeMessage({ tenantId: TENANT_ID, userId: USER_ID, input: 'hello' });

    expect(result).toEqual({ response: null, fallbackToHuman: false });
    expect(executeStep).not.toHaveBeenCalled();
  });
});

describe('routeMessage — no active flow', () => {
  test('returns {response: null, fallbackToHuman: false} when executeStep returns null', async () => {
    executeStep.mockResolvedValue(null);

    const result = await routeMessage({ tenantId: TENANT_ID, userId: USER_ID, input: 'hello' });

    expect(result).toEqual({ response: null, fallbackToHuman: false });
    expect(db.clearConversationContext).toHaveBeenCalledWith(TENANT_ID, USER_ID);
  });
});

describe('routeMessage — text node', () => {
  test('returns text response and updates context', async () => {
    executeStep.mockResolvedValue({
      nodeId:  10,
      content: { type: 'text', text: 'Hola, ¿en qué te ayudo?' },
    });

    const result = await routeMessage({ tenantId: TENANT_ID, userId: USER_ID, input: 'hola' });

    expect(result.fallbackToHuman).toBe(false);
    expect(result.response).toEqual({ type: 'text', text: 'Hola, ¿en qué te ayudo?' });
    expect(db.setConversationContext).toHaveBeenCalledWith(TENANT_ID, USER_ID, { currentNodeId: 10 });
  });
});

describe('routeMessage — buttons node', () => {
  test('returns buttons response', async () => {
    executeStep.mockResolvedValue({
      nodeId:  20,
      content: { type: 'buttons', text: 'Elige:', buttons: [{ id: 'a', title: 'Opción A' }] },
    });

    const result = await routeMessage({ tenantId: TENANT_ID, userId: USER_ID, input: 'start' });

    expect(result.fallbackToHuman).toBe(false);
    expect(result.response.type).toBe('buttons');
    expect(result.response.buttons).toHaveLength(1);
  });
});

describe('routeMessage — handoff node', () => {
  test('returns fallbackToHuman: true and clears context', async () => {
    executeStep.mockResolvedValue({
      nodeId:  99,
      content: { type: 'handoff', text: 'Un agente te atenderá.' },
    });

    const result = await routeMessage({ tenantId: TENANT_ID, userId: USER_ID, input: 'urgente' });

    expect(result.fallbackToHuman).toBe(true);
    expect(result.response.type).toBe('handoff');
    expect(db.clearConversationContext).toHaveBeenCalledWith(TENANT_ID, USER_ID);
    // Should NOT update context to handoff node
    expect(db.setConversationContext).not.toHaveBeenCalled();
  });
});

describe('routeMessage — end node', () => {
  test('returns response with no fallback and clears context', async () => {
    executeStep.mockResolvedValue({
      nodeId:  100,
      content: { type: 'end', text: 'Hasta luego.' },
    });

    const result = await routeMessage({ tenantId: TENANT_ID, userId: USER_ID, input: 'adios' });

    expect(result.fallbackToHuman).toBe(false);
    expect(result.response.type).toBe('end');
    expect(db.clearConversationContext).toHaveBeenCalledWith(TENANT_ID, USER_ID);
  });
});

describe('routeMessage — engine error', () => {
  test('falls back to human on unexpected engine error', async () => {
    executeStep.mockRejectedValue(new Error('DB connection lost'));

    const result = await routeMessage({ tenantId: TENANT_ID, userId: USER_ID, input: 'test' });

    expect(result).toEqual({ response: null, fallbackToHuman: true });
    expect(db.clearConversationContext).toHaveBeenCalled();
  });
});

describe('routeMessage — context continuity', () => {
  test('passes currentNodeId from context to executeStep', async () => {
    db.getConversationContext.mockResolvedValueOnce({ currentNodeId: 5 });
    executeStep.mockResolvedValue({ nodeId: 6, content: { type: 'text', text: 'Next step' } });

    await routeMessage({ tenantId: TENANT_ID, userId: USER_ID, input: 'continue' });

    expect(executeStep).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, currentNodeId: 5, input: 'continue' })
    );
  });
});
