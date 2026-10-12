const {
  decryptSecret,
  encryptSecret,
  rotateConfigValue,
  rotateConfigs,
} = require('../scripts/rotate-config-encryption-key');

describe('rotate-config-encryption-key', () => {
  const oldSecret = 'old-dedicated-or-jwt-secret';
  const newSecret = 'new-dedicated-config-key';

  test('rotates an encrypted secret without changing its plaintext', () => {
    const previous = encryptSecret('smtp-password', oldSecret);
    const rotated = encryptSecret(decryptSecret(previous, oldSecret), newSecret);

    expect(rotated).not.toBe(previous);
    expect(decryptSecret(rotated, newSecret)).toBe('smtp-password');
    expect(() => decryptSecret(rotated, oldSecret)).toThrow();
  });

  test('encrypts legacy plaintext secrets and only changes secret fields', () => {
    const rotated = rotateConfigValue('email_settings', {
      smtpHost: 'smtp.example.test',
      smtpPass: ' legacy-password ',
      emailFrom: 'alerts@example.test',
    }, oldSecret, newSecret);

    expect(rotated.smtpHost).toBe('smtp.example.test');
    expect(rotated.emailFrom).toBe('alerts@example.test');
    expect(decryptSecret(rotated.smtpPass, newSecret)).toBe('legacy-password');
  });

  test('dry-run validates secrets and never writes', async () => {
    const valor = { phoneNumberId: '123', accessToken: encryptSecret('wa-token', oldSecret) };
    const prisma = {
      configuracion: {
        findMany: jest.fn().mockResolvedValue([{ id: 7, clave: 'wa_credentials', valor }]),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    await expect(rotateConfigs({ prisma, oldSecret, newSecret, apply: false })).resolves.toEqual({
      configsScanned: 1,
      secretsRotated: 1,
      applied: false,
    });
    expect(prisma.configuracion.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('apply validates and updates all matching configs in one transaction', async () => {
    const valor = { smtpPass: encryptSecret('smtp-password', oldSecret), smtpHost: 'smtp.example.test' };
    const tx = {
      configuracion: {
        findMany: jest.fn().mockResolvedValue([{ id: 11, clave: 'email_settings', valor }]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    };

    await expect(rotateConfigs({ prisma, oldSecret, newSecret, apply: true })).resolves.toEqual({
      configsScanned: 1,
      secretsRotated: 1,
      applied: true,
    });

    const update = tx.configuracion.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 11 });
    expect(decryptSecret(update.data.valor.smtpPass, newSecret)).toBe('smtp-password');
    expect(update.data.valor.smtpHost).toBe('smtp.example.test');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
