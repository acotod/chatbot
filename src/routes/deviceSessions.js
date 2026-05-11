'use strict';

const express = require('express');
const requireJwt = require('../middleware/requireJwt');
const requireAgentJwt = require('../middleware/requireAgentJwt');
const { getAdminDeviceSessions, revokeDeviceSession: revokeAdminSession } = require('../services/adminDeviceSession');
const { getAgentDeviceSessions, revokeDeviceSession: revokeAgentSession } = require('../services/agentDeviceSession');
const { generateRecoveryCodes, storeRecoveryCodes, getUnusedCodeCount } = require('../services/mfaRecoveryCode');
const { audit } = require('../services/audit');

const router = express.Router();

function getAdminUserId(req) {
  return req.admin?.adminUserId ?? req.user?.adminUserId ?? req.user?.id ?? null;
}

// ── Admin Device Management ──────────────────────────────────────────────────

/**
 * GET /device-sessions/admin
 * Get all active device sessions for current admin user
 */
router.get('/admin', requireJwt, async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    if (!adminUserId) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }
    const sessions = await getAdminDeviceSessions(adminUserId);

    return res.json({
      sessions: sessions.map(s => ({
        id: s.id,
        deviceName: s.deviceName,
        deviceFingerprint: s.deviceFingerprint,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        lastSeenAt: s.lastSeenAt,
        isActive: s.isActive,
      })),
      count: sessions.length,
    });
  } catch (error) {
    console.error('[DeviceSessions] Error fetching admin sessions:', error);
    return res.status(500).json({ error: 'Failed to fetch device sessions' });
  }
});

/**
 * POST /device-sessions/admin/:sessionId/revoke
 * Revoke a specific device session (logout from device)
 */
router.post('/admin/:sessionId/revoke', requireJwt, async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    if (!adminUserId) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }
    const { sessionId } = req.params;

    // Verify the session belongs to the current admin
    const sessions = await getAdminDeviceSessions(adminUserId);
    const sessionExists = sessions.some(s => s.id === sessionId);

    if (!sessionExists) {
      audit({
        adminUserId,
        accion: 'DEVICE_REVOKE_UNAUTHORIZED',
        entidad: 'device_session',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await revokeAdminSession(sessionId);

    audit({
      adminUserId,
      accion: 'DEVICE_REVOKE',
      entidad: 'device_session',
      entidadId: sessionId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({ success: true, message: 'Device session revoked' });
  } catch (error) {
    console.error('[DeviceSessions] Error revoking admin session:', error);
    return res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// ── Agent Device Management ──────────────────────────────────────────────────

/**
 * GET /device-sessions/agent
 * Get all active device sessions for current agent user
 */
router.get('/agent', requireAgentJwt, async (req, res) => {
  try {
    const { agenteId } = req.user;
    const sessions = await getAgentDeviceSessions(agenteId);

    return res.json({
      sessions: sessions.map(s => ({
        id: s.id,
        deviceName: s.deviceName,
        deviceFingerprint: s.deviceFingerprint,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        lastSeenAt: s.lastSeenAt,
        isActive: s.isActive,
      })),
      count: sessions.length,
    });
  } catch (error) {
    console.error('[DeviceSessions] Error fetching agent sessions:', error);
    return res.status(500).json({ error: 'Failed to fetch device sessions' });
  }
});

/**
 * POST /device-sessions/agent/:sessionId/revoke
 * Revoke a specific device session (logout from device)
 */
router.post('/agent/:sessionId/revoke', requireAgentJwt, async (req, res) => {
  try {
    const { agenteId } = req.user;
    const { sessionId } = req.params;

    // Verify the session belongs to the current agent
    const sessions = await getAgentDeviceSessions(agenteId);
    const sessionExists = sessions.some(s => s.id === sessionId);

    if (!sessionExists) {
      audit({
        entidad: 'device_session',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: { agenteId, action: 'DEVICE_REVOKE_UNAUTHORIZED' },
      });
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await revokeAgentSession(sessionId);

    audit({
      entidad: 'device_session',
      entidadId: sessionId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { agenteId, action: 'DEVICE_REVOKE' },
    });

    return res.json({ success: true, message: 'Device session revoked' });
  } catch (error) {
    console.error('[DeviceSessions] Error revoking agent session:', error);
    return res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// ── MFA Recovery Code Management ─────────────────────────────────────────────

/**
 * POST /device-sessions/mfa/generate-recovery-codes
 * Generate new MFA recovery codes for admin user
 */
router.post('/mfa/generate-recovery-codes', requireJwt, async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    if (!adminUserId) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    // Generate new recovery codes
    const codes = generateRecoveryCodes(8);
    await storeRecoveryCodes(adminUserId, codes);

    audit({
      adminUserId,
      accion: 'MFA_RECOVERY_CODES_GENERATED',
      entidad: 'mfa_recovery_codes',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({
      success: true,
      message: 'Recovery codes generated. Save them in a secure location.',
      codes, // Only show once during generation
      expiryWarning: 'These codes will not be shown again. Please save them securely.',
    });
  } catch (error) {
    console.error('[MFA] Error generating recovery codes:', error);
    return res.status(500).json({ error: 'Failed to generate recovery codes' });
  }
});

/**
 * GET /device-sessions/mfa/recovery-codes-count
 * Get count of unused MFA recovery codes
 */
router.get('/mfa/recovery-codes-count', requireJwt, async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    if (!adminUserId) {
      // Superadmin (env-based) has no DB-backed user — return empty count instead of 401
      if (req.admin?.superAdmin) {
        return res.json({ unusedCodeCount: 0, needsGeneration: false, warning: null, superAdmin: true });
      }
      return res.status(401).json({ error: 'Invalid token payload' });
    }
    const count = await getUnusedCodeCount(adminUserId);

    return res.json({
      unusedCodeCount: count,
      needsGeneration: count === 0,
      warning: count < 3 ? 'Low on recovery codes. Generate new ones.' : null,
    });
  } catch (error) {
    console.error('[MFA] Error getting recovery codes count:', error);
    return res.status(500).json({ error: 'Failed to get recovery codes count' });
  }
});

module.exports = router;
