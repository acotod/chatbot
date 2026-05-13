ALTER TABLE "agentes" ADD COLUMN IF NOT EXISTS "jefe_admin_id" INTEGER;
ALTER TABLE "agentes" ADD CONSTRAINT "agentes_jefe_admin_id_fkey" FOREIGN KEY ("jefe_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "agentes_tenant_id_jefe_admin_id_idx" ON "agentes"("tenant_id", "jefe_admin_id");
