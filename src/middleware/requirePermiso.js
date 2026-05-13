'use strict';
/**
 * requirePermiso(clave) — middleware factory.
 * Ensures req.admin.permissions includes the given permission key.
 * Pass an array to accept any one of the listed permissions (OR logic).
 * Must be used AFTER requireJwt (which populates req.admin).
 */
function requirePermiso(clave) {
  const claves = Array.isArray(clave) ? clave : [clave];
  return (req, res, next) => {
    const perms = req.admin?.permissions ?? [];
    if (req.admin?.superAdmin || claves.some((c) => perms.includes(c))) {
      return next();
    }
    return res.status(403).json({ error: 'Acceso denegado', required: claves });
  };
}

module.exports = requirePermiso;
