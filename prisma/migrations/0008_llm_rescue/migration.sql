-- ── Migration 0008: LLM / WABA Rescue ────────────────────────────────────────

CREATE TABLE "waba_rescue_logs" (
    "id"               SERIAL PRIMARY KEY,
    "tenant_id"        UUID NOT NULL,
    "admin_user_id"    INTEGER,
    "original_json"    JSONB NOT NULL,
    "waba_error"       JSONB NOT NULL,
    "diagnosis"        JSONB,
    "fixed_json"       JSONB,
    "changes"          JSONB,
    "confidence_score" INTEGER,
    "status"           VARCHAR(20) NOT NULL DEFAULT 'pending',
    "llm_used"         BOOLEAN NOT NULL DEFAULT false,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenant_id")     REFERENCES "tenants"("id"),
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
);

CREATE INDEX "waba_rescue_logs_tenant_id_created_at_idx"
    ON "waba_rescue_logs"("tenant_id", "created_at");

-- New permissions for LLM / WABA rescue
INSERT INTO "permisos" ("clave") VALUES
    ('VIEW_LLM_RESCUE'),
    ('MANAGE_LLM_RESCUE'),
    ('MANAGE_LLM_CONFIG')
ON CONFLICT ("clave") DO NOTHING;
