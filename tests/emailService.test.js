jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

jest.mock('../src/services/database', () => ({
  getEmailSettings: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('emailService', () => {
  const OLD_ENV = process.env;
  let sendMail;
  let sendEmail;
  let nodemailer;
  let db;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env = {
      ...OLD_ENV,
      SMTP_HOST: 'env.smtp.local',
      SMTP_PORT: '2525',
      SMTP_USER: 'env-user',
      SMTP_PASS: 'env-pass',
      EMAIL_FROM: 'env@example.com',
    };

    nodemailer = require('nodemailer');
    db = require('../src/services/database');

    sendMail = jest.fn().mockResolvedValue({
      messageId: 'mail-1',
      accepted: ['dest@example.com'],
      rejected: [],
    });
    nodemailer.createTransport.mockReturnValue({ sendMail });
    db.getEmailSettings.mockResolvedValue({
      smtpUrl: '',
      smtpHost: 'tenant.smtp.local',
      smtpPort: '587',
      smtpSecure: false,
      smtpUser: 'tenant-user',
      smtpPass: 'tenant-pass',
      emailFrom: 'tenant@example.com',
      adminBaseUrl: 'https://tenant-admin.example.com',
    });

    ({ sendEmail } = require('../src/services/emailService'));
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('uses tenant-scoped smtp settings when tenantId is provided', async () => {
    await sendEmail({
      to: 'dest@example.com',
      subject: 'Tenant SMTP',
      text: 'Correo desde config tenant',
      tenantId: 'tenant-1',
    });

    expect(db.getEmailSettings).toHaveBeenCalledWith('tenant-1');
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'tenant.smtp.local',
      port: 587,
      secure: false,
      auth: {
        user: 'tenant-user',
        pass: 'tenant-pass',
      },
    });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'tenant@example.com',
      to: 'dest@example.com',
      subject: 'Tenant SMTP',
    }));
  });
});