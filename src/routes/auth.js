'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const { audit } = require('../services/audit');
const db = require('../services/database');
const { getRedisClient } = require('../services/redis');
const logger = require('../utils/logger');
const { sendEmail, EmailServiceError } = require('../services/emailService');
const wa = require('../services/whatsapp');
const socketService = require('../services/socketService');
const requireJwt = require('../middleware/requireJwt');
const requireAgentJwt = require('../middleware/requireAgentJwt');
const lockoutPolicy = require('../services/lockoutPolicy');
const { generateDeviceFingerprint, parseDeviceNameFromUserAgent } = require('../services/deviceFingerprint');
const { logSuspiciousActivity, detectNewDevice, ACTIVITY_TYPES, SEVERITY_LEVELS } = require('../services/suspiciousActivityDetection');
const { storeAdminDeviceSession } = require('../services/adminDeviceSession');
const { storeAgentDeviceSession } = require('../services/agentDeviceSession');

const prisma = new PrismaClient();
const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

const ACCESS_TTL  = parseInt(process.env.ACCESS_TOKEN_TTL  || '900',  10); // 15 min
const REFRESH_TTL = parseInt(process.env.REFRESH_TOKEN_TTL || '604800', 10); // 7 days
const AGENT_PASSWORD_RESET_TTL_MINUTES = parseInt(process.env.AGENT_PASSWORD_RESET_TTL_MINUTES || '60', 10);
const MAX_ATTEMPTS    = parseInt(process.env.LOGIN_MAX_ATTEMPTS    || '5',  10);
const LOCKOUT_MINUTES = parseInt(process.env.LOGIN_LOCKOUT_MINUTES || '15', 10);

// ── Legacy env-admin: lazy bcrypt hash cached per process lifetime ────────────
// ADMIN_PASSWORD in .env is plain text for ease of config; we hash it once at
// first use so subsequent compares use constant-time bcrypt.compare.
let _cachedAdminPasswordHash = null;
async function getAdminPasswordHash() {
  if (!_cachedAdminPasswordHash && process.env.ADMIN_PASSWORD) {
    _cachedAdminPasswordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  }
  return _cachedAdminPasswordHash;
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function issueRefreshToken(adminUserId) {
  const raw  = crypto.randomBytes(40).toString('hex');
  const hash = hashToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL * 1000);
  await prisma.refreshToken.create({ data: { adminUserId, tokenHash: hash, expiresAt } });
  return raw;
}

function signAccess(payload, secret, tabId = null) {
  const jti = crypto.randomBytes(16).toString('hex');
  const payloadWithTab = { ...payload, jti };
  if (tabId) payloadWithTab.tabId = tabId;
  return {
    token: jwt.sign(payloadWithTab, secret, { expiresIn: ACCESS_TTL }),
    jti,
    tabId,
  };
}

function signLegacyRefresh(secret, email) {
  return jwt.sign(
    {
      sub: 'admin',
      email,
      typ: 'refresh',
      jti: crypto.randomBytes(16).toString('hex'),
    },
    secret,
    { expiresIn: REFRESH_TTL },
  );
}

function shouldExposeAgentResetToken() {
  return process.env.EXPOSE_AGENT_RESET_TOKEN === 'true' || process.env.NODE_ENV !== 'production';
}

async function buildAgentResetUrl(tenantId, rawToken) {
  const path = `/agente/reset-password?token=${encodeURIComponent(rawToken)}`;
  const emailSettings = tenantId ? await db.getEmailSettings(tenantId) : null;
  const origin = String(
    emailSettings?.adminBaseUrl
    || process.env.AGENT_PORTAL_BASE_URL
    || process.env.ADMIN_BASE_URL
    || process.env.CUSTOMER_PORTAL_BASE_URL
    || ''
  ).trim().replace(/\/$/, '');
  return origin ? `${origin}${path}` : path;
}

function normalizeWhatsappRecipient(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits || null;
}

function verifyLegacyRefresh(token, secret) {
  try {
    const payload = jwt.verify(token, secret);
    if (payload?.sub !== 'admin' || payload?.typ !== 'refresh') return null;
    return payload;
  } catch {
    return null;
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isConfiguredEnvAdminEmail(email) {
  const configured = normalizeEmail(process.env.ADMIN_EMAIL);
  return Boolean(configured && normalizeEmail(email) === configured);
}

async function findAdminUserByEmailCaseInsensitive(email) {
  return prisma.adminUser.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  });
}

async function findAgentByTenantAndEmailCaseInsensitive(tenantSlug, email) {
  return prisma.agente.findFirst({
    where: {
      tenant: { slug: tenantSlug },
      email: { equals: email, mode: 'insensitive' },
    },
    include: {
      tenant: { select: { id: true, slug: true, nombre: true } },
      puesto: { select: { id: true, nombre: true } },
    },
  });
}

async function findAgentsByEmailCaseInsensitive(email) {
  return prisma.agente.findMany({
    where: {
      email: { equals: email, mode: 'insensitive' },
      estado: 'activo',
    },
    include: {
      tenant: { select: { id: true, slug: true, nombre: true } },
      puesto: { select: { id: true, nombre: true } },
    },
  });
}

async function createAgentPasswordReset(agent) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + AGENT_PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

  await prisma.agentPasswordReset.updateMany({
    where: {
      agenteId: agent.id,
      usedAt: null,
    },
    data: { usedAt: new Date() },
  });

  await prisma.agentPasswordReset.create({
    data: {
      agenteId: agent.id,
      tokenHash,
      expiresAt,
    },
  });

  return {
    rawToken,
    expiresAt,
  };
}

function normalizeGraphBaseUrl() {
  return (process.env.FACEBOOK_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '');
}

