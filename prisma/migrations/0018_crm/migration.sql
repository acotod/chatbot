-- Migration 0018: CRM — enrich users + contacts + deals + tasks

-- Enrich users table with CRM profile fields
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "nombre"           VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "email"            VARCHAR(150),
  ADD COLUMN IF NOT EXISTS "empresa"          VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "cargo"            VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "canal_origen"     VARCHAR(40) DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS "etiquetas"        TEXT[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "notas"            TEXT,
  ADD COLUMN IF NOT EXISTS "custom_fields"    JSONB       DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "ultimo_contacto"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lead_score"       SMALLINT    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS "users_tenant_nombre_idx"   ON "users"("tenant_id", "nombre");
CREATE INDEX IF NOT EXISTS "users_tenant_email_idx"    ON "users"("tenant_id", "email");
CREATE INDEX IF NOT EXISTS "users_tenant_etiquetas_idx" ON "users" USING GIN("etiquetas");

-- Deals (pipeline)
CREATE TABLE IF NOT EXISTS "deals" (
  "id"            SERIAL PRIMARY KEY,
  "tenant_id"     UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id"       INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "agente_id"     INTEGER REFERENCES "agentes"("id") ON DELETE SET NULL,
  "titulo"        VARCHAR(200) NOT NULL,
  "etapa"         VARCHAR(60)  NOT NULL DEFAULT 'nuevo',
  "valor"         DECIMAL(14,2),
  "moneda"        VARCHAR(10)  DEFAULT 'ARS',
  "probabilidad"  SMALLINT     DEFAULT 0,
  "cierre_esperado" DATE,
  "notas"         TEXT,
  "cerrado_en"    TIMESTAMP(3),
  "perdido_razon" VARCHAR(255),
  "custom_fields" JSONB        DEFAULT '{}',
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "deals_tenant_etapa_idx"   ON "deals"("tenant_id", "etapa");
CREATE INDEX IF NOT EXISTS "deals_tenant_user_idx"    ON "deals"("tenant_id", "user_id");
CREATE INDEX IF NOT EXISTS "deals_tenant_agente_idx"  ON "deals"("tenant_id", "agente_id");

-- Tasks (follow-ups)
CREATE TABLE IF NOT EXISTS "crm_tasks" (
  "id"            SERIAL PRIMARY KEY,
  "tenant_id"     UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id"       INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "deal_id"       INTEGER REFERENCES "deals"("id") ON DELETE SET NULL,
  "agente_id"     INTEGER REFERENCES "agentes"("id") ON DELETE SET NULL,
  "titulo"        VARCHAR(200) NOT NULL,
  "descripcion"   TEXT,
  "tipo"          VARCHAR(40)  DEFAULT 'seguimiento',
  "estado"        VARCHAR(40)  DEFAULT 'pendiente',
  "vence_en"      TIMESTAMP(3),
  "completado_en" TIMESTAMP(3),
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "crm_tasks_tenant_estado_idx"  ON "crm_tasks"("tenant_id", "estado");
CREATE INDEX IF NOT EXISTS "crm_tasks_tenant_agente_idx"  ON "crm_tasks"("tenant_id", "agente_id");
CREATE INDEX IF NOT EXISTS "crm_tasks_tenant_user_idx"    ON "crm_tasks"("tenant_id", "user_id");
