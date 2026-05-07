-- Migration 0022: assign internal calendars to agentes

ALTER TABLE "calendars"
  ADD COLUMN IF NOT EXISTS "agente_id" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'calendars_agente_id_fkey'
  ) THEN
    ALTER TABLE "calendars"
      ADD CONSTRAINT "calendars_agente_id_fkey"
      FOREIGN KEY ("agente_id") REFERENCES "agentes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_calendars_tenant_agente"
  ON "calendars" ("tenant_id", "agente_id");
