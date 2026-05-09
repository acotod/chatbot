'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Store or update agent device session
 * @param {number} agenteId - Agent ID
 * @param {string} deviceFingerprint - Device fingerprint
 * @param {string} deviceName - Device name
 * @param {string} userAgent - User-Agent header
 * @param {string} ipAddress - IP address
 */
async function storeAgentDeviceSession(agenteId, deviceFingerprint, deviceName, userAgent, ipAddress) {
  try {
    const existingSession = await prisma.agentDeviceSession.findFirst({
      where: { agenteId, deviceFingerprint },
    });

    if (existingSession) {
      // Update last seen
      return await prisma.agentDeviceSession.update({
        where: { id: existingSession.id },
        data: {
          lastSeenAt: new Date(),
          ipAddress,
        },
      });
    } else {
      // Create new device session
      return await prisma.agentDeviceSession.create({
        data: {
          agenteId,
          deviceFingerprint,
          deviceName,
          userAgent,
          ipAddress,
          isActive: true,
          lastSeenAt: new Date(),
        },
      });
    }
  } catch (error) {
    console.error('[AgentDeviceSession] Error storing session:', error);
    throw error;
  }
}

/**
 * Get all active device sessions for agent
 * @param {number} agenteId - Agent ID
 * @returns {Object[]} Array of device sessions
 */
async function getAgentDeviceSessions(agenteId) {
  try {
    return await prisma.agentDeviceSession.findMany({
      where: {
        agenteId,
        isActive: true,
      },
      orderBy: { lastSeenAt: 'desc' },
    });
  } catch (error) {
    console.error('[AgentDeviceSession] Error fetching sessions:', error);
    return [];
  }
}

/**
 * Revoke a device session (logout from device)
 * @param {string} sessionId - Device session ID
 */
async function revokeDeviceSession(sessionId) {
  try {
    return await prisma.agentDeviceSession.update({
      where: { id: sessionId },
      data: { isActive: false },
    });
  } catch (error) {
    console.error('[AgentDeviceSession] Error revoking session:', error);
    throw error;
  }
}

/**
 * Revoke all device sessions except current one
 * @param {number} agenteId - Agent ID
 * @param {string} currentSessionId - Current session ID to keep active
 */
async function revokeAllOtherSessions(agenteId, currentSessionId) {
  try {
    return await prisma.agentDeviceSession.updateMany({
      where: {
        agenteId,
        id: { not: currentSessionId },
        isActive: true,
      },
      data: { isActive: false },
    });
  } catch (error) {
    console.error('[AgentDeviceSession] Error revoking all other sessions:', error);
    throw error;
  }
}

/**
 * Check if device session exists and is active
 * @param {number} agenteId - Agent ID
 * @param {string} deviceFingerprint - Device fingerprint
 * @returns {boolean} True if device is known/trusted
 */
async function isDeviceTrusted(agenteId, deviceFingerprint) {
  try {
    const session = await prisma.agentDeviceSession.findFirst({
      where: {
        agenteId,
        deviceFingerprint,
        isActive: true,
      },
    });
    return !!session;
  } catch (error) {
    console.error('[AgentDeviceSession] Error checking trust:', error);
    return false;
  }
}

module.exports = {
  storeAgentDeviceSession,
  getAgentDeviceSessions,
  revokeDeviceSession,
  revokeAllOtherSessions,
  isDeviceTrusted,
};
