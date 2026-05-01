const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { audit } = require('../services/audit');

const prisma = new PrismaClient();
const router = express.Router();

/**
 * POST /auth/login
 * Body: { email, password }
 * Supports two modes:
 *   1. Env-var super admin (ADMIN_EMAIL / ADMIN_PASSWORD)
 *   2. DB-backed admin users (admin_users table)
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    return res.status(503).json({ error: 'JWT_SECRET not configured' });
  }
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  // 1. Check env-var super admin
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword && email === adminEmail && password === adminPassword) {
    const token = jwt.sign({ sub: 'admin', email }, jwtSecret, { expiresIn: '8h' });
    audit({ accion: 'LOGIN', entidad: 'admin', metadata: { email, via: 'env' } });
    return res.json({ token, expiresIn: '8h', superAdmin: true });
  }

  // 2. Check DB admin user
  try {
    const user = await prisma.adminUser.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { adminUserId: user.id, email: user.email, superAdmin: user.superAdmin },
      jwtSecret,
      { expiresIn: '8h' }
    );
    audit({ adminUserId: user.id, tenantId: user.tenantId, accion: 'LOGIN', entidad: 'admin_user', entidadId: user.id });
    return res.json({ token, expiresIn: '8h', superAdmin: user.superAdmin });
  } catch (err) {
    return res.status(500).json({ error: 'Auth error' });
  }
});

module.exports = router;
