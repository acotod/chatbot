-- AlterTable: Add enterprise fields to Solicitud
ALTER TABLE "solicitudes" 
ADD COLUMN "sla_id" INTEGER,
ADD COLUMN "sla_created_at" TIMESTAMP(3),
ADD COLUMN "sla_completed_at" TIMESTAMP(3),
ADD COLUMN "escalated_at" TIMESTAMP(3),
ADD COLUMN "escalation_level" INTEGER DEFAULT 0,
ADD COLUMN "tags" JSONB DEFAULT '[]',
ADD COLUMN "custom_fields" JSONB DEFAULT '{}',
ADD COLUMN "resolution_notes" TEXT,
ADD COLUMN "customer_notes" TEXT,
ADD COLUMN "follow_up_date" TIMESTAMP(3),
ADD COLUMN "channel_source" VARCHAR(50) DEFAULT 'manual';

-- CreateTable: SlaPolicy
CREATE TABLE "sla_policies" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "nombre" VARCHAR(150) NOT NULL,
  "descripcion" TEXT,
  "response_time_minutes" INTEGER NOT NULL DEFAULT 60,
  "resolution_time_minutes" INTEGER NOT NULL DEFAULT 1440,
  "escalation_rules" JSONB DEFAULT '[]',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sla_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "sla_policies_tenant_id_idx" ON "sla_policies"("tenant_id");
CREATE UNIQUE INDEX "sla_policies_tenant_id_nombre_key" ON "sla_policies"("tenant_id", "nombre");

-- CreateTable: SolicitudHistory (Audit Trail)
CREATE TABLE "solicitud_history" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "solicitud_id" INTEGER NOT NULL,
  "field" VARCHAR(100) NOT NULL,
  "old_value" TEXT,
  "new_value" TEXT,
  "user_id" INTEGER,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "solicitud_history_solicitud_id_fkey" FOREIGN KEY ("solicitud_id") REFERENCES "solicitudes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "solicitud_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "solicitud_history_solicitud_id_idx" ON "solicitud_history"("solicitud_id");
CREATE INDEX "solicitud_history_timestamp_idx" ON "solicitud_history"("timestamp");

-- CreateTable: SolicitudComment
CREATE TABLE "solicitud_comments" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "solicitud_id" INTEGER NOT NULL,
  "user_id" INTEGER,
  "content" TEXT NOT NULL,
  "visibility" VARCHAR(20) NOT NULL DEFAULT 'internal',
  "attachments" JSONB DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "solicitud_comments_solicitud_id_fkey" FOREIGN KEY ("solicitud_id") REFERENCES "solicitudes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "solicitud_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "solicitud_comments_solicitud_id_idx" ON "solicitud_comments"("solicitud_id");
CREATE INDEX "solicitud_comments_created_at_idx" ON "solicitud_comments"("created_at");

-- CreateTable: SolicitudAssignmentRule
CREATE TABLE "solicitud_assignment_rules" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "criterios" JSONB NOT NULL DEFAULT '{}',
  "target_agente_id" INTEGER,
  "round_robin" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "solicitud_assignment_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "solicitud_assignment_rules_target_agente_id_fkey" FOREIGN KEY ("target_agente_id") REFERENCES "agentes" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "solicitud_assignment_rules_tenant_id_idx" ON "solicitud_assignment_rules"("tenant_id");

-- CreateTable: SolicitudTemplate
CREATE TABLE "solicitud_templates" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "nombre" VARCHAR(150) NOT NULL,
  "prioridad" VARCHAR(20) DEFAULT 'media',
  "sla_id" INTEGER,
  "tags" JSONB DEFAULT '[]',
  "default_variables" JSONB DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "solicitud_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "solicitud_templates_sla_id_fkey" FOREIGN KEY ("sla_id") REFERENCES "sla_policies" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "solicitud_templates_tenant_id_idx" ON "solicitud_templates"("tenant_id");
CREATE UNIQUE INDEX "solicitud_templates_tenant_id_nombre_key" ON "solicitud_templates"("tenant_id", "nombre");

-- CreateTable: WebhookConfig
CREATE TABLE "webhook_configs" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "event" VARCHAR(100) NOT NULL,
  "url" VARCHAR(500) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "last_triggered_at" TIMESTAMP(3),
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webhook_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "webhook_configs_tenant_id_idx" ON "webhook_configs"("tenant_id");
CREATE INDEX "webhook_configs_event_idx" ON "webhook_configs"("event");
CREATE UNIQUE INDEX "webhook_configs_tenant_id_event_url_key" ON "webhook_configs"("tenant_id", "event", "url");

-- AddForeignKey: Link SlaPolicy to Solicitud
ALTER TABLE "solicitudes" 
ADD CONSTRAINT "solicitudes_sla_id_fkey" FOREIGN KEY ("sla_id") REFERENCES "sla_policies" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
