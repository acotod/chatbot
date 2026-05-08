/**
 * Manage account lockout policy per tenant
 * Stores: maxAttempts, lockoutMinutes
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const CONFIG_KEY = 'account_lockout_policy';

// Default values
const DEFAULTS = {
  maxAttempts: 5,
  lockoutMinutes: 15,
};

/**
 * Get lockout policy for a tenant
 * Falls back to defaults if not configured
 */
async function getPolicy(tenantId) {
  if (!tenantId) {
    return DEFAULTS;
  }

  try {
    const config = await prisma.configuracion.findUnique({
      where: { tenantId_clave: { tenantId, clave: CONFIG_KEY } },
    });

    if (!config) {
      return DEFAULTS;
    }

    return {
      maxAttempts: config.valor?.maxAttempts ?? DEFAULTS.maxAttempts,
      lockoutMinutes: config.valor?.lockoutMinutes ?? DEFAULTS.lockoutMinutes,
    };
  } catch (err) {
    console.error(`[lockoutPolicy] Failed to fetch policy for tenant ${tenantId}:`, err.message);
    return DEFAULTS;
  }
}

/**
 * Update lockout policy for a tenant
 */
async function updatePolicy(tenantId, { maxAttempts, lockoutMinutes }) {
  if (!tenantId) {
    throw new Error('tenantId is required');
  }

  // Validate inputs
  const attempts = Math.max(1, Math.min(20, parseInt(maxAttempts, 10) || DEFAULTS.maxAttempts));
  const minutes = Math.max(1, Math.min(1440, parseInt(lockoutMinutes, 10) || DEFAULTS.lockoutMinutes));

  try {
    const result = await prisma.configuracion.upsert({
      where: { tenantId_clave: { tenantId, clave: CONFIG_KEY } },
      update: {
        valor: {
          maxAttempts: attempts,
          lockoutMinutes: minutes,
        },
      },
      create: {
        tenantId,
        clave: CONFIG_KEY,
        valor: {
          maxAttempts: attempts,
          lockoutMinutes: minutes,
        },
      },
    });

    return {
      maxAttempts: result.valor.maxAttempts,
      lockoutMinutes: result.valor.lockoutMinutes,
    };
  } catch (err) {
    console.error(`[lockoutPolicy] Failed to update policy for tenant ${tenantId}:`, err.message);
    throw err;
  }
}

/**
 * Reset policy to defaults for a tenant
 */
async function resetPolicy(tenantId) {
  if (!tenantId) {
    throw new Error('tenantId is required');
  }

  try {
    await prisma.configuracion.delete({
      where: { tenantId_clave: { tenantId, clave: CONFIG_KEY } },
    }).catch(() => {}); // Ignore not found

    return DEFAULTS;
  } catch (err) {
    console.error(`[lockoutPolicy] Failed to reset policy for tenant ${tenantId}:`, err.message);
    throw err;
  }
}

module.exports = {
  getPolicy,
  updatePolicy,
  resetPolicy,
  CONFIG_KEY,
  DEFAULTS,
};