async function validateFacebookToken(fbAccessToken) {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;

  if (!appId || !appSecret) {
    const err = new Error('Facebook auth is not configured');
    err.status = 503;
    throw err;
  }

  if (typeof fetch !== 'function') {
    const err = new Error('Fetch API unavailable in current runtime');
    err.status = 503;
    throw err;
  }

  const graphBase = normalizeGraphBaseUrl();
  const version = process.env.FACEBOOK_GRAPH_VERSION || 'v25.0';
  const appAccessToken = `${appId}|${appSecret}`;

  const debugUrl = new URL(`${graphBase}/${version}/debug_token`);
  debugUrl.searchParams.set('input_token', fbAccessToken);
  debugUrl.searchParams.set('access_token', appAccessToken);

  const debugRes = await fetch(debugUrl.toString());
  const debugJson = await debugRes.json().catch(() => ({}));

  if (!debugRes.ok || !debugJson?.data?.is_valid) {
    const err = new Error('Invalid Facebook token');
    err.status = 401;
    throw err;
  }

  if (String(debugJson.data.app_id) !== String(appId)) {
    const err = new Error('Facebook token app mismatch');
    err.status = 401;
    throw err;
  }

  const meUrl = new URL(`${graphBase}/${version}/me`);
  meUrl.searchParams.set('fields', 'id,name,email');
  meUrl.searchParams.set('access_token', fbAccessToken);

  const meRes = await fetch(meUrl.toString());
  const meJson = await meRes.json().catch(() => ({}));

  if (!meRes.ok || !meJson?.id) {
    const err = new Error('Failed to fetch Facebook profile');
    err.status = 401;
    throw err;
  }

  return {
    facebookId: String(meJson.id),
    email: meJson.email ? String(meJson.email).toLowerCase().trim() : null,
    name: meJson.name || null,
  };
}

// ── Rate limiter: 5 login attempts per IP per 15 min ─────────────────────────
const loginRateLimiter = rateLimit({
  windowMs: LOCKOUT_MINUTES * 60 * 1000,
  max: MAX_ATTEMPTS + 1, // +1 so account lockout can trigger before IP block
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
  handler: (_req, res) =>
    res.status(429).json({ error: 'Too many login attempts. Try again later.' }),
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', loginRateLimiter, async (req, res) => {
  const rawEmail = req.body?.email;
  const password = req.body?.password;
  const tabId = (req.headers['x-tab-id'] || req.body?.tabId || '').trim();
  const email = normalizeEmail(rawEmail);
  const jwtSecret = process.env.JWT_SECRET;
  const ip        = req.ip;
  const userAgent = req.headers['user-agent'] || '';

  if (!jwtSecret) return res.status(503).json({ error: 'JWT_SECRET not configured' });
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (!tabId) return res.status(400).json({ error: 'tabId is required' });

  // 1. Env-var super admin (legacy) — bcrypt compare against cached hash
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  const adminPasswordHash = await getAdminPasswordHash();
  if (adminEmail && adminPasswordHash && email === adminEmail) {
    const valid = await bcrypt.compare(password, adminPasswordHash);
    if (valid) {
      const envAdminEmail = process.env.ADMIN_EMAIL;
      const { token } = signAccess({ sub: 'admin', email: envAdminEmail }, jwtSecret, tabId);
      const refreshToken = signLegacyRefresh(jwtSecret, envAdminEmail);
      audit({ accion: 'LOGIN', entidad: 'admin', ip, userAgent, metadata: { email: envAdminEmail, via: 'env', tabId } });
      return res.json({ accessToken: token, refreshToken, expiresIn: ACCESS_TTL, superAdmin: true });
    }
  }

  // 2. DB-backed admin user
  try {
    const user = await findAdminUserByEmailCaseInsensitive(email);

    // Get tenant-specific lockout policy (or defaults)
    const policy = await lockoutPolicy.getPolicy(user?.tenantId || null);
    const MAX_ATTEMPTS_POLICY = policy.maxAttempts;
    const LOCKOUT_MINUTES_POLICY = policy.lockoutMinutes;

    // Generic invalid-credentials response (timing-safe: always run bcrypt)
    const dummyHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const passwordToCheck = user ? user.passwordHash : dummyHash;
    const valid = await bcrypt.compare(password, passwordToCheck);

    if (!user || !valid) {
      // Increment failedAttempts and maybe lock the account
      if (user) {
        const newAttempts = user.failedAttempts + 1;
        const lockedUntil = newAttempts >= MAX_ATTEMPTS_POLICY
          ? new Date(Date.now() + LOCKOUT_MINUTES_POLICY * 60 * 1000)
          : null;
        await prisma.adminUser.update({
          where: { id: user.id },
          data: { failedAttempts: newAttempts, ...(lockedUntil ? { lockedUntil } : {}) },
        });
      }
      audit({ accion: 'LOGIN_FAILED', entidad: 'admin_user', ip, userAgent, metadata: { email } });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check account lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      audit({ accion: 'LOGIN_BLOCKED', entidad: 'admin_user', ip, userAgent, metadata: { email } });
      return res.status(423).json({ error: 'Account temporarily locked. Try again later.' });
    }

    // Success — reset lockout counters
    await prisma.adminUser.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });

    // Generate device fingerprint and track device session (Phase 2 enhancement)
    const deviceFingerprint = generateDeviceFingerprint(userAgent, ip);
    const deviceName = parseDeviceNameFromUserAgent(userAgent);

    try {
      await storeAdminDeviceSession(user.id, deviceFingerprint, deviceName, userAgent, ip);
    } catch (deviceError) {
      // Don't block login if device tracking fails
      console.error('[AdminAuth] Device tracking error:', deviceError);
    }

    const effectiveSuperAdmin = Boolean(user.superAdmin || isConfiguredEnvAdminEmail(user.email));

    const { token: accessToken } = signAccess(
      { adminUserId: user.id, email: user.email, superAdmin: effectiveSuperAdmin, tenantId: user.tenantId ?? null },
      jwtSecret,
      tabId,
    );
    const refreshToken = await issueRefreshToken(user.id);

    audit({ adminUserId: user.id, tenantId: user.tenantId, accion: 'LOGIN', entidad: 'admin_user', entidadId: user.id, ip, userAgent, metadata: { tabId } });
    return res.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL, superAdmin: effectiveSuperAdmin });
  } catch (err) {
    return res.status(500).json({ error: 'Auth error' });
  }
});

