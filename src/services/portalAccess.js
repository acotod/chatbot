'use strict';

const jwt = require('jsonwebtoken');

const PORTAL_TOKEN_TTL = parseInt(process.env.SOLICITUD_PORTAL_TOKEN_TTL || '2592000', 10); // 30 days

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error('JWT_SECRET not configured');
    err.status = 503;
    throw err;
  }
  return secret;
}

function generatePortalToken(payload) {
  const secret = getSecret();
  return jwt.sign(
    {
      typ: 'solicitud_portal',
      tenantId: payload.tenantId,
      solicitudId: payload.solicitudId ?? null,
      userId: payload.userId ?? null,
    },
    secret,
    { expiresIn: PORTAL_TOKEN_TTL }
  );
}

function verifyPortalToken(token) {
  const secret = getSecret();
  const decoded = jwt.verify(token, secret);
  if (!decoded || decoded.typ !== 'solicitud_portal') {
    const err = new Error('Invalid portal token');
    err.status = 401;
    throw err;
  }
  return decoded;
}

module.exports = {
  generatePortalToken,
  verifyPortalToken,
};
