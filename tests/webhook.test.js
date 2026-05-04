const request = require('supertest');

const TEST_TENANT = { id: 'aaaaaaaa-0000-0000-0000-000000000001', activo: true };
const TEST_API_KEY = 'test-api-key';

// Mock resolveTenant middleware so tests don't hit the DB for tenant lookup
jest.mock('../src/middleware/resolveTenant', () => (req, res, next) => {
  req.tenant = TEST_TENANT;
  next();
});

// Mock rate limiter so it never blocks tests
jest.mock('../src/middleware/rateLimiter', () => () => (_req, _res, next) => next());

// Mock the database service before loading the app
jest.mock('../src/services/database', () => ({
  findTenantByApiKey: jest.fn().mockResolvedValue({ id: 'aaaaaaaa-0000-0000-0000-000000000001', activo: true }),
  findOrCreateUser: jest.fn().mockResolvedValue({ id: 1, phone: '1234567890' }),
  saveEvent: jest.fn().mockResolvedValue({}),
  saveSolicitud: jest.fn().mockResolvedValue({}),
  getConfig: jest.fn().mockResolvedValue(null), // no tenant flow override by default
}));

jest.mock('../src/services/eventGateway', () => ({
  ingestEvent: jest.fn().mockResolvedValue({ duplicate: false, queued: false }),
}));

const app = require('../src/app');
const db = require('../src/services/database');
const eventGateway = require('../src/services/eventGateway');

beforeEach(() => {
  jest.clearAllMocks();
  // Restore default mocks after clearAllMocks
  db.findOrCreateUser.mockResolvedValue({ id: 1, phone: '1234567890' });
  db.saveEvent.mockResolvedValue({});
  db.saveSolicitud.mockResolvedValue({});
  db.getConfig.mockResolvedValue(null);
  eventGateway.ingestEvent.mockResolvedValue({ duplicate: false, queued: false });
});

describe('POST /webhook – valid requests', () => {
  test('INICIO + opcion_inicio=estres → 200 { screen: "ESTRES" }', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('x-api-key', TEST_API_KEY)
      .send({ screen: 'INICIO', data: { opcion_inicio: 'estres', phone: '1234567890' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screen: 'ESTRES' });
    expect(db.findOrCreateUser).toHaveBeenCalledWith('1234567890', TEST_TENANT.id);
    expect(db.saveEvent).toHaveBeenCalled();
    expect(eventGateway.ingestEvent).toHaveBeenCalled();
  });

  test('INICIO + opcion_inicio=hablar_alguien → 200 { screen: "HABLAR_ALGUIEN" }', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('x-api-key', TEST_API_KEY)
      .send({ screen: 'INICIO', data: { opcion_inicio: 'hablar_alguien' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screen: 'HABLAR_ALGUIEN' });
    // No phone provided – findOrCreateUser should not be called
    expect(db.findOrCreateUser).not.toHaveBeenCalled();
  });

  test('SOLICITUD_ESPACIO triggers saveSolicitud', async () => {
    // SOLICITUD_ESPACIO has no defined outgoing navigation, but the route should
    // attempt to save the solicitud before evaluating next screen.
    const res = await request(app)
      .post('/webhook')
      .set('x-api-key', TEST_API_KEY)
      .send({
        screen: 'SOLICITUD_ESPACIO',
        data: { nombre: 'Ana', telefono_contacto: '555', horario: 'mañana', phone: '999' },
      });

    expect(db.saveSolicitud).toHaveBeenCalled();
    // Navigation is unknown for SOLICITUD_ESPACIO, so expect 400
    expect(res.status).toBe(400);
  });

  test('HABLAR_ALGUIEN + opcion=agendar → 200 { screen: "SOLICITUD_ESPACIO" }', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('x-api-key', TEST_API_KEY)
      .send({ screen: 'HABLAR_ALGUIEN', data: { opcion: 'agendar' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screen: 'SOLICITUD_ESPACIO' });
  });

  test('tenant flow override is used when configured', async () => {
    db.getConfig.mockResolvedValueOnce({
      valor: {
        INICIO: { opcion_inicio: { custom_option: 'CUSTOM_SCREEN' } },
      },
    });

    const res = await request(app)
      .post('/webhook')
      .set('x-api-key', TEST_API_KEY)
      .send({ screen: 'INICIO', data: { opcion_inicio: 'custom_option' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screen: 'CUSTOM_SCREEN' });
  });
});

describe('POST /webhook – validation errors', () => {
  test('missing screen → 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('x-api-key', TEST_API_KEY)
      .send({ data: { opcion_inicio: 'estres' } });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
  });

  test('missing data → 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('x-api-key', TEST_API_KEY)
      .send({ screen: 'INICIO' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
  });

  test('unknown screen → 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('x-api-key', TEST_API_KEY)
      .send({ screen: 'PANTALLA_DESCONOCIDA', data: { opcion: 'algo' } });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('known screen but unknown option → 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('x-api-key', TEST_API_KEY)
      .send({ screen: 'INICIO', data: { opcion_inicio: 'opcion_inexistente' } });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
