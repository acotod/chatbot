const express = require('express');
const request = require('supertest');

const mockPrisma = {
  agente: { findFirst: jest.fn() },
  calendar: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  appointment: { findMany: jest.fn(), count: jest.fn() },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/middleware/requireJwt', () => (_req, _res, next) => next());

jest.mock('../src/middleware/resolveTenant', () => (req, _res, next) => {
  req.tenantId = 'tenant-1';
  req.tenant = { id: 'tenant-1' };
  next();
});

jest.mock('../src/services/calendarService', () => ({
  cancelAppointment: jest.fn(),
  getAppointment: jest.fn(),
  rescheduleAppointment: jest.fn(),
}));

jest.mock('../src/services/database', () => ({
  SOLICITUD_STATUS: {
    COMPLETED: 'completed',
    REJECTED: 'rejected',
  },
  listSolicitudesByConversationId: jest.fn(),
  updateSolicitudEstado: jest.fn(),
}));

const calendarRouter = require('../src/routes/calendar');
const calendarSvc = require('../src/services/calendarService');
const db = require('../src/services/database');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/calendar', calendarRouter);
  return app;
}

describe('POST /calendar/appointments/:id/cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns ok true on success', async () => {
    calendarSvc.getAppointment.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      conversationId: null,
    });
    calendarSvc.cancelAppointment.mockResolvedValue({ ok: true });

    const app = createApp();
    const res = await request(app)
      .post('/calendar/appointments/11111111-1111-1111-1111-111111111111/cancel')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(calendarSvc.cancelAppointment).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'tenant-1'
    );
    expect(db.listSolicitudesByConversationId).not.toHaveBeenCalled();
    expect(db.updateSolicitudEstado).not.toHaveBeenCalled();
  });

  test('returns 400 when service returns ALREADY_CANCELLED', async () => {
    calendarSvc.getAppointment.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      conversationId: null,
    });
    calendarSvc.cancelAppointment.mockResolvedValue({ error: 'ALREADY_CANCELLED' });

    const app = createApp();
    const res = await request(app)
      .post('/calendar/appointments/11111111-1111-1111-1111-111111111111/cancel')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'ALREADY_CANCELLED' });
  });

  test('returns 400 when service returns NOT_FOUND', async () => {
    calendarSvc.getAppointment.mockResolvedValue(null);
    calendarSvc.cancelAppointment.mockResolvedValue({ error: 'NOT_FOUND' });

    const app = createApp();
    const res = await request(app)
      .post('/calendar/appointments/11111111-1111-1111-1111-111111111111/cancel')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
  });

  test('cancels linked open solicitudes when appointment has conversationId', async () => {
    calendarSvc.getAppointment.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      conversationId: 'conv-1',
    });
    calendarSvc.cancelAppointment.mockResolvedValue({ ok: true });
    db.listSolicitudesByConversationId.mockResolvedValue([
      { id: 10, estado: 'open' },
      { id: 11, estado: 'pending_info' },
      { id: 12, estado: 'completed' },
      { id: 13, estado: 'rejected' },
    ]);
    db.updateSolicitudEstado.mockResolvedValue({ count: 1 });

    const app = createApp();
    const res = await request(app)
      .post('/calendar/appointments/11111111-1111-1111-1111-111111111111/cancel')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.listSolicitudesByConversationId).toHaveBeenCalledWith('tenant-1', 'conv-1');
    expect(db.updateSolicitudEstado).toHaveBeenCalledTimes(2);
    expect(db.updateSolicitudEstado).toHaveBeenNthCalledWith(1, 10, 'tenant-1', 'rejected');
    expect(db.updateSolicitudEstado).toHaveBeenNthCalledWith(2, 11, 'tenant-1', 'rejected');
  });
});
