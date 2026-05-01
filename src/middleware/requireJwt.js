const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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

  // Legacy env-var-based super admin token (sub === 'admin')
  if (payload.sub === 'admin' && !payload.adminUserId) {
    req.admin = { superAdmin: true, permissions: [], email: process.env.ADMIN_EMAIL };
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
        superAdmin: user.superAdmin,
        permissions,
      };
      return next();
    } catch (err) {
      return next(err);
    }
  }

  return res.status(401).json({ error: 'Invalid token payload' });
}

module.exports = requireJwt;
