'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const { audit } = require('../services/audit');
const { getRedisClient } = require('../services/redis');
const requireJwt = require('../middleware/requireJwt');

const prisma = new PrismaClient();
const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

const ACCESS_TTL  = parseInt(process.env.ACCESS_TOKEN_TTL  || '900',  10); // 15 min
const REFRESH_TTL = parseInt(process.env.REFRESH_TOKEN_TTL || '604800', 10); // 7 days
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

function signAccess(payload, secret) {
  const jti = crypto.randomBytes(16).toString('hex');
  return {
    token: jwt.sign({ ...payload, jti }, secret, { expiresIn: ACCESS_TTL }),
    jti,
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
  const { email, password } = req.body;
  const jwtSecret = process.env.JWT_SECRET;
  const ip        = req.ip;
  const userAgent = req.headers['user-agent'] || '';

  if (!jwtSecret) return res.status(503).json({ error: 'JWT_SECRET not configured' });
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  // 1. Env-var super admin (legacy) — bcrypt compare against cached hash
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPasswordHash = await getAdminPasswordHash();
  if (adminEmail && adminPasswordHash && email === adminEmail) {
    const valid = await bcrypt.compare(password, adminPasswordHash);
    if (valid) {
      const { token } = signAccess({ sub: 'admin', email }, jwtSecret);
      audit({ accion: 'LOGIN', entidad: 'admin', ip, userAgent, metadata: { email, via: 'env' } });
      return res.json({ accessToken: token, expiresIn: ACCESS_TTL, superAdmin: true });
    }
  }

  // 2. DB-backed admin user
  try {
    const user = await prisma.adminUser.findUnique({ where: { email } });

    // Generic invalid-credentials response (timing-safe: always run bcrypt)
    const dummyHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const passwordToCheck = user ? user.passwordHash : dummyHash;
    const valid = await bcrypt.compare(password, passwordToCheck);

    if (!user || !valid) {
      // Increment failedAttempts and maybe lock the account
      if (user) {
        const newAttempts = user.failedAttempts + 1;
        const lockedUntil = newAttempts >= MAX_ATTEMPTS
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
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

    const { token: accessToken } = signAccess(
      { adminUserId: user.id, email: user.email, superAdmin: user.superAdmin, tenantId: user.tenantId ?? null },
      jwtSecret,
    );
    const refreshToken = await issueRefreshToken(user.id);

    audit({ adminUserId: user.id, tenantId: user.tenantId, accion: 'LOGIN', entidad: 'admin_user', entidadId: user.id, ip, userAgent });
    return res.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL, superAdmin: user.superAdmin });
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

    const user = await prisma.adminUser.findUnique({ where: { email: profile.email } });
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

    const { token: accessTokenJwt } = signAccess(
      { adminUserId: user.id, email: user.email, superAdmin: user.superAdmin, tenantId: user.tenantId ?? null },
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

    return res.json({ accessToken: accessTokenJwt, refreshToken, expiresIn: ACCESS_TTL, superAdmin: user.superAdmin });
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

    const user = await prisma.adminUser.findUnique({ where: { email: profile.email } });
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

    const { token: accessToken } = signAccess(
      { adminUserId: user.id, email: user.email, superAdmin: user.superAdmin, tenantId: user.tenantId ?? null },
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

    return res.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL, superAdmin: user.superAdmin });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      return res.status(500).json({ error: 'Google auth failed' });
    }
    return res.status(status).json({ error: err.message || 'Google auth failed' });
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

    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const user = stored.adminUser;
    const { token: accessToken } = signAccess(
      { adminUserId: user.id, email: user.email, superAdmin: user.superAdmin, tenantId: user.tenantId ?? null },
      jwtSecret,
    );

    return res.json({ accessToken, expiresIn: ACCESS_TTL });
  } catch (err) {
    return res.status(500).json({ error: 'Token refresh failed' });
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

module.exports = router;