// ── POST /auth/facebook ──────────────────────────────────────────────────────
router.post('/facebook', loginRateLimiter, async (req, res) => {
  const { accessToken } = req.body;
  const jwtSecret = process.env.JWT_SECRET;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'] || '';

  if (!jwtSecret) return res.status(503).json({ error: 'JWT_SECRET not configured' });
  if (!accessToken || typeof accessToken !== 'string') {
    return res.status(400).json({ error: 'accessToken is required' });
  }

  try {
    const profile = await validateFacebookToken(accessToken);

    if (!profile.email) {
      return res.status(400).json({ error: 'Facebook account has no email available' });
    }

    const user = await findAdminUserByEmailCaseInsensitive(profile.email);
    if (!user) {
      audit({ accion: 'LOGIN_FAILED', entidad: 'admin_user', ip, userAgent, metadata: { via: 'facebook', email: profile.email } });
      return res.status(403).json({ error: 'No admin account is linked to this Facebook email' });
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      audit({ adminUserId: user.id, tenantId: user.tenantId, accion: 'LOGIN_BLOCKED', entidad: 'admin_user', entidadId: String(user.id), ip, userAgent, metadata: { via: 'facebook' } });
      return res.status(423).json({ error: 'Account temporarily locked. Try again later.' });
    }

    await prisma.adminUser.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });

    const effectiveSuperAdmin = Boolean(user.superAdmin || isConfiguredEnvAdminEmail(user.email));

    const { token: accessTokenJwt } = signAccess(
      { adminUserId: user.id, email: user.email, superAdmin: effectiveSuperAdmin, tenantId: user.tenantId ?? null },
      jwtSecret,
    );
    const refreshToken = await issueRefreshToken(user.id);

    audit({
      adminUserId: user.id,
      tenantId: user.tenantId,
      accion: 'LOGIN',
      entidad: 'admin_user',
      entidadId: String(user.id),
      ip,
      userAgent,
      metadata: { via: 'facebook', facebookId: profile.facebookId },
    });

    return res.json({ accessToken: accessTokenJwt, refreshToken, expiresIn: ACCESS_TTL, superAdmin: effectiveSuperAdmin });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      return res.status(500).json({ error: 'Facebook auth failed' });
    }
    return res.status(status).json({ error: err.message || 'Facebook auth failed' });
  }
});

// ── POST /auth/google ─────────────────────────────────────────────────────────
async function validateGoogleToken(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    const err = new Error('Google auth is not configured');
    err.status = 503;
    throw err;
  }

  if (typeof fetch !== 'function') {
    const err = new Error('Fetch API unavailable in current runtime');
    err.status = 503;
    throw err;
  }

  const url = new URL('https://oauth2.googleapis.com/tokeninfo');
  url.searchParams.set('id_token', idToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = new Error('Invalid Google token');
    err.status = 401;
    throw err;
  }

  const data = await res.json();

  if (data.aud !== clientId) {
    const err = new Error('Google token audience mismatch');
    err.status = 401;
    throw err;
  }

  if (data.email_verified !== 'true' && data.email_verified !== true) {
    const err = new Error('Google email not verified');
    err.status = 400;
    throw err;
  }

  return { email: data.email, googleId: data.sub };
}

router.post('/google', loginRateLimiter, async (req, res) => {
  const { credential } = req.body;
  const jwtSecret = process.env.JWT_SECRET;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'] || '';

  if (!jwtSecret) return res.status(503).json({ error: 'JWT_SECRET not configured' });
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ error: 'credential is required' });
  }

  try {
    const profile = await validateGoogleToken(credential);

    const user = await findAdminUserByEmailCaseInsensitive(profile.email);
    if (!user) {
      audit({ accion: 'LOGIN_FAILED', entidad: 'admin_user', ip, userAgent, metadata: { via: 'google', email: profile.email } });
      return res.status(403).json({ error: 'No admin account is linked to this Google email' });
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      audit({ adminUserId: user.id, tenantId: user.tenantId, accion: 'LOGIN_BLOCKED', entidad: 'admin_user', entidadId: String(user.id), ip, userAgent, metadata: { via: 'google' } });
      return res.status(423).json({ error: 'Account temporarily locked. Try again later.' });
    }

    await prisma.adminUser.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });

    const effectiveSuperAdmin = Boolean(user.superAdmin || isConfiguredEnvAdminEmail(user.email));

    const { token: accessToken } = signAccess(
      { adminUserId: user.id, email: user.email, superAdmin: effectiveSuperAdmin, tenantId: user.tenantId ?? null },
      jwtSecret,
    );
    const refreshToken = await issueRefreshToken(user.id);

    audit({
      adminUserId: user.id,
      tenantId: user.tenantId,
      accion: 'LOGIN',
      entidad: 'admin_user',
      entidadId: String(user.id),
      ip,
      userAgent,
      metadata: { via: 'google', googleId: profile.googleId },
    });

    return res.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL, superAdmin: effectiveSuperAdmin });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      return res.status(500).json({ error: 'Google auth failed' });
    }
    return res.status(status).json({ error: err.message || 'Google auth failed' });
  }
});

