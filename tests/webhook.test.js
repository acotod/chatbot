const request = require('supertest');

// Mock the database service before loading the app
jest.mock('../src/services/database', () => ({
  findOrCreateUser: jest.fn().mockResolvedValue({ id: 1, phone: '1234567890' }),
  saveEvent: jest.fn().mockResolvedValue({}),
  saveSolicitud: jest.fn().mockResolvedValue({}),
}));

const app = require('../src/app');
const db = require('../src/services/database');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /webhook – valid requests', () => {
  test('INICIO + opcion_inicio=estres → 200 { screen: "ESTRES" }', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({ screen: 'INICIO', data: { opcion_inicio: 'estres', phone: '1234567890' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screen: 'ESTRES' });
    expect(db.findOrCreateUser).toHaveBeenCalledWith('1234567890');
    expect(db.saveEvent).toHaveBeenCalled();
  });

  test('INICIO + opcion_inicio=hablar_alguien → 200 { screen: "HABLAR_ALGUIEN" }', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({ screen: 'INICIO', data: { opcion_inicio: 'hablar_alguien' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screen: 'HABLAR_ALGUIEN' });
    // No phone provided – findOrCreateUser should not be called
    expect(db.findOrCreateUser).not.toHaveBeenCalled();
  });

  test('SOLICITUD_ESPACIO triggers saveSolicitud', async () => {
    // SOLICITUD_ESPACIO has no defined outgoing navigation, but the route should
    // attempt to save the solicitud before evaluating next screen.
    // We can confirm saveSolicitud is called even if navigation returns null (400).
    const res = await request(app)
      .post('/webhook')
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
      .send({ screen: 'HABLAR_ALGUIEN', data: { opcion: 'agendar' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screen: 'SOLICITUD_ESPACIO' });
  });
});

describe('POST /webhook – validation errors', () => {
  test('missing screen → 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({ data: { opcion_inicio: 'estres' } });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
  });

  test('missing data → 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({ screen: 'INICIO' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
  });

  test('unknown screen → 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({ screen: 'PANTALLA_DESCONOCIDA', data: { opcion: 'algo' } });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('known screen but unknown option → 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({ screen: 'INICIO', data: { opcion_inicio: 'opcion_inexistente' } });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
