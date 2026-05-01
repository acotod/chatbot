'use strict';
/**
 * requirePermiso(clave) — middleware factory.
 * Ensures req.admin.permissions includes the given permission key.
 * Must be used AFTER requireJwt (which populates req.admin).
 */
function requirePermiso(clave) {
  return (req, res, next) => {
    const perms = req.admin?.permissions ?? [];
    if (req.admin?.superAdmin || perms.includes(clave)) {
      return next();
    }
    return res.status(403).json({ error: 'Acceso denegado', required: clave });
  };
}

module.exports = requirePermiso;