// ── POST /auth/agent/login ───────────────────────────────────────────────────
// Login with email + password only. If multiple accounts exist, returns tenant options.
router.post('/agent/login', loginRateLimiter, async (req, res) => {
  const password = req.body?.password;
  const email = normalizeEmail(req.body?.email);
  const tabId = (req.headers['x-tab-id'] || req.body?.tabId || '').trim();
  const jwtSecret = process.env.JWT_SECRET;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'] || '';

  if (!jwtSecret) return res.status(503).json({ error: 'JWT_SECRET not configured' });
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (!tabId) {
    return res.status(400).json({ error: 'tabId is required' });
  }

  try {
    // Find all agents with this email across all active tenants
    const agents = await findAgentsByEmailCaseInsensitive(email);
    
    if (agents.length === 0) {
      audit({ accion: 'LOGIN_FAILED', entidad: 'agente', ip, userAgent, metadata: { email, tabId, reason: 'no_agents' } });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password against all agent accounts
    const dummyHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    let validAgent = null;

    for (const agent of agents) {
      const passwordToCheck = agent.passwordHash || dummyHash;
      const valid = await bcrypt.compare(password, passwordToCheck);
      if (agent.passwordHash && valid) {
        validAgent = agent;
        break;
      }
    }

    if (!validAgent) {
      audit({ accion: 'LOGIN_FAILED', entidad: 'agente', ip, userAgent, metadata: { email, tabId, reason: 'invalid_password' } });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // If only one account, complete login immediately
    if (agents.length === 1) {
      await prisma.agente.update({
        where: { id: validAgent.id },
        data: { lastSeenAt: new Date() },
      });

      try {
        const deviceFingerprint = generateDeviceFingerprint(userAgent, ip);
        const deviceName = parseDeviceNameFromUserAgent(userAgent);
        const existingSession = await prisma.agentDeviceSession.findFirst({
          where: { agenteId: validAgent.id, deviceFingerprint },
        });
        await storeAgentDeviceSession(validAgent.id, deviceFingerprint, deviceName, userAgent, ip);
        if (!existingSession) {
          await logSuspiciousActivity({
            agenteId: validAgent.id,
            activityType: ACTIVITY_TYPES.NEW_DEVICE_LOGIN,
            severity: SEVERITY_LEVELS.LOW,
            description: `Agent logged in from new device: ${deviceName}`,
            deviceFingerprint,
            ipAddress: ip,
            userAgent,
            metadata: { email, deviceName },
          });
        }
      } catch (deviceError) {
        console.error('[AgentAuth] Device tracking error:', deviceError);
      }

      const { token: accessToken } = signAccess(
        { sub: 'agent', agenteId: validAgent.id, tenantId: validAgent.tenantId, tenantSlug: validAgent.tenant.slug, email: validAgent.email },
        jwtSecret,
        tabId,
      );

      audit({
        accion: 'LOGIN',
        entidad: 'agente',
        entidadId: String(validAgent.id),
        tenantId: validAgent.tenantId,
        ip,
        userAgent,
        metadata: { tenantSlug: validAgent.tenant.slug, email: validAgent.email, tabId },
      });

      return res.json({
        accessToken,
        expiresIn: ACCESS_TTL,
        profile: {
          agenteId: validAgent.id,
          tenantId: validAgent.tenantId,
          tenantSlug: validAgent.tenant.slug,
          tenantNombre: validAgent.tenant.nombre,
          nombre: validAgent.nombre,
          email: validAgent.email,
          whatsapp: validAgent.whatsapp,
          estado: validAgent.estado,
          puesto: validAgent.puesto,
          calendarLink: validAgent.calendarLink,
          lastSeenAt: new Date().toISOString(),
        },
      });
    }

    // If multiple accounts, return tenant selection options
    const tenants = agents.map((agent) => ({
      tenantId: agent.tenantId,
      tenantSlug: agent.tenant.slug,
      tenantNombre: agent.tenant.nombre,
      agenteId: agent.id,
    }));

    audit({
      accion: 'LOGIN_TENANT_SELECTION',
      entidad: 'agente',
      ip,
      userAgent,
      metadata: { email, tabId, tenantsCount: tenants.length },
    });

    return res.status(200).json({
      requiresTenantSelection: true,
      email: email,
      tenants,
    });
  } catch (err) {
    console.error('[AgentAuth] Error:', err);
    return res.status(500).json({ error: 'Agent auth error' });
  }
});

// ── POST /auth/agent/login/with-tenant ───────────────────────────────────────
// Complete login after tenant selection (called when user picks from multi-tenant options)
router.post('/agent/login/with-tenant', loginRateLimiter, async (req, res) => {
  const tenantSlug = String(req.body?.tenantSlug ?? '').trim().toLowerCase();
  const password = req.body?.password;
  const email = normalizeEmail(req.body?.email);
  const tabId = (req.headers['x-tab-id'] || req.body?.tabId || '').trim();
  const jwtSecret = process.env.JWT_SECRET;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'] || '';

  if (!jwtSecret) return res.status(503).json({ error: 'JWT_SECRET not configured' });
  if (!tenantSlug || !email || !password) {
    return res.status(400).json({ error: 'tenantSlug, email and password are required' });
  }
  if (!tabId) {
    return res.status(400).json({ error: 'tabId is required' });
  }

  try {
    // Find agent in specific tenant
    const agent = await findAgentByTenantAndEmailCaseInsensitive(tenantSlug, email);
    const dummyHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const passwordToCheck = agent?.passwordHash || dummyHash;
    const valid = await bcrypt.compare(password, passwordToCheck);

    if (!agent || !agent.passwordHash || !valid) {
      audit({ accion: 'LOGIN_FAILED', entidad: 'agente', ip, userAgent, metadata: { tenantSlug, email, tabId } });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (agent.estado !== 'activo') {
      audit({ accion: 'LOGIN_BLOCKED', entidad: 'agente', entidadId: String(agent.id), ip, userAgent, metadata: { tenantSlug, email, reason: 'inactive', tabId } });
      return res.status(403).json({ error: 'Agent account is inactive' });
    }

    await prisma.agente.update({
      where: { id: agent.id },
      data: { lastSeenAt: new Date() },
    });

    try {
      const deviceFingerprint = generateDeviceFingerprint(userAgent, ip);
      const deviceName = parseDeviceNameFromUserAgent(userAgent);
      const existingSession = await prisma.agentDeviceSession.findFirst({
        where: { agenteId: agent.id, deviceFingerprint },
      });
      await storeAgentDeviceSession(agent.id, deviceFingerprint, deviceName, userAgent, ip);
      if (!existingSession) {
        await logSuspiciousActivity({
          agenteId: agent.id,
          activityType: ACTIVITY_TYPES.NEW_DEVICE_LOGIN,
          severity: SEVERITY_LEVELS.LOW,
          description: `Agent logged in from new device: ${deviceName}`,
          deviceFingerprint,
          ipAddress: ip,
          userAgent,
          metadata: { tenantSlug, email, deviceName },
        });
      }
    } catch (deviceError) {
      console.error('[AgentAuth] Device tracking error:', deviceError);
    }

    const { token: accessToken } = signAccess(
      { sub: 'agent', agenteId: agent.id, tenantId: agent.tenantId, tenantSlug: agent.tenant.slug, email: agent.email },
      jwtSecret,
      tabId,
    );

    audit({
      accion: 'LOGIN',
      entidad: 'agente',
      entidadId: String(agent.id),
      tenantId: agent.tenantId,
      ip,
      userAgent,
      metadata: { tenantSlug: agent.tenant.slug, email: agent.email, tabId },
    });

    return res.json({
      accessToken,
      expiresIn: ACCESS_TTL,
      profile: {
        agenteId: agent.id,
        tenantId: agent.tenantId,
        tenantSlug: agent.tenant.slug,
        tenantNombre: agent.tenant.nombre,
        nombre: agent.nombre,
        email: agent.email,
        whatsapp: agent.whatsapp,
        estado: agent.estado,
        puesto: agent.puesto,
        calendarLink: agent.calendarLink,
        lastSeenAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[AgentAuth] Error:', err);
    return res.status(500).json({ error: 'Agent auth error' });
  }
});

// ── POST /auth/agent/forgot-password ─────────────────────────────────────────
router.post('/agent/forgot-password', loginRateLimiter, async (req, res) => {
  const tenantSlug = String(req.body?.tenantSlug ?? '').trim().toLowerCase();
  const email = normalizeEmail(req.body?.email);
  const ip = req.ip;
  const userAgent = req.headers['user-agent'] || '';

  if (!tenantSlug || !email) {
    return res.status(400).json({ error: 'tenantSlug and email are required' });
  }

  try {
    const agent = await findAgentByTenantAndEmailCaseInsensitive(tenantSlug, email);
    if (!agent || !agent.passwordHash || agent.estado !== 'activo') {
      audit({ accion: 'PASSWORD_RESET_REQUEST', entidad: 'agente', ip, userAgent, metadata: { tenantSlug, email, delivered: false } });
      return res.json({ message: 'Si el agente existe y tiene acceso habilitado, se generó un enlace de recuperación.' });
    }

    const { rawToken, expiresAt } = await createAgentPasswordReset(agent);
    const response = {
      message: 'Si el agente existe y tiene acceso habilitado, se generó un enlace de recuperación.',
    };

    const resetUrl = await buildAgentResetUrl(agent.tenantId, rawToken);
    const deliveryChannels = [];

    try {
      await sendEmail({
        to: agent.email,
        subject: `Recuperacion de acceso para ${agent.tenant?.nombre || agent.tenant?.slug || tenantSlug}`,
        text: [
          `Hola ${agent.nombre || 'agente'},`,
          '',
          'Recibimos una solicitud para restablecer tu contrasena de acceso.',
          `Usa este enlace: ${resetUrl}`,
          `Este enlace vence el ${expiresAt.toISOString()}.`,
          '',
          'Si no solicitaste este cambio, ignora este mensaje.',
        ].join('\n'),
        html: [
          `<p>Hola ${agent.nombre || 'agente'},</p>`,
          '<p>Recibimos una solicitud para restablecer tu contrasena de acceso.</p>',
          `<p><a href="${resetUrl}">Abrir enlace de recuperacion</a></p>`,
          `<p>Este enlace vence el <strong>${expiresAt.toISOString()}</strong>.</p>`,
          '<p>Si no solicitaste este cambio, ignora este mensaje.</p>',
        ].join(''),
        tenantId: agent.tenantId,
        metadata: {
          route: 'auth/agent/forgot-password',
          tenantSlug,
          agenteId: agent.id,
        },
      });
      deliveryChannels.push('email');
    } catch (err) {
      if (err instanceof EmailServiceError) {
        logger.warn({ tenantSlug, email, code: err.code, message: err.message }, 'auth.agent.forgotPassword: email delivery unavailable');
      } else {
        logger.warn({ tenantSlug, email, message: err.message }, 'auth.agent.forgotPassword: email delivery failed');
      }
    }

    const whatsappRecipient = normalizeWhatsappRecipient(agent.whatsapp);
    if (whatsappRecipient) {
      try {
        const { phoneNumberId, accessToken } = await db.getWaCredentials(agent.tenantId);
        if (phoneNumberId && accessToken) {
          await wa.sendTextMessage(
            phoneNumberId,
            whatsappRecipient,
            [
              `Hola ${agent.nombre || 'agente'}.`,
              'Recibimos una solicitud para restablecer tu contrasena de acceso.',
              `Abri este enlace: ${resetUrl}`,
              `Vence: ${expiresAt.toISOString()}.`,
              'Si no solicitaste este cambio, ignora este mensaje.',
            ].join(' '),
            accessToken,
          );
          deliveryChannels.push('whatsapp');
        }
      } catch (err) {
        logger.warn({ tenantSlug, email, whatsapp: agent.whatsapp, message: err.message }, 'auth.agent.forgotPassword: whatsapp delivery failed');
      }
    }

    response.deliveryChannels = deliveryChannels;

    if (shouldExposeAgentResetToken()) {
      response.resetToken = rawToken;
      response.resetUrl = resetUrl;
      response.expiresAt = expiresAt.toISOString();
    }

    audit({ accion: 'PASSWORD_RESET_REQUEST', entidad: 'agente', entidadId: String(agent.id), tenantId: agent.tenantId, ip, userAgent, metadata: { tenantSlug, email, delivered: deliveryChannels.length > 0, channels: deliveryChannels } });
    return res.json(response);
  } catch {
    return res.status(500).json({ error: 'Agent password reset request failed' });
  }
});

// ── POST /auth/agent/reset-password ──────────────────────────────────────────
router.post('/agent/reset-password', async (req, res) => {
  const token = String(req.body?.token ?? '').trim();
  const password = String(req.body?.password ?? '');
  const ip = req.ip;
  const userAgent = req.headers['user-agent'] || '';

  if (!token || !password) {
    return res.status(400).json({ error: 'token and password are required' });
  }
  if (password.trim().length < 8) {
    return res.status(400).json({ error: 'password must contain at least 8 characters' });
  }

  try {
    const tokenHash = hashToken(token);
    const reset = await prisma.agentPasswordReset.findUnique({
      where: { tokenHash },
      include: {
        agente: {
          include: {
            tenant: { select: { slug: true } },
          },
        },
      },
    });

    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }
    if (reset.agente.estado !== 'activo') {
      return res.status(403).json({ error: 'Agent account is inactive' });
    }

    const passwordHash = await bcrypt.hash(password.trim(), 12);
    await prisma.$transaction([
      prisma.agente.update({
        where: { id: reset.agenteId },
        data: { passwordHash, lastSeenAt: new Date() },
      }),
      prisma.agentPasswordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      }),
    ]);

    audit({
      accion: 'PASSWORD_RESET',
      entidad: 'agente',
      entidadId: String(reset.agenteId),
      tenantId: reset.agente.tenantId,
      ip,
      userAgent,
      metadata: { tenantSlug: reset.agente.tenant?.slug ?? null, email: reset.agente.email },
    });

    return res.json({ message: 'Password updated successfully' });
  } catch {
    return res.status(500).json({ error: 'Agent password reset failed' });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) return res.status(503).json({ error: 'JWT_SECRET not configured' });

  try {
    const hash = hashToken(refreshToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      include: { adminUser: true },
    });

    if (stored && !stored.revoked && stored.expiresAt >= new Date()) {
      const user = stored.adminUser;
      const effectiveSuperAdmin = Boolean(user.superAdmin || isConfiguredEnvAdminEmail(user.email));

      const { token: accessToken } = signAccess(
        { adminUserId: user.id, email: user.email, superAdmin: effectiveSuperAdmin, tenantId: user.tenantId ?? null },
        jwtSecret,
      );

      return res.json({ accessToken, expiresIn: ACCESS_TTL });
    }

    // Legacy env-admin refresh token path (for super-admin defined in .env).
    const legacyPayload = verifyLegacyRefresh(refreshToken, jwtSecret);
    if (legacyPayload) {
      const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
      if (!adminEmail || normalizeEmail(legacyPayload.email) !== adminEmail) {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }

      const { token: accessToken } = signAccess(
        { sub: 'admin', email: legacyPayload.email },
        jwtSecret,
      );
      return res.json({ accessToken, expiresIn: ACCESS_TTL });
    }

    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  } catch (err) {
    return res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────
router.get('/me', requireJwt, async (req, res) => {
  const admin = req.admin || {};
  return res.json({
    adminUserId: admin.adminUserId ?? null,
    email: admin.email ?? null,
    nombre: admin.nombre ?? null,
    tenantId: admin.tenantId ?? null,
    tenantSlug: null,
    superAdmin: Boolean(admin.superAdmin),
    permissions: Array.isArray(admin.permissions) ? admin.permissions : [],
  });
});

// ── GET /auth/agent/me ───────────────────────────────────────────────────────
router.get('/agent/me', requireAgentJwt, async (req, res) => {
  const agent = req.agent || {};
  return res.json({
    agenteId: agent.agenteId ?? null,
    tenantId: agent.tenantId ?? null,
    tenantSlug: agent.tenantSlug ?? null,
    tenantNombre: agent.tenantNombre ?? null,
    nombre: agent.nombre ?? null,
    email: agent.email ?? null,
    whatsapp: agent.whatsapp ?? null,
    estado: agent.estado ?? null,
    puesto: agent.puesto ?? null,
    calendarLink: agent.calendarLink ?? null,
    lastSeenAt: agent.lastSeenAt ?? null,
  });
});

// ── GET /auth/agent/kpis ─────────────────────────────────────────────────────
router.get('/agent/kpis', requireAgentJwt, async (req, res, next) => {
  try {
    const tenantId = req.agent?.tenantId;
    const agenteId = Number(req.agent?.agenteId);
    if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) {
      return res.status(400).json({ error: 'Invalid agent context' });
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const activeSolicitudStates = ['open', 'in_progress', 'pending_info'];

    const [
      solicitudesActivas,
      solicitudesCompletadasMes,
      agendaProximos7Dias,
      agendaVencida,
    ] = await Promise.all([
      prisma.solicitud.count({
        where: {
          tenantId,
          agenteId,
          estado: { in: activeSolicitudStates },
        },
      }),
      prisma.solicitud.count({
        where: {
          tenantId,
          agenteId,
          completedAt: { gte: monthStart },
        },
      }),
      prisma.agendaEventAssignment.count({
        where: {
          agenteId,
          event: {
            tenantId,
            startAt: { gte: now, lte: weekAhead },
            estado: { notIn: ['cancelado', 'cancelled'] },
          },
        },
      }),
      prisma.agendaEventAssignment.count({
        where: {
          agenteId,
          event: {
            tenantId,
            endAt: { lt: now },
            estado: { in: ['pendiente'] },
          },
        },
      }),
    ]);

    return res.json({
      solicitudesActivas,
      solicitudesCompletadasMes,
      agendaProximos7Dias,
      agendaVencida,
      lastSeenAt: req.agent?.lastSeenAt ?? null,
    });
  } catch (err) {
    return next(err);
  }
});

// ── GET /auth/agent/solicitudes ─────────────────────────────────────────────
router.get('/agent/solicitudes', requireAgentJwt, async (req, res, next) => {
  try {
    const tenantId = req.agent?.tenantId;
    const agenteId = Number(req.agent?.agenteId);
    if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) {
      return res.status(400).json({ error: 'Invalid agent context' });
    }

    const status = String(req.query.status || 'assigned').trim().toLowerCase();
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const where = { tenantId, agenteId };
    if (status === 'completed') {
      where.estado = 'completed';
    } else {
      where.estado = { in: ['open', 'in_progress', 'pending_info'] };
    }

    const [total, data] = await Promise.all([
      prisma.solicitud.count({ where }),
      prisma.solicitud.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        select: {
          id: true,
          titulo: true,
          nombre: true,
          telefonoContacto: true,
          estado: true,
          prioridad: true,
          categoria: true,
          subcategoria: true,
          dueAt: true,
          firstResponseAt: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          user: { select: { id: true, phone: true } },
          conversation: { select: { id: true, status: true, startedAt: true, endedAt: true } },
        },
      }),
    ]);

    return res.json({ page, limit, total, status, data });
  } catch (err) {
    return next(err);
  }
});

// ── GET /auth/agent/conversations ───────────────────────────────────────────
router.get('/agent/conversations', requireAgentJwt, async (req, res, next) => {
  try {
    const tenantId = req.agent?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Invalid agent context' });
    }

    const userKey = String(req.query.userKey || '').trim();
    if (!userKey) {
      return res.status(400).json({ error: 'userKey is required' });
    }

    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const where = { tenantId, userKey };

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { startedAt: 'desc' },
        include: {
          flow: { select: { id: true, nombre: true } },
          _count: { select: { events: true } },
          solicitudes: {
            select: {
              id: true,
              titulo: true,
              estado: true,
              prioridad: true,
              origin: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      prisma.conversation.count({ where }),
    ]);

    const data = conversations.map((c) => ({
      id: c.id,
      userKey: c.userKey,
      flow: c.flow ? { id: c.flow.id, nombre: c.flow.nombre } : null,
      flowVersionId: c.flowVersionId,
      status: c.status,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      durationSec: c.endedAt
        ? Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000)
        : null,
      eventCount: c._count.events,
      solicitudes: c.solicitudes,
    }));

    return res.json({ data, total, page, limit });
  } catch (err) {
    return next(err);
  }
});

// ── PATCH /auth/agent/solicitudes/:id ──────────────────────────────────────
router.patch('/agent/solicitudes/:id', requireAgentJwt, async (req, res, next) => {
  try {
    const tenantId = req.agent?.tenantId;
    const agenteId = Number(req.agent?.agenteId);
    const solicitudId = Number(req.params.id);
    if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) {
      return res.status(400).json({ error: 'Invalid agent context' });
    }
    if (!Number.isInteger(solicitudId) || solicitudId <= 0) {
      return res.status(400).json({ error: 'Invalid solicitud id' });
    }

    const solicitud = await db.getSolicitudById(solicitudId, tenantId);
    if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });
    if (Number(solicitud.agenteId || 0) !== agenteId) {
      return res.status(403).json({ error: 'Solicitud is not assigned to this agent' });
    }

    const allowedFields = [
      'estado',
      'prioridad',
      'categoria',
      'subcategoria',
      'followUpDate',
      'dueAt',
      'resolutionNotes',
      'customerNotes',
    ];

    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        updates[key] = req.body[key];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    if (updates.estado !== undefined) {
      const normalizedEstado = db.normalizeSolicitudStatus(updates.estado, '');
      if (!normalizedEstado || !Object.values(db.SOLICITUD_STATUS).includes(normalizedEstado)) {
        return res.status(400).json({ error: 'estado is invalid' });
      }
      updates.estado = normalizedEstado;
    }

    const updated = await db.updateSolicitudFields(
      solicitudId,
      tenantId,
      {
        ...updates,
        __actorType: 'agente',
        __actorAgenteId: agenteId,
        __markFirstResponseAt: true,
      },
      null,
    );

    if (!updated) return res.status(404).json({ error: 'Solicitud not found' });

    audit({
      adminUserId: null,
      tenantId,
      accion: 'AGENT_UPDATE_SOLICITUD',
      entidad: 'solicitud',
      entidadId: String(solicitudId),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { agenteId, fields: Object.keys(updates) },
    });

    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

// ── GET /auth/agent/solicitudes/:id/messages ──────────────────────────────
router.get('/agent/solicitudes/:id/messages', requireAgentJwt, async (req, res, next) => {
  try {
    const tenantId = req.agent?.tenantId;
    const agenteId = Number(req.agent?.agenteId);
    const solicitudId = Number(req.params.id);
    if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) {
      return res.status(400).json({ error: 'Invalid agent context' });
    }
    if (!Number.isInteger(solicitudId) || solicitudId <= 0) {
      return res.status(400).json({ error: 'Invalid solicitud id' });
    }

    const solicitud = await db.getSolicitudMessagingContext(solicitudId, tenantId);
    if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });
    if (Number(solicitud.agenteId || 0) !== agenteId) {
      return res.status(403).json({ error: 'Solicitud is not assigned to this agent' });
    }

    const result = await db.listMensajesBySolicitud({
      solicitudId,
      tenantId,
      page: req.query?.page,
      limit: req.query?.limit,
      q: req.query?.q,
      direccion: req.query?.direccion,
      start: req.query?.start,
      end: req.query?.end,
      lectura: req.query?.lectura,
    });
    if (!result) return res.status(404).json({ error: 'Solicitud not found' });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// ── POST /auth/agent/solicitudes/:id/messages ─────────────────────────────
router.post('/agent/solicitudes/:id/messages', requireAgentJwt, async (req, res, next) => {
  try {
    const tenantId = req.agent?.tenantId;
    const agenteId = Number(req.agent?.agenteId);
    const solicitudId = Number(req.params.id);
    if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) {
      return res.status(400).json({ error: 'Invalid agent context' });
    }
    if (!Number.isInteger(solicitudId) || solicitudId <= 0) {
      return res.status(400).json({ error: 'Invalid solicitud id' });
    }

    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    const solicitud = await db.getSolicitudMessagingContext(solicitudId, tenantId);
    if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });
    if (Number(solicitud.agenteId || 0) !== agenteId) {
      return res.status(403).json({ error: 'Solicitud is not assigned to this agent' });
    }
    if (!solicitud.user?.phone) {
      return res.status(400).json({ error: 'Solicitud has no WhatsApp contact' });
    }

    const { phoneNumberId, accessToken } = await db.getWaCredentials(tenantId);
    if (!phoneNumberId || !accessToken) {
      return res.status(422).json({ error: 'WhatsApp credentials not configured for this tenant' });
    }

    const waResp = await wa.sendTextMessage(phoneNumberId, solicitud.user.phone, text, accessToken);
    const mensaje = await db.saveMensaje({
      tenantId,
      userId: solicitud.userId,
      waMsgId: waResp?.messages?.[0]?.id ?? null,
      direccion: 'salida',
      tipo: 'text',
      contenido: {
        text,
        source: 'agent_solicitud',
        solicitudId,
        actor: {
          type: 'agente',
          agenteId,
          nombre: req.agent?.nombre ?? null,
          email: req.agent?.email ?? null,
        },
      },
      conversationId: solicitud.conversationId || undefined,
    });

    audit({
      adminUserId: null,
      tenantId,
      accion: 'AGENT_SEND_SOLICITUD_MESSAGE',
      entidad: 'solicitud',
      entidadId: String(solicitudId),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { agenteId, mensajeId: mensaje?.id ?? null, waMsgId: mensaje?.waMsgId ?? null },
    });

    socketService.emit(tenantId, 'SOLICITUD_MESSAGE_SENT', {
      solicitudId,
      mensaje,
    });

    return res.status(201).json({
      ok: true,
      solicitudId,
      mensaje,
      waResponse: waResp,
    });
  } catch (err) {
    return next(err);
  }
});

