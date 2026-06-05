'use strict';

const mockPrisma = {
  solicitud: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  solicitudHistory: {
    create: jest.fn(),
  },
  appointment: {
    findMany: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/services/calendarService', () => ({
  cancelAppointment: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/services/crmSync', () => ({
  touch: jest.fn(() => Promise.resolve()),
}));

const db = require('../src/services/database');
const calendarService = require('../src/services/calendarService');

describe('database.updateSolicitudEstado appointment cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.solicitudHistory.create.mockResolvedValue({});
    mockPrisma.appointment.findMany.mockResolvedValue([]);
    calendarService.cancelAppointment.mockResolvedValue({ ok: true });
  });

  test('cancels appointment using appointment_id from variablesJson when solicitud is rejected', async () => {
    mockPrisma.solicitud.findFirst.mockResolvedValueOnce({
      id: 101,
      tenantId: 'tenant-1',
      estado: 'open',
      conversationId: null,
      variablesJson: {
        appointment_id: 'appt-uuid-1',
      },
    });
    mockPrisma.solicitud.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await db.updateSolicitudEstado(101, 'tenant-1', 'rejected');

    expect(result).toEqual({ count: 1 });
    expect(calendarService.cancelAppointment).toHaveBeenCalledWith('appt-uuid-1', 'tenant-1');
    expect(mockPrisma.appointment.findMany).not.toHaveBeenCalled();
  });

  test('still cancels scheduled appointments linked by conversation when present', async () => {
    mockPrisma.solicitud.findFirst.mockResolvedValueOnce({
      id: 102,
      tenantId: 'tenant-1',
      estado: 'open',
      conversationId: 'conv-123',
      variablesJson: {},
    });
    mockPrisma.solicitud.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'appt-uuid-2' },
      { id: 'appt-uuid-3' },
    ]);

    await db.updateSolicitudEstado(102, 'tenant-1', 'rejected');

    expect(mockPrisma.appointment.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        conversationId: 'conv-123',
        status: 'scheduled',
      },
      select: { id: true },
    });
    expect(calendarService.cancelAppointment).toHaveBeenNthCalledWith(1, 'appt-uuid-2', 'tenant-1');
    expect(calendarService.cancelAppointment).toHaveBeenNthCalledWith(2, 'appt-uuid-3', 'tenant-1');
  });
});
