-- ── Migration 0011: UEG foundation tables ───────────────────────────────────

CREATE TABLE "event_schemas" (
  "id" SERIAL NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "version" VARCHAR(20) NOT NULL,
  "schema" JSONB NOT NULL,
  "activo" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "event_schemas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_schemas_name_version_key" ON "event_schemas"("name", "version");

CREATE TABLE "event_logs" (
  "id" SERIAL NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" VARCHAR(80) NOT NULL,
  "event_version" VARCHAR(20) NOT NULL DEFAULT '1.0',
  "channel" VARCHAR(40) NOT NULL,
  "source" VARCHAR(60) NOT NULL,
  "event_type" VARCHAR(80) NOT NULL,
  "direction" VARCHAR(20) NOT NULL DEFAULT 'inbound',
  "idempotency_key" VARCHAR(191) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'ingested',
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "payload" JSONB NOT NULL,
  "metadata" JSONB,
  "raw_event" JSONB,
  "last_error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_logs_event_id_key" ON "event_logs"("event_id");
CREATE UNIQUE INDEX "event_logs_tenant_id_idempotency_key_key" ON "event_logs"("tenant_id", "idempotency_key");
CREATE INDEX "event_logs_tenant_id_ingested_at_idx" ON "event_logs"("tenant_id", "ingested_at");
CREATE INDEX "event_logs_tenant_id_event_type_ingested_at_idx" ON "event_logs"("tenant_id", "event_type", "ingested_at");

CREATE TABLE "dead_letter_queue" (
  "id" SERIAL NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_log_id" INTEGER,
  "reason" VARCHAR(255) NOT NULL,
  "error" JSONB,
  "payload" JSONB,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_retry_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dead_letter_queue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dead_letter_queue_status_next_retry_at_idx" ON "dead_letter_queue"("status", "next_retry_at");
CREATE INDEX "dead_letter_queue_tenant_id_created_at_idx" ON "dead_letter_queue"("tenant_id", "created_at");

ALTER TABLE "event_logs"
  ADD CONSTRAINT "event_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dead_letter_queue"
  ADD CONSTRAINT "dead_letter_queue_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dead_letter_queue"
  ADD CONSTRAINT "dead_letter_queue_event_log_id_fkey"
  FOREIGN KEY ("event_log_id") REFERENCES "event_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