// ── GET /auth/agent/agenda ──────────────────────────────────────────────────
router.get('/agent/agenda', requireAgentJwt, async (req, res, next) => {
  try {
    const tenantId = req.agent?.tenantId;
    const agenteId = Number(req.agent?.agenteId);
    if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) {
      return res.status(400).json({ error: 'Invalid agent context' });
    }

    const start = req.query.start ? new Date(String(req.query.start)) : null;
    const end = req.query.end ? new Date(String(req.query.end)) : null;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) {
      return res.status(400).json({ error: 'start/end must be valid ISO dates' });
    }

    const where = {
      tenantId,
      assignments: { some: { agenteId } },
    };
    if (req.query.estado) {
      where.estado = String(req.query.estado);
    }
    if (start || end) {
      where.startAt = {};
      if (start) where.startAt.gte = start;
      if (end) where.startAt.lte = end;
    }

    const data = await prisma.agendaEvent.findMany({
      where,
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      include: {
        assignments: {
          include: {
            agente: { select: { id: true, nombre: true, email: true, estado: true } },
          },
        },
      },
      take: 200,
    });

    return res.json({ total: data.length, data });
  } catch (err) {
    return next(err);
  }
});

// ── GET /auth/agent/contactos ───────────────────────────────────────────────
router.get('/agent/contactos', requireAgentJwt, async (req, res, next) => {
  try {
    const tenantId = req.agent?.tenantId;
    const agenteId = Number(req.agent?.agenteId);
    if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) {
      return res.status(400).json({ error: 'Invalid agent context' });
    }

    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '50'), 10) || 50));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      solicitudes: { some: { agenteId } },
    };

    if (q) {
      where.OR = [
        { nombre: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
        { empresa: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, data] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        select: {
          id: true,
          phone: true,
          nombre: true,
          email: true,
          empresa: true,
          cargo: true,
          canalOrigen: true,
          etiquetas: true,
          leadScore: true,
          ultimoContacto: true,
          createdAt: true,
          _count: {
            select: {
              solicitudes: { where: { agenteId } },
            },
          },
        },
      }),
    ]);

    return res.json({ page, limit, total, data });
  } catch (err) {
    return next(err);
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', requireJwt, async (req, res) => {
  const { refreshToken } = req.body;

  // Revoke refresh token if provided
  if (refreshToken) {
    try {
      const hash = hashToken(refreshToken);
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hash },
        data: { revoked: true },
      });
    } catch (_) { /* best effort */ }
  }

  // Blacklist the current access token in Redis (TTL = remaining seconds)
  try {
    const redis = getRedisClient();
    if (redis && req.admin._jti && req.admin._exp) {
      const ttl = req.admin._exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await redis.set(`jwt:bl:${req.admin._jti}`, '1', 'EX', ttl);
      }
    }
  } catch (_) { /* best effort */ }

  audit({ adminUserId: req.admin.adminUserId, tenantId: req.admin.tenantId, accion: 'LOGOUT', entidad: 'admin_user', ip: req.ip, userAgent: req.headers['user-agent'] });
  return res.json({ message: 'Logged out successfully' });
});

// ── POST /auth/agent/logout ──────────────────────────────────────────────────
router.post('/agent/logout', requireAgentJwt, async (req, res) => {
  try {
    const redis = getRedisClient();
    if (redis && req.agent._jti && req.agent._exp) {
      const ttl = req.agent._exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await redis.set(`jwt:bl:${req.agent._jti}`, '1', 'EX', ttl);
      }
    }
  } catch (_) { /* best effort */ }

  audit({
    accion: 'LOGOUT',
    entidad: 'agente',
    entidadId: String(req.agent.agenteId),
    tenantId: req.agent.tenantId,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  return res.json({ message: 'Logged out successfully' });
});

module.exports = router;
