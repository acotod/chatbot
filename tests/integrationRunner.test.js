const { EventEmitter } = require('events');

const mockPrisma = {
  integration: {
    findFirst: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/engine/conversationLogger', () => ({
  EVENT: {
    API_CALL: 'API_CALL',
    API_RESPONSE: 'API_RESPONSE',
    FLOW_ERROR: 'FLOW_ERROR',
  },
  log: jest.fn().mockResolvedValue(undefined),
}));

const http = require('http');
const integrationRunner = require('../src/engine/integrationRunner');

describe('integrationRunner internal endpoints', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      PORT: '3000',
    };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('resolves relative endpoints against the local API base', async () => {
    mockPrisma.integration.findFirst.mockResolvedValue({
      id: 9,
      tipo: 'http',
      config: {
        endpoint: '/api/notifications/send',
        method: 'POST',
        body_mapping: { to: '{{email}}' },
        response_mapping: { sent: 'ok' },
      },
    });

    const requestSpy = jest.spyOn(http, 'request').mockImplementation((options, callback) => {
      const response = new EventEmitter();
      callback(response);
      process.nextTick(() => {
        response.emit('data', JSON.stringify({ ok: true }));
        response.emit('end');
      });

      const req = new EventEmitter();
      req.setTimeout = jest.fn();
      req.write = jest.fn();
      req.end = jest.fn();
      return req;
    });

    const result = await integrationRunner.run('tenant-1', 'sendNotification', {
      email: 'destinatario@example.com',
    });

    expect(result.responseVars).toEqual({ sent: true });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const options = requestSpy.mock.calls[0][0];
    expect(options.hostname).toBe('127.0.0.1');
    expect(String(options.port)).toBe('3000');
    expect(options.path).toBe('/api/notifications/send');
  });
});