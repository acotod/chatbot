const express = require('express');
const jwt = require('jsonwebtoken');

const router = express.Router();

/**
 * POST /auth/login
 * Body: { email, password }
 * Returns: { token }
 *
 * Credentials are set via ADMIN_EMAIL and ADMIN_PASSWORD env vars.
 * Token is signed with JWT_SECRET and expires in 8h.
 */
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const jwtSecret = process.env.JWT_SECRET;

  if (!adminEmail || !adminPassword || !jwtSecret) {
    return res.status(503).json({ error: 'Auth not configured — set ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET' });
  }

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  if (email !== adminEmail || password !== adminPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ email }, jwtSecret, { expiresIn: '8h' });
  res.json({ token, expiresIn: '8h' });
});

module.exports = router;
