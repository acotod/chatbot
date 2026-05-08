'use strict';
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { getRedisClient } = require('../services/redis');

const prisma = new PrismaClient();

async function requireAgentJwt(req, res, next) {
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

  if (payload.jti) {
    try {
      const redis = getRedisClient();
      if (redis) {
        const blocked = await redis.get(`jwt:bl:${payload.jti}`);
        if (blocked) return res.status(401).json({ error: 'Token has been revoked' });
      }
    } catch (_) { /* Redis unavailable — allow through */ }
  }

  if (payload?.sub !== 'agent' || !payload.agenteId || !payload.tenantId) {
    return res.status(401).json({ error: 'Invalid token payload' });
  }

  try {
    const agente = await prisma.agente.findFirst({
      where: {
        id: Number(payload.agenteId),
        tenantId: payload.tenantId,
      },
      include: {
        tenant: { select: { id: true, slug: true, nombre: true } },
        puesto: { select: { id: true, nombre: true } },
      },
    });

    if (!agente) return res.status(401).json({ error: 'Agent not found' });
    if (agente.estado !== 'activo') {
      return res.status(403).json({ error: 'Agent account is inactive' });
    }

    req.agent = {
      agenteId: agente.id,
      tenantId: agente.tenantId,
      tenantSlug: agente.tenant?.slug ?? null,
      tenantNombre: agente.tenant?.nombre ?? null,
      nombre: agente.nombre,
      email: agente.email,
      whatsapp: agente.whatsapp,
      estado: agente.estado,
      puesto: agente.puesto,
      calendarLink: agente.calendarLink,
      lastSeenAt: agente.lastSeenAt,
      _jti: payload.jti,
      _exp: payload.exp,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = requireAgentJwt;