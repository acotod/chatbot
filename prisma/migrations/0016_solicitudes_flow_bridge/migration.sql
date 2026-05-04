-- ── Migration 0016: Bridge solicitudes with conversations/flows + enterprise statuses

ALTER TABLE "solicitudes"
  ADD COLUMN "flow_id" INTEGER,
  ADD COLUMN "conversation_id" UUID,
  ADD COLUMN "origin" VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN "titulo" VARCHAR(160),
  ADD COLUMN "prioridad" VARCHAR(20),
  ADD COLUMN "flow_node_ref" VARCHAR(120),
  ADD COLUMN "variables_json" JSONB,
  ADD COLUMN "attachments_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "internal_comments_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "completed_at" TIMESTAMP(3);

-- Normalize legacy statuses into a strict enterprise set.
UPDATE "solicitudes"
SET "estado" = CASE
  WHEN "estado" IS NULL OR LOWER("estado") IN ('pendiente', 'open') THEN 'open'
  WHEN LOWER("estado") IN ('urgente', 'en_proceso', 'in_progress') THEN 'in_progress'
  WHEN LOWER("estado") IN ('pendiente_info', 'pending_info') THEN 'pending_info'
  WHEN LOWER("estado") IN ('resuelto', 'completado', 'completed') THEN 'completed'
  WHEN LOWER("estado") IN ('rechazado', 'rejected') THEN 'rejected'
  ELSE 'open'
END;

ALTER TABLE "solicitudes"
  ADD CONSTRAINT "solicitudes_estado_chk"
  CHECK ("estado" IN ('open', 'in_progress', 'pending_info', 'completed', 'rejected'));

ALTER TABLE "solicitudes"
  ADD CONSTRAINT "solicitudes_flow_id_fkey"
  FOREIGN KEY ("flow_id") REFERENCES "flows"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "solicitudes"
  ADD CONSTRAINT "solicitudes_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "solicitudes_tenant_estado_created_at_idx"
  ON "solicitudes"("tenant_id", "estado", "created_at" DESC);

CREATE INDEX "solicitudes_tenant_conversation_id_idx"
  ON "solicitudes"("tenant_id", "conversation_id");

CREATE INDEX "solicitudes_tenant_flow_id_idx"
  ON "solicitudes"("tenant_id", "flow_id");
