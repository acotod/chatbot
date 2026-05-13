-- Migration 0031: AdminUser hierarchy (jefe_id self-reference) + escaladoAId on solicitudes
-- Each AdminUser can have a jefe (another AdminUser), building an escalation tree.
-- Solicitudes can now be escalated to a specific AdminUser.

-- AdminUser self-referential hierarchy
ALTER TABLE "admin_users" ADD COLUMN IF NOT EXISTS "jefe_id" INTEGER;
ALTER TABLE "admin_users"
  ADD CONSTRAINT "admin_users_jefe_id_fkey"
  FOREIGN KEY ("jefe_id")
  REFERENCES "admin_users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "admin_users_tenant_id_jefe_id_idx" ON "admin_users"("tenant_id", "jefe_id");

-- Solicitud escalation target
ALTER TABLE "solicitudes" ADD COLUMN IF NOT EXISTS "escalado_a_id" INTEGER;
ALTER TABLE "solicitudes"
  ADD CONSTRAINT "solicitudes_escalado_a_id_fkey"
  FOREIGN KEY ("escalado_a_id")
  REFERENCES "admin_users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
