jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

jest.mock('../src/services/database', () => ({
  getEmailSettings: jest.fn(),
  createEmailLog: jest.fn(),
  updateEmailLogStatus: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../src/services/redis', () => ({
  getRedisClient: jest.fn(),
}));

describe('emailService', () => {
  const OLD_ENV = process.env;
  let sendMail;
  let sendEmail;
  let enqueueEmail;
  let nodemailer;
  let db;
  let redisModule;

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
    db.createEmailLog.mockResolvedValue({ id: 55 });
    db.updateEmailLogStatus.mockResolvedValue({ id: 55 });

    ({ sendEmail, enqueueEmail } = require('../src/services/emailService'));
    redisModule = require('../src/services/redis');
    redisModule.getRedisClient.mockReturnValue(null);
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
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'tenant@example.com',
      to: 'dest@example.com',
      subject: 'Tenant SMTP',
    }));
  });

  test('applies connection timeouts to SMTP URLs and parses auth settings', async () => {
    db.getEmailSettings.mockResolvedValue({
      smtpUrl: 'smtps://mail-user:mail-pass@mail.example.com:465',
      smtpHost: '',
      smtpPort: '',
      smtpSecure: true,
      smtpUser: '',
      smtpPass: '',
      emailFrom: 'tenant@example.com',
      adminBaseUrl: '',
    });

    await sendEmail({
      to: 'dest@example.com',
      subject: 'SMTP URL',
      text: 'Correo de prueba',
      tenantId: 'tenant-1',
    });

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'mail.example.com',
      port: 465,
      secure: true,
      auth: { user: 'mail-user', pass: 'mail-pass' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  });

  test('rejects SMTP URL protocols outside smtp and smtps', async () => {
    db.getEmailSettings.mockResolvedValue({
      smtpUrl: 'https://mail.example.com',
      smtpHost: '',
      smtpPort: '',
      smtpSecure: false,
      smtpUser: '',
      smtpPass: '',
      emailFrom: 'tenant@example.com',
      adminBaseUrl: '',
    });

    await expect(sendEmail({
      to: 'dest@example.com',
      subject: 'SMTP URL',
      text: 'Correo de prueba',
      tenantId: 'tenant-1',
    })).rejects.toMatchObject({ code: 'EMAIL_SMTP_URL_INVALID' });
  });

  test('rejects a malformed recipient address', async () => {
    await expect(sendEmail({
      to: 'not-an-email',
      subject: 'Tenant SMTP',
      text: 'Correo desde config tenant',
      tenantId: 'tenant-1',
    })).rejects.toMatchObject({ code: 'EMAIL_RECIPIENT_INVALID' });

    expect(sendMail).not.toHaveBeenCalled();
  });

  test('allows an explicit from on the same domain as the configured sender', async () => {
    await sendEmail({
      to: 'dest@example.com',
      subject: 'Tenant SMTP',
      text: 'Correo desde config tenant',
      from: 'Soporte <soporte@example.com>',
      tenantId: 'tenant-1',
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Soporte <soporte@example.com>',
    }));
  });

  test('rejects an explicit from on a different domain (anti-spoofing)', async () => {
    await expect(sendEmail({
      to: 'dest@example.com',
      subject: 'Tenant SMTP',
      text: 'Correo desde config tenant',
      from: 'ceo@otra-empresa.com',
      tenantId: 'tenant-1',
    })).rejects.toMatchObject({ code: 'EMAIL_FROM_NOT_ALLOWED' });

    expect(sendMail).not.toHaveBeenCalled();
  });

  describe('enqueueEmail', () => {
    test('pushes the payload to the redis queue instead of sending immediately', async () => {
      const lpush = jest.fn().mockResolvedValue(1);
      redisModule.getRedisClient.mockReturnValue({ lpush });

      const result = await enqueueEmail({
        to: 'dest@example.com',
        subject: 'Cola de email',
        text: 'Correo encolado',
        tenantId: 'tenant-1',
      });

      expect(result).toEqual({ ok: true, queued: true });
      expect(lpush).toHaveBeenCalledWith('queue:email_send', expect.any(String));
      const [, raw] = lpush.mock.calls[0];
      expect(JSON.parse(raw)).toMatchObject({
        to: 'dest@example.com',
        subject: 'Cola de email',
        tenantId: 'tenant-1',
        emailLogId: 55,
        attempts: 0,
      });
      expect(db.createEmailLog).toHaveBeenCalledWith(expect.objectContaining({
        to: 'dest@example.com',
        subject: 'Cola de email',
        tenantId: 'tenant-1',
      }));
      expect(sendMail).not.toHaveBeenCalled();
    });

    test('falls back to a synchronous send when redis is unavailable', async () => {
      redisModule.getRedisClient.mockReturnValue(null);

      const result = await enqueueEmail({
        to: 'dest@example.com',
        subject: 'Cola de email',
        text: 'Correo encolado',
        tenantId: 'tenant-1',
      });

      expect(result.ok).toBe(true);
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'dest@example.com',
        subject: 'Cola de email',
      }));
      expect(db.updateEmailLogStatus).toHaveBeenCalledWith(55, 'sent', expect.objectContaining({ attempts: 1 }));
    });

    test('validates the payload before touching redis', async () => {
      const lpush = jest.fn();
      redisModule.getRedisClient.mockReturnValue({ lpush });

      await expect(enqueueEmail({
        to: 'not-an-email',
        subject: 'Cola de email',
        text: 'Correo encolado',
        tenantId: 'tenant-1',
      })).rejects.toMatchObject({ code: 'EMAIL_RECIPIENT_INVALID' });

      expect(lpush).not.toHaveBeenCalled();
    });
  });
});