jest.mock('../src/services/emailService', () => ({
  sendEmail: jest.fn(),
}));

jest.mock('../src/services/audit', () => ({
  audit: jest.fn(),
}));

const { notifyAssignedAgentEmail } = require('../src/services/solicitudesWebhooks');
const { sendEmail } = require('../src/services/emailService');

describe('notifyAssignedAgentEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendEmail.mockResolvedValue({
      ok: true,
      messageId: 'mail-1',
      accepted: ['agente@example.com'],
      rejected: [],
    });
  });

  test('envía un correo cuando el agente tiene correo configurado', async () => {
    const result = await notifyAssignedAgentEmail({
      tenant: { id: 'tenant-1', nombre: 'Acme' },
      solicitudId: 42,
      assignedAgente: { id: 7, nombre: 'Ana', email: 'ana@example.com' },
      adminUserId: 99,
      ip: '127.0.0.1',
      userAgent: 'jest',
      loginUrl: 'https://portal.example/agente/login?next=%2Fsolicitudes',
    });

    expect(result.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'ana@example.com',
      subject: 'Se te asignó la solicitud #42',
      tenantId: 'tenant-1',
      metadata: expect.objectContaining({
        event: 'solicitud.assigned',
        solicitudId: 42,
        agenteId: 7,
      }),
    }));
  });

  test('no envía correo si el agente no tiene email', async () => {
    const result = await notifyAssignedAgentEmail({
      tenant: { id: 'tenant-1', nombre: 'Acme' },
      solicitudId: 43,
      assignedAgente: { id: 8, nombre: 'Luis', email: '' },
      adminUserId: 100,
      ip: '127.0.0.1',
      userAgent: 'jest',
      loginUrl: 'https://portal.example/agente/login?next=%2Fsolicitudes',
    });

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
