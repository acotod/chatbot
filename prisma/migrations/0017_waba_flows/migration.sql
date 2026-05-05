-- Migration 0017: WABA Flow Integration Module
-- Adds WABA validation tracking to flow_versions and a WABA import log table.

-- Add WABA-specific columns to flow_versions
ALTER TABLE "flow_versions"
  ADD COLUMN IF NOT EXISTS "waba_validation_status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "waba_validated_at"       TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "waba_validation_errors"  JSONB;

-- WABA import log — tracks every JSON import for auditability
CREATE TABLE IF NOT EXISTS "waba_import_logs" (
  "id"              SERIAL PRIMARY KEY,
  "tenant_id"       UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "flow_id"         INTEGER REFERENCES "flows"("id") ON DELETE SET NULL,
  "admin_user_id"   INTEGER REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "source"          VARCHAR(30) NOT NULL DEFAULT 'manual',
  "original_json"   JSONB NOT NULL,
  "parsed_nodes"    INTEGER NOT NULL DEFAULT 0,
  "validation_errors" JSONB,
  "status"          VARCHAR(20) NOT NULL DEFAULT 'imported',
  "created_at"      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "waba_import_logs_tenant_id_idx" ON "waba_import_logs"("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "waba_import_logs_flow_id_idx"   ON "waba_import_logs"("flow_id");

-- Record migration in _prisma_migrations (manual tracking)
INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
VALUES (
  gen_random_uuid()::text,
  '0017_waba_flows_manual',
  now(), '0017_waba_flows', NULL, NULL, now(), 1
) ON CONFLICT DO NOTHING;
