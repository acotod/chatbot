ALTER TABLE "agentes"
ADD COLUMN "password_hash" VARCHAR(255);

CREATE INDEX IF NOT EXISTS "agentes_tenant_id_email_idx"
ON "agentes"("tenant_id", "email");