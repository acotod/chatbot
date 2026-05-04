-- ── Migration 0012: Generic flow runtime sessions (JSON state) ──────────────

CREATE TABLE "flow_sessions" (
  "id" SERIAL NOT NULL,
  "tenant_id" UUID NOT NULL,
  "flow_id" INTEGER NOT NULL,
  "session_key" VARCHAR(120) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "current_screen_id" VARCHAR(120),
  "state_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "business_context_json" JSONB,
  "audit_events_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "flow_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flow_sessions_tenant_id_flow_id_session_key_key"
  ON "flow_sessions"("tenant_id", "flow_id", "session_key");

CREATE INDEX "flow_sessions_tenant_id_updated_at_idx"
  ON "flow_sessions"("tenant_id", "updated_at");

CREATE INDEX "flow_sessions_flow_id_status_idx"
  ON "flow_sessions"("flow_id", "status");

ALTER TABLE "flow_sessions"
  ADD CONSTRAINT "flow_sessions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "flow_sessions"
  ADD CONSTRAINT "flow_sessions_flow_id_fkey"
  FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
