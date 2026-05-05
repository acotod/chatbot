-- Migration 0019: link Mensaje rows to their parent Conversation
-- Adds an optional FK so every WhatsApp message can be traced to the
-- flow conversation that generated / received it.

ALTER TABLE "mensajes"
  ADD COLUMN IF NOT EXISTS "conversation_id" UUID REFERENCES "conversations"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "mensajes_conversation_id_idx"
  ON "mensajes"("conversation_id");
