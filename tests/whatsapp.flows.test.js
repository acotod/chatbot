const crypto = require('crypto');
const request = require('supertest');

const TEST_TENANT = { id: 'aaaaaaaa-0000-0000-0000-000000000001', activo: true };
const ORIGINAL_WA_APP_SECRET = process.env.WA_APP_SECRET;
const ORIGINAL_FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;

process.env.WA_APP_SECRET = '';
process.env.FACEBOOK_APP_SECRET = '';

jest.mock('../src/middleware/resolveTenant', () => {
  const middleware = (req, _res, next) => {
    req.tenant = TEST_TENANT;
    next();
  };
  middleware.resolveTenantByKey = middleware;
  return middleware;
});

jest.mock('../src/middleware/rateLimiter', () => () => (_req, _res, next) => next());
jest.mock('../src/middleware/requireJwt', () => () => (_req, _res, next) => next());

jest.mock('../src/services/database', () => ({
  findTenantByApiKey: jest.fn().mockResolvedValue(TEST_TENANT),
  findTenantBySlug: jest.fn().mockResolvedValue(TEST_TENANT),
  findTenantByFlowToken: jest.fn().mockResolvedValue(TEST_TENANT),
  findTenantByWaPhoneNumberId: jest.fn().mockResolvedValue(TEST_TENANT),
  findOrCreateUser: jest.fn().mockResolvedValue({ id: 1, phone: '1234567890' }),
  saveEvent: jest.fn().mockResolvedValue({}),
  saveSolicitud: jest.fn().mockResolvedValue({}),
  getConfig: jest.fn().mockImplementation(async (_tenantId, key) => {
    if (key === 'flow_navigation') return { valor: null };
    if (key === 'screen_templates') {
      return {
        valor: {
          INICIO: { welcome: 'hola' },
          ESTRES: { title: 'estres' },
        },
      };
    }
    return null;
  }),
  getPrismaClient: jest.fn(() => ({
    configuracion: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    flowVersion: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  })),
}));

jest.mock('../src/services/socketService', () => ({
  emit: jest.fn(),
  emitToAdmin: jest.fn(),
  getIo: jest.fn(),
}));

jest.mock('../src/services/whatsapp', () => ({
  sendMessage: jest.fn(),
}));

jest.mock('../src/services/chatbotRouter', () => jest.fn());
jest.mock('../src/services/redis', () => ({ getRedisClient: jest.fn(() => null) }));
jest.mock('../src/services/eventGateway', () => ({ ingestEvent: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/crmSync', () => ({ touch: jest.fn(() => Promise.resolve()) }));

const app = require('../src/app');
const db = require('../src/services/database');

function encryptFlowRequest(payload, publicKeyPem) {
  const aesKeyBuffer = crypto.randomBytes(16);
  const initialVectorBuffer = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKeyBuffer, initialVectorBuffer);
  const encryptedBody = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');

  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKeyBuffer,
  ).toString('base64');

  return {
    body: {
      encrypted_flow_data: encryptedBody,
      encrypted_aes_key: encryptedAesKey,
      initial_vector: initialVectorBuffer.toString('base64'),
    },
    aesKeyBuffer,
    initialVectorBuffer,
  };
}

function decryptFlowResponse(base64Response, aesKeyBuffer, initialVectorBuffer) {
  const encryptedResponseBuffer = Buffer.from(base64Response, 'base64');
  const authTagLength = 16;
  const encryptedPayload = encryptedResponseBuffer.subarray(0, -authTagLength);
  const authTag = encryptedResponseBuffer.subarray(-authTagLength);
  const flippedInitialVector = Buffer.from(initialVectorBuffer.map((byte) => byte ^ 0xff));

  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, flippedInitialVector);
  decipher.setAuthTag(authTag);

  return JSON.parse(Buffer.concat([
    decipher.update(encryptedPayload),
    decipher.final(),
  ]).toString('utf8'));
}

