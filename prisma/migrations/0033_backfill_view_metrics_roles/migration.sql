-- Migration 0033: Backfill VIEW_METRICS for admin-like roles in existing environments

-- Ensure permission exists even if legacy environments are missing it.
INSERT INTO "permisos" ("clave") VALUES
  ('VIEW_METRICS')
ON CONFLICT ("clave") DO NOTHING;

-- Grant VIEW_METRICS to existing admin-like roles so Reportes is visible in staging.
WITH metrics_perm AS (
  SELECT id
  FROM "permisos"
  WHERE "clave" = 'VIEW_METRICS'
), candidate_roles AS (
  SELECT r.id
  FROM "roles" r
  WHERE lower(trim(r.nombre)) IN ('super admin', 'superadmin', 'tenant admin', 'admin', 'administrador')
     OR EXISTS (
       SELECT 1
       FROM "role_permisos" rp
       JOIN "permisos" p ON p.id = rp.permiso_id
       WHERE rp.role_id = r.id
         AND p.clave IN ('VIEW_DASHBOARD', 'MANAGE_TENANTS', 'MANAGE_ROLES')
     )
)
INSERT INTO "role_permisos" ("role_id", "permiso_id")
SELECT cr.id, mp.id
FROM candidate_roles cr
CROSS JOIN metrics_perm mp
ON CONFLICT ("role_id", "permiso_id") DO NOTHING;
