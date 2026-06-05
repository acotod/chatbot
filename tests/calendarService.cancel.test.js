'use strict';

const mockTx = {
  appointment: {
    update: jest.fn(),
  },
  $executeRaw: jest.fn(),
};

const mockPrisma = {
  appointment: {
    findFirst: jest.fn(),
  },
  $transaction: jest.fn(async (cb) => cb(mockTx)),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../src/utils/logger');
const calendarService = require('../src/services/calendarService');

describe('calendarService.cancelAppointment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete global.fetch;
  });

  test('returns NOT_FOUND when appointment does not exist', async () => {
    mockPrisma.appointment.findFirst.mockResolvedValue(null);

    const result = await calendarService.cancelAppointment('appt-1', 'tenant-1');

    expect(result).toEqual({ error: 'NOT_FOUND' });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  test('returns ALREADY_CANCELLED when appointment is already cancelled', async () => {
    mockPrisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-1',
      status: 'cancelled',
      metadata: {},
      calendar: { id: 'cal-1', name: 'Agenda', timezone: 'UTC', config: {} },
    });

    const result = await calendarService.cancelAppointment('appt-1', 'tenant-1');

    expect(result).toEqual({ error: 'ALREADY_CANCELLED' });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  test('cancels appointment and restores slot when scheduled', async () => {
    mockPrisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-1',
      status: 'scheduled',
      metadata: {},
      calendar: { id: 'cal-1', name: 'Agenda', timezone: 'UTC', config: { provider: 'internal' } },
    });

    mockTx.appointment.update.mockResolvedValue({});
    mockTx.$executeRaw.mockResolvedValue(1);

    const result = await calendarService.cancelAppointment('appt-1', 'tenant-1');

    expect(result).toEqual({ ok: true });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.appointment.update).toHaveBeenCalledWith({
      where: { id: 'appt-1' },
      data: { status: 'cancelled', updatedAt: expect.any(Date) },
    });
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  test('keeps cancellation OK when Google sync fails and logs error', async () => {
    mockPrisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-1',
      status: 'scheduled',
      metadata: { external_event_id: 'evt-1' },
      calendar: {
        id: 'cal-1',
        name: 'Agenda',
        timezone: 'UTC',
        config: {
          provider: 'google',
          sync: true,
          provider_credentials: {
            access_token: 'token-123',
            calendar_id: 'primary',
          },
        },
      },
    });

    mockTx.appointment.update.mockResolvedValue({});
    mockTx.$executeRaw.mockResolvedValue(1);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'google failure',
    });

    const result = await calendarService.cancelAppointment('appt-1', 'tenant-1');

    expect(result).toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: 'appt-1',
        calendarId: 'cal-1',
      }),
      'calendarService.cancelAppointment google sync failed'
    );
  });
});