CREATE TABLE IF NOT EXISTS "email_logs" (
  "id" SERIAL NOT NULL,
  "tenant_id" UUID,
  "to" TEXT NOT NULL,
  "subject" VARCHAR(500) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "message_id" VARCHAR(255),
  "last_error" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_logs_tenant_id_idx" ON "email_logs"("tenant_id");
CREATE INDEX IF NOT EXISTS "email_logs_tenant_id_created_at_idx" ON "email_logs"("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "email_logs_status_idx" ON "email_logs"("status");
CREATE INDEX IF NOT EXISTS "email_logs_created_at_idx" ON "email_logs"("created_at");
