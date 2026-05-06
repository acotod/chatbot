'use strict';
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { getRedisClient } = require('../services/redis');

const prisma = new PrismaClient();

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isConfiguredEnvAdminEmail(email) {
  const configured = normalizeEmail(process.env.ADMIN_EMAIL);
  return Boolean(configured && normalizeEmail(email) === configured);
}

async function requireJwt(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(503).json({ error: 'JWT not configured' });

  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Check Redis blacklist (populated by POST /auth/logout)
  if (payload.jti) {
    try {
      const redis = getRedisClient();
      if (redis) {
        const blocked = await redis.get(`jwt:bl:${payload.jti}`);
        if (blocked) return res.status(401).json({ error: 'Token has been revoked' });
      }
    } catch (_) { /* Redis unavailable — allow through */ }
  }

  // Legacy env-var-based super admin token (sub === 'admin')
  if (payload.sub === 'admin' && !payload.adminUserId) {
    req.admin = { superAdmin: true, permissions: [], email: process.env.ADMIN_EMAIL, _jti: payload.jti, _exp: payload.exp };
    return next();
  }

  // DB-backed admin user
  if (payload.adminUserId) {
    try {
      const user = await prisma.adminUser.findUnique({
        where: { id: payload.adminUserId },
        include: {
          roles: {
            include: {
              role: {
                include: {
                  permisos: { include: { permiso: true } },
                },
              },
            },
          },
        },
      });

      if (!user) return res.status(401).json({ error: 'User not found' });

      const permissions = [
        ...new Set(
          user.roles.flatMap((ur) =>
            ur.role.permisos.map((rp) => rp.permiso.clave)
          )
        ),
      ];

      req.admin = {
        adminUserId: user.id,
        email: user.email,
        nombre: user.nombre,
        tenantId: user.tenantId,
        superAdmin: Boolean(user.superAdmin || isConfiguredEnvAdminEmail(user.email)),
        permissions,
        _jti: payload.jti,
        _exp: payload.exp,
      };
      return next();
    } catch (err) {
      return next(err);
    }
  }

  return res.status(401).json({ error: 'Invalid token payload' });
}

module.exports = requireJwt;
