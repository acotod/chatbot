-- ── Migration 0009: Agenda enterprise module ───────────────────────────────

CREATE TABLE "agenda_events" (
    "id"                         SERIAL PRIMARY KEY,
    "tenant_id"                  UUID NOT NULL,
    "created_by_admin_user_id"   INTEGER,
    "flow_id"                    INTEGER,
    "titulo"                     VARCHAR(160) NOT NULL,
    "descripcion"                TEXT,
    "tipo"                       VARCHAR(30) NOT NULL,
    "color"                      VARCHAR(20) NOT NULL DEFAULT '#60A5FA',
    "estado"                     VARCHAR(30) NOT NULL DEFAULT 'pendiente',
    "start_at"                   TIMESTAMP(3) NOT NULL,
    "end_at"                     TIMESTAMP(3) NOT NULL,
    "reminder_minutes"           INTEGER,
    "trigger_webhook_on_start"   BOOLEAN NOT NULL DEFAULT false,
    "webhook_url"                VARCHAR(500),
    "webhook_method"             VARCHAR(10),
    "webhook_headers"            JSONB,
    "webhook_payload"            JSONB,
    "created_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenant_id")                REFERENCES "tenants"("id") ON DELETE CASCADE,
    FOREIGN KEY ("created_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL,
    FOREIGN KEY ("flow_id")                  REFERENCES "flows"("id") ON DELETE SET NULL,
    CONSTRAINT "agenda_events_start_before_end_chk" CHECK ("start_at" < "end_at"),
    CONSTRAINT "agenda_events_tipo_chk" CHECK ("tipo" IN ('reunion', 'tarea', 'automatizacion', 'webhook')),
    CONSTRAINT "agenda_events_estado_chk" CHECK ("estado" IN ('pendiente', 'en_progreso', 'completado')),
    CONSTRAINT "agenda_events_reminder_minutes_chk" CHECK ("reminder_minutes" IS NULL OR "reminder_minutes" >= 0)
);

CREATE TABLE "agenda_event_assignments" (
    "event_id"    INTEGER NOT NULL,
    "agente_id"   INTEGER NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("event_id", "agente_id"),
    FOREIGN KEY ("event_id")  REFERENCES "agenda_events"("id") ON DELETE CASCADE,
    FOREIGN KEY ("agente_id") REFERENCES "agentes"("id") ON DELETE CASCADE
);

CREATE TABLE "agenda_event_logs" (
    "id"             SERIAL PRIMARY KEY,
    "tenant_id"      UUID NOT NULL,
    "event_id"       INTEGER NOT NULL,
    "admin_user_id"  INTEGER,
    "accion"         VARCHAR(80) NOT NULL,
    "metadata"       JSONB,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenant_id")     REFERENCES "tenants"("id") ON DELETE CASCADE,
    FOREIGN KEY ("event_id")      REFERENCES "agenda_events"("id") ON DELETE CASCADE,
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL
);

CREATE INDEX "agenda_events_tenant_id_start_at_idx"
    ON "agenda_events"("tenant_id", "start_at");

CREATE INDEX "agenda_events_tenant_id_estado_start_at_idx"
    ON "agenda_events"("tenant_id", "estado", "start_at");

CREATE INDEX "agenda_events_tenant_id_tipo_start_at_idx"
    ON "agenda_events"("tenant_id", "tipo", "start_at");

CREATE INDEX "agenda_event_assignments_agente_id_idx"
    ON "agenda_event_assignments"("agente_id");

CREATE INDEX "agenda_event_logs_tenant_id_created_at_idx"
    ON "agenda_event_logs"("tenant_id", "created_at");

CREATE INDEX "agenda_event_logs_event_id_created_at_idx"
    ON "agenda_event_logs"("event_id", "created_at");

INSERT INTO "permisos" ("clave") VALUES
    ('VIEW_AGENDA'),
    ('CREATE_AGENDA'),
    ('EDIT_AGENDA'),
    ('DELETE_AGENDA')
ON CONFLICT ("clave") DO NOTHING;
