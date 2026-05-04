-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0014: Event-Based Conversation Persistence
--
-- Implements an append-only event sourcing model for full conversation replay:
--
--   conversations      — one row per user session with a flow
--   conversation_events — one row per step (immutable, never updated)
--
-- Design principles:
--   • NEVER update or delete conversation_events (append-only)
--   • conversations.context = mutable JSONB snapshot for active sessions only
--   • GIN index on payload enables payload field searches without full scan
--   • Partition-ready: created_at on all tables for future range partitioning
-- ─────────────────────────────────────────────────────────────────────────────

-- ── conversations ─────────────────────────────────────────────────────────────
-- Represents one full conversational session between a user and a flow.
-- One conversation = one contiguous interaction (start → end/handoff/abandon).
-- A user can have multiple conversations over time (new one starts on re-entry).
--
-- context JSONB (mutable snapshot for active sessions, cleared on completion):
--   {
--     "current_node": "node_5",
--     "variables": { "name": "Juan", "document_id": "12345678" }
--   }
CREATE TABLE "conversations" (
    "id"               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"        UUID         NOT NULL,
    "user_key"         VARCHAR(120) NOT NULL,
    "flow_id"          INTEGER      NOT NULL,
    "flow_version_id"  INTEGER,
    "status"           VARCHAR(20)  NOT NULL DEFAULT 'active',
    "context"          JSONB        NOT NULL DEFAULT '{}',
    "started_at"       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "ended_at"         TIMESTAMPTZ,

    CONSTRAINT "conversations_tenant_id_fkey"
        FOREIGN KEY ("tenant_id")       REFERENCES "tenants"("id")        ON DELETE CASCADE,
    CONSTRAINT "conversations_flow_id_fkey"
        FOREIGN KEY ("flow_id")         REFERENCES "flows"("id")          ON DELETE CASCADE,
    CONSTRAINT "conversations_flow_version_id_fkey"
        FOREIGN KEY ("flow_version_id") REFERENCES "flow_versions"("id")  ON DELETE SET NULL
);

-- Frequent queries: list conversations for a tenant, filter by status/date
CREATE INDEX "idx_conversations_tenant_status_started"
    ON "conversations" ("tenant_id", "status", "started_at" DESC);

-- Look up active conversation by user
CREATE INDEX "idx_conversations_tenant_user"
    ON "conversations" ("tenant_id", "user_key");

-- Filter by flow
CREATE INDEX "idx_conversations_flow_status"
    ON "conversations" ("flow_id", "status");

-- GIN for context JSONB (query current_node, variable values)
CREATE INDEX "idx_conversations_context_gin"
    ON "conversations" USING GIN ("context" jsonb_path_ops);


-- ── conversation_events ───────────────────────────────────────────────────────
-- Append-only event log — one row per step in the conversation.
-- NEVER update or delete rows; use INSERT only.
-- Enables full replay, debugging, and dashboards without touching live state.
--
-- Payload JSONB structure per event_type:
--
--   flow_start:
--     { "flow_id": 1, "entry_point": "node_1", "version_number": 3 }
--
--   message_sent:
--     { "text": "Hola {{name}}, ¿en qué te puedo ayudar?",
--       "node_type": "message", "buttons": [] }
--
--   user_input:
--     { "raw_input": "12345678", "matched_button_id": null,
--       "variable_set": "document_id" }
--
--   menu_selection:
--     { "selected_id": "urgente", "selected_title": "Urgente" }
--
--   condition_eval:
--     { "expression": "{{score}} > 7", "resolved": "9 > 7",
--       "result": true, "next_node": "node_4" }
--
--   api_call:
--     { "integration_ref": "crm_webhook", "endpoint": "https://...",
--       "method": "POST", "body_keys": ["nombre", "phone"] }
--
--   api_response:
--     { "integration_ref": "crm_webhook", "status_code": 200,
--       "response_vars": { "ticket_id": "T-001" }, "duration_ms": 312 }
--
--   llm_call:
--     { "model": "gpt-4o-mini", "prompt_tokens": 120, "completion_tokens": 85 }
--
--   variable_set:
--     { "variable": "name", "value": "Juan" }
--
--   flow_end:
--     { "final_variables": { "name": "Juan", "document_id": "12345678" } }
--
--   flow_handoff:
--     { "reason": "user_requested", "node_id": "node_6" }
--
--   flow_error:
--     { "error_message": "Integration timeout after 8000ms", "node_id": "node_4" }
CREATE TABLE "conversation_events" (
    "id"               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "conversation_id"  UUID         NOT NULL,
    "tenant_id"        UUID         NOT NULL,
    "node_ref"         VARCHAR(120),
    "event_type"       VARCHAR(50)  NOT NULL,
    "payload"          JSONB        NOT NULL DEFAULT '{}',
    "created_at"       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "conversation_events_conversation_id_fkey"
        FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE
);

-- Primary replay query: get all events for a conversation ordered by time
CREATE INDEX "idx_conv_events_conversation_created"
    ON "conversation_events" ("conversation_id", "created_at");

-- Dashboard: filter by event type across tenant
CREATE INDEX "idx_conv_events_tenant_type_created"
    ON "conversation_events" ("tenant_id", "event_type", "created_at" DESC);

-- Tenant-level time-range queries (archiving, analytics)
CREATE INDEX "idx_conv_events_tenant_created"
    ON "conversation_events" ("tenant_id", "created_at" DESC);

-- GIN index: payload content search
-- Enables queries like: find all events where payload @> '{"variable_set":"document_id"}'
-- Also useful for: find all api_call events that called a specific integration
CREATE INDEX "idx_conv_events_payload_gin"
    ON "conversation_events" USING GIN ("payload" jsonb_path_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- Example queries (included as reference comments, not executed)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Reconstruct a full conversation (chat view):
--    SELECT event_type, node_ref, payload, created_at
--    FROM conversation_events
--    WHERE conversation_id = '<uuid>'
--    ORDER BY created_at;

-- 2. List conversations for dashboard (with duration):
--    SELECT c.id, c.user_key, c.status,
--           c.started_at,
--           EXTRACT(EPOCH FROM (COALESCE(c.ended_at, NOW()) - c.started_at)) AS duration_sec,
--           COUNT(e.id) AS event_count
--    FROM conversations c
--    LEFT JOIN conversation_events e ON e.conversation_id = c.id
--    WHERE c.tenant_id = '<uuid>'
--    GROUP BY c.id
--    ORDER BY c.started_at DESC;

-- 3. Find all api_call errors in last 24h:
--    SELECT ce.conversation_id, ce.payload, ce.created_at
--    FROM conversation_events ce
--    WHERE ce.tenant_id = '<uuid>'
--      AND ce.event_type = 'flow_error'
--      AND ce.created_at > NOW() - INTERVAL '24 hours';

-- 4. Variables captured per conversation (from user_input events):
--    SELECT conversation_id,
--           payload->>'variable_set' AS variable,
--           payload->>'raw_input'    AS value
--    FROM conversation_events
--    WHERE tenant_id = '<uuid>'
--      AND event_type = 'user_input'
--      AND payload ? 'variable_set';
