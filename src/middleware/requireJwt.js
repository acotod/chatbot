const jwt = require('jsonwebtoken');

function requireJwt(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(503).json({ error: 'JWT not configured' });

  try {
    req.admin = jwt.verify(token, secret);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = requireJwt;
