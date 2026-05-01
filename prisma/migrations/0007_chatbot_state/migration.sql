-- ── 0007_chatbot_state ───────────────────────────────────────────────────────

-- Add last_seen_at to agentes (agent presence)
ALTER TABLE "agentes" ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMP(3);

-- ConversationContext: tracks chatbot state (current flow node) per user
CREATE TABLE "conversation_contexts" (
    "id"              SERIAL NOT NULL,
    "tenant_id"       UUID NOT NULL,
    "user_id"         INTEGER NOT NULL,
    "current_node_id" INTEGER,
    "engine"          VARCHAR(30) NOT NULL DEFAULT 'flow_engine',
    "variables"       JSONB NOT NULL DEFAULT '{}',
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_contexts_pkey"             PRIMARY KEY ("id"),
    CONSTRAINT "conversation_contexts_tenant_user_unique" UNIQUE ("tenant_id", "user_id"),
    CONSTRAINT "conversation_contexts_tenant_id_fkey"   FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "conversation_contexts_user_id_fkey"     FOREIGN KEY ("user_id")   REFERENCES "users"("id")   ON DELETE CASCADE
);

CREATE INDEX "conversation_contexts_tenant_idx" ON "conversation_contexts"("tenant_id");

-- WaSendQueue: retry queue for failed outbound WhatsApp messages
CREATE TABLE "wa_send_queue" (
    "id"           SERIAL NOT NULL,
    "tenant_id"    UUID NOT NULL,
    "phone"        VARCHAR(20) NOT NULL,
    "payload"      JSONB NOT NULL,
    "status"       VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts"     INTEGER NOT NULL DEFAULT 0,
    "last_error"   TEXT,
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_send_queue_pkey"           PRIMARY KEY ("id"),
    CONSTRAINT "wa_send_queue_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE INDEX "wa_send_queue_status_scheduled_idx" ON "wa_send_queue"("status", "scheduled_at");
