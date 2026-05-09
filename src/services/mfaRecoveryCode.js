'use strict';

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Generate MFA recovery codes
 * Format: ABC-123-XYZ (8 codes)
 * @returns {string[]} Array of recovery codes
 */
function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // Generate 9 random characters: 3 letters + 3 digits + 3 letters
    const part1 = crypto.randomBytes(2).toString('hex').substring(0, 3).toUpperCase();
    const part2 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const part3 = crypto.randomBytes(2).toString('hex').substring(0, 3).toUpperCase();
    codes.push(`${part1}-${part2}-${part3}`);
  }
  return codes;
}

/**
 * Hash a recovery code for storage
 * @param {string} code - Recovery code to hash
 * @returns {string} SHA256 hash
 */
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Store recovery codes for admin user
 * @param {string} adminUserId - Admin user ID (UUID or Int)
 * @param {string[]} codes - Array of recovery codes
 */
async function storeRecoveryCodes(adminUserId, codes) {
  try {
    // Delete any existing recovery codes
    await prisma.adminMfaRecoveryCode.deleteMany({
      where: { adminUserId },
    });

    // Store new codes
    const hashedCodes = codes.map(code => ({
      adminUserId,
      code: hashRecoveryCode(code),
      used: false,
    }));

    await prisma.adminMfaRecoveryCode.createMany({
      data: hashedCodes,
    });

    return codes; // Return plaintext codes to display to user once
  } catch (error) {
    console.error('[MFARecoveryCode] Error storing codes:', error);
    throw error;
  }
}

/**
 * Use/consume a recovery code
 * @param {string} adminUserId - Admin user ID
 * @param {string} code - Recovery code to consume
 * @returns {boolean} True if code was valid and consumed
 */
async function consumeRecoveryCode(adminUserId, code) {
  try {
    const hashedCode = hashRecoveryCode(code);
    const recoveryCode = await prisma.adminMfaRecoveryCode.findFirst({
      where: {
        adminUserId,
        code: hashedCode,
        used: false,
      },
    });

    if (!recoveryCode) {
      return false;
    }

    // Mark as used
    await prisma.adminMfaRecoveryCode.update({
      where: { id: recoveryCode.id },
      data: { used: true, usedAt: new Date() },
    });

    return true;
  } catch (error) {
    console.error('[MFARecoveryCode] Error consuming code:', error);
    return false;
  }
}

/**
 * Get count of unused recovery codes
 * @param {string} adminUserId - Admin user ID
 * @returns {number} Count of unused codes
 */
async function getUnusedCodeCount(adminUserId) {
  try {
    const count = await prisma.adminMfaRecoveryCode.count({
      where: {
        adminUserId,
        used: false,
      },
    });
    return count;
  } catch (error) {
    console.error('[MFARecoveryCode] Error getting code count:', error);
    return 0;
  }
}

module.exports = {
  generateRecoveryCodes,
  hashRecoveryCode,
  storeRecoveryCodes,
  consumeRecoveryCode,
  getUnusedCodeCount,
};
