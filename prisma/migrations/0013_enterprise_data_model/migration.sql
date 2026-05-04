-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0013: Enterprise Hybrid Data Model
--   • flow_versions    — Immutable JSONB snapshots of flow definitions
--   • flow_executions  — Per-user/session execution state (replaces conversation_contexts for versioned flows)
--   • execution_logs   — Atomic per-step audit trail
--   • integrations     — Dynamic API/webhook config without hardcode
--   • flow_variables   — Variable definitions (global + per-flow)
--
-- Also alters:
--   • conversation_contexts — adds current_node_ref (VARCHAR) + flow_execution_id
-- ─────────────────────────────────────────────────────────────────────────────

-- ── flow_versions ─────────────────────────────────────────────────────────────
-- Stores an immutable JSONB snapshot of a flow at publish time.
-- The execution engine works ONLY with this snapshot — no joins on flow_nodes/edges
-- during runtime.
--
-- definition JSONB structure:
--   {
--     "entry_point": "node_1",
--     "nodes": [
--       { "id": "node_1", "type": "message",   "config": { "text": "Hola {{name}}" }, "next": "node_2" },
--       { "id": "node_2", "type": "input",     "config": { "prompt": "¿Cuál es tu nombre?" },
--                         "llm_classification": { "intents": ["urgente", "consulta", "salir"] } },
--       { "id": "node_3", "type": "condition", "config": { "expression": "{{score}} > 7" },
--                         "branches": { "true": "node_4", "false": "node_5" } },
--       { "id": "node_4", "type": "action",    "config": { "integration_ref": "crm_webhook" } },
--       { "id": "node_5", "type": "handoff",   "config": { "text": "Un agente te atenderá." } },
--       { "id": "node_6", "type": "end",       "config": { "text": "Hasta luego." } }
--     ],
--     "variables": {
--       "name":  { "type": "string",  "default": "" },
--       "score": { "type": "number",  "default": 0  }
--     },
--     "metadata": { "description": "...", "tags": [] }
--   }
CREATE TABLE "flow_versions" (
    "id"                       SERIAL       PRIMARY KEY,
    "tenant_id"                UUID         NOT NULL,
    "flow_id"                  INTEGER      NOT NULL,
    "version_number"           INTEGER      NOT NULL,
    "definition"               JSONB        NOT NULL,
    "changelog"                TEXT,
    "published"                BOOLEAN      NOT NULL DEFAULT false,
    "published_at"             TIMESTAMPTZ,
    "created_by_admin_user_id" INTEGER,
    "created_at"               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "flow_versions_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "flow_versions_flow_id_fkey"
        FOREIGN KEY ("flow_id")   REFERENCES "flows"("id")   ON DELETE CASCADE,
    CONSTRAINT "flow_versions_admin_user_id_fkey"
        FOREIGN KEY ("created_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL,
    CONSTRAINT "flow_versions_flow_id_version_number_key"
        UNIQUE ("flow_id", "version_number")
);

-- B-tree indexes for filtering
CREATE INDEX "idx_flow_versions_tenant_flow_published"
    ON "flow_versions" ("tenant_id", "flow_id", "published");
CREATE INDEX "idx_flow_versions_tenant_created"
    ON "flow_versions" ("tenant_id", "created_at" DESC);

-- GIN index for JSONB querying (node lookup, variable extraction, etc.)
-- jsonb_path_ops is more efficient than default for containment queries (@>)
CREATE INDEX "idx_flow_versions_definition_gin"
    ON "flow_versions" USING GIN ("definition" jsonb_path_ops);


-- ── flow_executions ───────────────────────────────────────────────────────────
-- Tracks the runtime state of a flow execution per user/session.
-- Replaces conversation_contexts for versioned (JSONB-based) flows.
--
-- variables JSONB: dynamic values captured during the flow
--   { "name": "Ana", "score": 8, "telefono": "5491122334455" }
--
-- context JSONB: channel metadata, intent history, debug info
--   { "channel": "whatsapp", "phone": "5491122334455",
--     "intent_history": ["urgente"], "llm_calls": 2 }
CREATE TABLE "flow_executions" (
    "id"               SERIAL       PRIMARY KEY,
    "tenant_id"        UUID         NOT NULL,
    "flow_id"          INTEGER      NOT NULL,
    "flow_version_id"  INTEGER,
    "session_key"      VARCHAR(120) NOT NULL,
    "status"           VARCHAR(20)  NOT NULL DEFAULT 'active',
    "current_node_ref" VARCHAR(120),
    "variables"        JSONB        NOT NULL DEFAULT '{}',
    "context"          JSONB        NOT NULL DEFAULT '{}',
    "error_count"      INTEGER      NOT NULL DEFAULT 0,
    "started_at"       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updated_at"       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "completed_at"     TIMESTAMPTZ,

    CONSTRAINT "flow_executions_tenant_id_fkey"
        FOREIGN KEY ("tenant_id")       REFERENCES "tenants"("id")        ON DELETE CASCADE,
    CONSTRAINT "flow_executions_flow_id_fkey"
        FOREIGN KEY ("flow_id")         REFERENCES "flows"("id")          ON DELETE CASCADE,
    CONSTRAINT "flow_executions_flow_version_id_fkey"
        FOREIGN KEY ("flow_version_id") REFERENCES "flow_versions"("id")  ON DELETE SET NULL,
    CONSTRAINT "flow_executions_tenant_flow_session_key"
        UNIQUE ("tenant_id", "flow_id", "session_key")
);

CREATE INDEX "idx_flow_executions_tenant_status_updated"
    ON "flow_executions" ("tenant_id", "status", "updated_at" DESC);
CREATE INDEX "idx_flow_executions_flow_status"
    ON "flow_executions" ("flow_id", "status");
CREATE INDEX "idx_flow_executions_tenant_updated"
    ON "flow_executions" ("tenant_id", "updated_at" DESC);

-- GIN index for JSONB variable queries (ej: find all executions where name='Ana')
CREATE INDEX "idx_flow_executions_variables_gin"
    ON "flow_executions" USING GIN ("variables" jsonb_path_ops);
CREATE INDEX "idx_flow_executions_context_gin"
    ON "flow_executions" USING GIN ("context" jsonb_path_ops);


-- ── execution_logs ────────────────────────────────────────────────────────────
-- Atomic per-step audit log. One row per node traversal.
-- Provides full execution replay and debugging capability.
--
-- input  JSONB: { "raw": "hola", "button_id": null }
-- output JSONB: { "type": "text", "text": "¿En qué te puedo ayudar?" }
--              | { "type": "api_response", "status": 200, "body": {...} }
CREATE TABLE "execution_logs" (
    "id"            SERIAL       PRIMARY KEY,
    "execution_id"  INTEGER      NOT NULL,
    "tenant_id"     UUID         NOT NULL,
    "node_ref"      VARCHAR(120) NOT NULL,
    "node_type"     VARCHAR(50)  NOT NULL,
    "input"         JSONB,
    "output"        JSONB,
    "duration_ms"   INTEGER,
    "status"        VARCHAR(20)  NOT NULL DEFAULT 'ok',
    "error_message" TEXT,
    "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "execution_logs_execution_id_fkey"
        FOREIGN KEY ("execution_id") REFERENCES "flow_executions"("id") ON DELETE CASCADE
);

CREATE INDEX "idx_execution_logs_execution_created"
    ON "execution_logs" ("execution_id", "created_at");
CREATE INDEX "idx_execution_logs_tenant_created"
    ON "execution_logs" ("tenant_id", "created_at" DESC);


-- ── integrations ──────────────────────────────────────────────────────────────
-- Dynamic, zero-hardcode integration registry per tenant.
-- Nodes with type="action" reference an integration by name.
-- The engine resolves all auth/endpoint/mapping details at runtime from here.
--
-- config JSONB structure:
--   {
--     "endpoint":         "https://api.cliente.com/endpoint",
--     "method":           "POST",
--     "timeout_ms":       5000,
--     "retry_count":      2,
--     "headers":          { "Content-Type": "application/json" },
--     "auth": {
--       "type":           "apikey",        -- "none" | "apikey" | "bearer" | "basic" | "oauth2"
--       "header":         "X-Api-Key",
--       "value":          "{{SECRET}}"     -- resolved from env / secrets manager
--     },
--     "body_mapping":     { "nombre": "{{variables.name}}", "phone": "{{variables.phone}}" },
--     "response_mapping": { "ticket_id": "$.data.id", "status": "$.status" }
--   }
CREATE TABLE "integrations" (
    "id"         SERIAL       PRIMARY KEY,
    "tenant_id"  UUID         NOT NULL,
    "nombre"     VARCHAR(100) NOT NULL,
    "tipo"       VARCHAR(30)  NOT NULL,
    "config"     JSONB        NOT NULL,
    "activo"     BOOLEAN      NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "integrations_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "integrations_tenant_nombre_key"
        UNIQUE ("tenant_id", "nombre")
);

CREATE INDEX "idx_integrations_tenant_activo"
    ON "integrations" ("tenant_id", "activo");

-- GIN for containment queries on config (ej: find all integrations of type oauth2)
CREATE INDEX "idx_integrations_config_gin"
    ON "integrations" USING GIN ("config" jsonb_path_ops);


-- ── flow_variables ────────────────────────────────────────────────────────────
-- Variable definitions for template resolution ({{variable}}).
-- flow_id = NULL means global (tenant-level) variable.
-- The engine merges: global_vars < flow_vars < session_vars (execution.variables)
--
-- valor_default JSONB allows any type:
--   "string"  → "Ana"
--   "number"  → 0
--   "boolean" → false
--   "object"  → {}
--   "array"   → []
CREATE TABLE "flow_variables" (
    "id"            SERIAL       PRIMARY KEY,
    "tenant_id"     UUID         NOT NULL,
    "flow_id"       INTEGER,
    "nombre"        VARCHAR(100) NOT NULL,
    "tipo"          VARCHAR(20)  NOT NULL DEFAULT 'string',
    "valor_default" JSONB,
    "descripcion"   VARCHAR(255),
    "scope"         VARCHAR(20)  NOT NULL DEFAULT 'flow',
    "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "flow_variables_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "flow_variables_flow_id_fkey"
        FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE,
    CONSTRAINT "flow_variables_tenant_flow_nombre_key"
        UNIQUE ("tenant_id", "flow_id", "nombre")
);

CREATE INDEX "idx_flow_variables_tenant_scope"
    ON "flow_variables" ("tenant_id", "scope");


-- ── ALTER conversation_contexts ───────────────────────────────────────────────
-- Add enterprise fields while preserving backward compatibility.
-- current_node_ref: string ID for JSONB-based flows (ej: "node_1")
-- flow_execution_id: pointer to the active FlowExecution (nullable for legacy)
ALTER TABLE "conversation_contexts"
    ADD COLUMN IF NOT EXISTS "current_node_ref"  VARCHAR(120),
    ADD COLUMN IF NOT EXISTS "flow_execution_id" INTEGER;
