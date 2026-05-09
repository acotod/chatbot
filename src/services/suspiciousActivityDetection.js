'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ACTIVITY_TYPES = {
  NEW_DEVICE_LOGIN: 'new_device_login',
  IMPOSSIBLE_TRAVEL: 'impossible_travel',
  MULTIPLE_FAILED_LOGINS: 'multiple_failed_logins',
  UNUSUAL_TIME_LOGIN: 'unusual_time_login',
  LOCATION_CHANGE: 'location_change',
  TOKEN_REUSE: 'token_reuse',
};

const SEVERITY_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/**
 * Log suspicious activity
 * @param {Object} options - Activity details
 * @param {string} options.adminUserId - Admin user ID (optional)
 * @param {number} options.agenteId - Agent ID (optional)
 * @param {string} options.activityType - Type of activity (see ACTIVITY_TYPES)
 * @param {string} options.severity - Severity level (see SEVERITY_LEVELS)
 * @param {string} options.description - Activity description
 * @param {string} options.deviceFingerprint - Device fingerprint
 * @param {string} options.ipAddress - IP address
 * @param {string} options.userAgent - User-Agent header
 * @param {Object} options.metadata - Additional metadata
 */
async function logSuspiciousActivity(options) {
  try {
    const {
      adminUserId = null,
      agenteId = null,
      activityType,
      severity = SEVERITY_LEVELS.MEDIUM,
      description,
      deviceFingerprint,
      ipAddress,
      userAgent,
      metadata = {},
    } = options;

    const activity = await prisma.suspiciousActivity.create({
      data: {
        adminUserId,
        agenteId,
        activityType,
        severity,
        description,
        deviceFingerprint,
        ipAddress,
        userAgent,
        metadata,
      },
    });

    return activity;
  } catch (error) {
    console.error('[SuspiciousActivity] Error logging activity:', error);
    throw error;
  }
}

/**
 * Check if user has suspicious activity pattern
 * @param {string} adminUserId - Admin user ID or
 * @param {number} agenteId - Agent ID
 * @param {number} hoursLookback - Hours to look back (default: 24)
 */
async function checkSuspiciousPattern(userIdentifier, hoursLookback = 24) {
  try {
    const timeRange = new Date(Date.now() - hoursLookback * 60 * 60 * 1000);

    const activities = await prisma.suspiciousActivity.findMany({
      where: {
        OR: [
          { adminUserId: typeof userIdentifier === 'string' ? userIdentifier : undefined },
          { agenteId: typeof userIdentifier === 'number' ? userIdentifier : undefined },
        ],
        createdAt: { gte: timeRange },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      count: activities.count,
      highSeverityCount: activities.filter(a => a.severity === SEVERITY_LEVELS.HIGH).length,
      criticalCount: activities.filter(a => a.severity === SEVERITY_LEVELS.CRITICAL).length,
      activities,
    };
  } catch (error) {
    console.error('[SuspiciousActivity] Error checking pattern:', error);
    return { count: 0, highSeverityCount: 0, criticalCount: 0, activities: [] };
  }
}

/**
 * Detect new device login
 * @param {string} adminUserId - Admin user ID or
 * @param {number} agenteId - Agent ID
 * @param {string} deviceFingerprint - Current device fingerprint
 */
async function detectNewDevice(userIdentifier, deviceFingerprint) {
  try {
    let where = {};
    if (typeof userIdentifier === 'string') {
      where.adminUserId = userIdentifier;
    } else {
      where.agenteId = userIdentifier;
    }

    const existingSession = await prisma.adminDeviceSession?.findFirst?.({
      where: {
        ...where,
        deviceFingerprint,
        isActive: true,
      },
    }) ||
    await prisma.agentDeviceSession?.findFirst?.({
      where: {
        ...where,
        deviceFingerprint,
        isActive: true,
      },
    });

    return !existingSession; // true if new device
  } catch (error) {
    console.error('[SuspiciousActivity] Error detecting new device:', error);
    return false;
  }
}

module.exports = {
  ACTIVITY_TYPES,
  SEVERITY_LEVELS,
  logSuspiciousActivity,
  checkSuspiciousPattern,
  detectNewDevice,
};