describe('POST /whatsapp/flows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WA_FLOW_PRIVATE_KEY;
    delete process.env.FLOW_PRIVATE_KEY;
    delete process.env.PRIVATE_KEY;
  });

  afterAll(() => {
    if (ORIGINAL_WA_APP_SECRET === undefined) {
      delete process.env.WA_APP_SECRET;
    } else {
      process.env.WA_APP_SECRET = ORIGINAL_WA_APP_SECRET;
    }

    if (ORIGINAL_FACEBOOK_APP_SECRET === undefined) {
      delete process.env.FACEBOOK_APP_SECRET;
    } else {
      process.env.FACEBOOK_APP_SECRET = ORIGINAL_FACEBOOK_APP_SECRET;
    }
  });

  test('keeps plain JSON flow navigation working', async () => {
    const res = await request(app)
      .post('/whatsapp/flows')
      .send({
        flow_token: 'flow-token-1',
        action: 'data_exchange',
        screen: 'INICIO',
        data: { opcion_inicio: 'estres' },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screen: 'ESTRES', data: { title: 'estres' } });
    expect(db.saveEvent).toHaveBeenCalledWith(
      null,
      'INICIO',
      {
        opcion_inicio: 'estres',
        __meta_action: 'data_exchange',
        __meta_screen: 'INICIO',
      },
      TEST_TENANT.id,
    );
  });

  test('decrypts encrypted INIT requests and encrypts the response', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    process.env.WA_FLOW_PRIVATE_KEY = privateKey;

    const { body, aesKeyBuffer, initialVectorBuffer } = encryptFlowRequest(
      { flow_token: 'flow-token-2', action: 'INIT', data: {} },
      publicKey,
    );

    const res = await request(app)
      .post('/whatsapp/flows')
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(typeof res.text).toBe('string');

    const decrypted = decryptFlowResponse(res.text, aesKeyBuffer, initialVectorBuffer);
    expect(decrypted).toEqual({ screen: 'INICIO', data: { welcome: 'hola' } });
  });

  test('responds to ping health checks without requiring flow_token', async () => {
    const res = await request(app)
      .post('/whatsapp/flows')
      .send({ version: '3.0', action: 'ping' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'active' } });
  });

  test('falls back to the published flow definition when legacy flow config is absent', async () => {
    db.getConfig.mockImplementation(async (_tenantId, key) => {
      if (key === 'flow_navigation') return null;
      if (key === 'screen_templates') return null;
      return null;
    });
    db.getPrismaClient.mockReturnValue({
      configuracion: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      flowVersion: {
        findFirst: jest.fn().mockResolvedValue({
          definition: {
            entry_point: 'node_1',
            nodes: [
              {
                id: 'node_1',
                type: 'menu',
                next: null,
                config: {
                  text: 'Hola desde published flow',
                  options: [{ id: 'opt_1', title: 'Proceder' }],
                  variable: 'variables.opcion_menu',
                },
                branches: { opt_1: 'node_2' },
              },
              {
                id: 'node_2',
                type: 'message',
                next: null,
                config: { text: 'Pantalla siguiente' },
              },
            ],
          },
        }),
      },
    });

    const initRes = await request(app)
      .post('/whatsapp/flows?tenantSlug=global-med')
      .send({ action: 'INIT', data: {} });

    expect(initRes.status).toBe(200);
    expect(initRes.body).toEqual({
      screen: 'node_1',
      data: {
        text: 'Hola desde published flow',
        title: '',
        options: [{ id: 'opt_1', title: 'Proceder' }],
      },
    });

    const nextRes = await request(app)
      .post('/whatsapp/flows?tenantSlug=global-med')
      .send({ action: 'data_exchange', screen: 'node_1', data: { opcion_menu: 'opt_1' } });

    expect(nextRes.status).toBe(200);
    expect(nextRes.body).toEqual({
      screen: 'node_2',
      data: {
        text: 'Pantalla siguiente',
        title: '',
        options: [],
      },
    });
  });
});