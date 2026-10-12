'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const ENCRYPTED_PREFIX = 'enc$1:';
const SECRET_CONFIG_KEYS = new Set([
  'wa_credentials',
  'email_settings',
  'wa_app_secret',
  'whatsapp_app_secret',
]);

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function decryptSecret(value, secret) {
  const raw = String(value ?? '').trim();
  if (!raw.startsWith(ENCRYPTED_PREFIX)) return raw;

  const parts = raw.split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted secret format');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(secret),
    Buffer.from(parts[1], 'base64'),
  );
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], 'base64')),
    decipher.final(),
  ]).toString('utf8').trim();
}

function encryptSecret(value, secret) {
  const plainText = String(value ?? '').trim();
  if (!plainText) return '';

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function rotateValue(value, oldSecret, newSecret) {
  if (typeof value !== 'string' || !value.trim()) return value;
  return encryptSecret(decryptSecret(value, oldSecret), newSecret);
}

function rotateConfigValue(clave, valor, oldSecret, newSecret) {
  if (clave === 'wa_credentials' || clave === 'email_settings') {
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return valor;
    const rotated = { ...valor };
    const secretField = clave === 'wa_credentials' ? 'accessToken' : 'smtpPass';
    if (typeof rotated[secretField] === 'string') {
      rotated[secretField] = rotateValue(rotated[secretField], oldSecret, newSecret);
    }
    return rotated;
  }

  return rotateValue(valor, oldSecret, newSecret);
}

async function rotateConfigs({ prisma, oldSecret, newSecret, apply }) {
  const rotate = async (client) => {
    const rows = await client.configuracion.findMany({
      where: { clave: { in: [...SECRET_CONFIG_KEYS] } },
      select: { id: true, clave: true, valor: true },
    });
    const updates = rows.map((row) => ({
      id: row.id,
      valor: rotateConfigValue(row.clave, row.valor, oldSecret, newSecret),
    }));

    if (apply) {
      for (const update of updates) {
        await client.configuracion.update({ where: { id: update.id }, data: { valor: update.valor } });
      }
    }

    return {
      configsScanned: rows.length,
      secretsRotated: updates.reduce((count, update) => count + countSecrets(update.valor), 0),
      applied: Boolean(apply),
    };
  };

  return apply ? prisma.$transaction(rotate) : rotate(prisma);
}

function countSecrets(valor) {
  if (typeof valor === 'string') return valor.startsWith(ENCRYPTED_PREFIX) ? 1 : 0;
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return 0;
  return Object.values(valor).filter((value) => typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)).length;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== '--dry-run' && mode !== '--apply') {
    throw new Error('Specify exactly one mode: --dry-run or --apply');
  }

  const oldSecret = process.env.OLD_CONFIG_ENCRYPTION_KEY;
  const newSecret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!oldSecret || !newSecret) {
    throw new Error('Set OLD_CONFIG_ENCRYPTION_KEY and CONFIG_ENCRYPTION_KEY in the environment');
  }
  if (oldSecret === newSecret) {
    throw new Error('The new config encryption key must differ from the old key');
  }

  const prisma = new PrismaClient();
  try {
    const result = await rotateConfigs({ prisma, oldSecret, newSecret, apply: mode === '--apply' });
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  decryptSecret,
  encryptSecret,
  rotateConfigValue,
  rotateConfigs,
};
