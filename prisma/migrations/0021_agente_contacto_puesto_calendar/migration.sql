-- Migration 0021: agente contact fields + puesto catalog + calendar link

CREATE TABLE IF NOT EXISTS "agente_puestos" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "nombre" VARCHAR(100) NOT NULL,
  "activo" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agente_puestos_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "agente_puestos_tenant_id_nombre_key"
  ON "agente_puestos"("tenant_id", "nombre");

CREATE INDEX IF NOT EXISTS "agente_puestos_tenant_id_activo_idx"
  ON "agente_puestos"("tenant_id", "activo");

ALTER TABLE "agentes"
  ADD COLUMN IF NOT EXISTS "whatsapp" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "puesto_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "calendar_link" VARCHAR(500);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agentes_puesto_id_fkey'
  ) THEN
    ALTER TABLE "agentes"
      ADD CONSTRAINT "agentes_puesto_id_fkey"
      FOREIGN KEY ("puesto_id") REFERENCES "agente_puestos"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "agentes_tenant_id_puesto_id_idx"
  ON "agentes"("tenant_id", "puesto_id");
