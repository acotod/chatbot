-- 0029_solicitud_message_traceability
-- Extend mensajes/conversations for delivery traceability and assignment auditing.

ALTER TABLE "mensajes"
  ADD COLUMN IF NOT EXISTS "agente_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "error_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "reply_to_mensaje_id" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mensajes_agente_id_fkey'
  ) THEN
    ALTER TABLE "mensajes"
      ADD CONSTRAINT "mensajes_agente_id_fkey"
      FOREIGN KEY ("agente_id") REFERENCES "agentes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mensajes_reply_to_mensaje_id_fkey'
  ) THEN
    ALTER TABLE "mensajes"
      ADD CONSTRAINT "mensajes_reply_to_mensaje_id_fkey"
      FOREIGN KEY ("reply_to_mensaje_id") REFERENCES "mensajes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "mensajes_tenant_status_created_idx"
  ON "mensajes"("tenant_id", "status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "mensajes_tenant_agente_created_idx"
  ON "mensajes"("tenant_id", "agente_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "mensajes_reply_to_mensaje_id_idx"
  ON "mensajes"("reply_to_mensaje_id");

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "assigned_agente_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "assigned_at" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_assigned_agente_id_fkey'
  ) THEN
    ALTER TABLE "conversations"
      ADD CONSTRAINT "conversations_assigned_agente_id_fkey"
      FOREIGN KEY ("assigned_agente_id") REFERENCES "agentes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "conversations_tenant_assigned_agente_status_idx"
  ON "conversations"("tenant_id", "assigned_agente_id", "status");
