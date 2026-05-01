-- ── AdminUsers ────────────────────────────────────────────────────────────────
CREATE TABLE "admin_users" (
    "id"            SERIAL PRIMARY KEY,
    "tenant_id"     UUID,
    "email"         VARCHAR(150) NOT NULL UNIQUE,
    "password_hash" VARCHAR(255) NOT NULL,
    "nombre"        VARCHAR(100) NOT NULL,
    "super_admin"   BOOLEAN NOT NULL DEFAULT false,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── RBAC ──────────────────────────────────────────────────────────────────────
CREATE TABLE "roles" (
    "id"         SERIAL PRIMARY KEY,
    "tenant_id"  UUID,
    "nombre"     VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "permisos" (
    "id"    SERIAL PRIMARY KEY,
    "clave" VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE "role_permisos" (
    "role_id"    INTEGER NOT NULL,
    "permiso_id" INTEGER NOT NULL,
    PRIMARY KEY ("role_id", "permiso_id"),
    FOREIGN KEY ("role_id")    REFERENCES "roles"("id")   ON DELETE CASCADE,
    FOREIGN KEY ("permiso_id") REFERENCES "permisos"("id") ON DELETE CASCADE
);

CREATE TABLE "admin_user_roles" (
    "admin_user_id" INTEGER NOT NULL,
    "role_id"       INTEGER NOT NULL,
    PRIMARY KEY ("admin_user_id", "role_id"),
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE,
    FOREIGN KEY ("role_id")       REFERENCES "roles"("id")       ON DELETE CASCADE
);

-- ── AuditLogs ─────────────────────────────────────────────────────────────────
CREATE TABLE "audit_logs" (
    "id"            SERIAL PRIMARY KEY,
    "tenant_id"     UUID,
    "admin_user_id" INTEGER,
    "accion"        VARCHAR(100) NOT NULL,
    "entidad"       VARCHAR(100) NOT NULL,
    "entidad_id"    VARCHAR(100),
    "metadata"      JSONB,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
);

CREATE INDEX "audit_logs_tenant_id_idx"  ON "audit_logs"("tenant_id");
CREATE INDEX "audit_logs_accion_idx"     ON "audit_logs"("accion");
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- ── Flows ─────────────────────────────────────────────────────────────────────
CREATE TABLE "flows" (
    "id"         SERIAL PRIMARY KEY,
    "tenant_id"  UUID NOT NULL,
    "nombre"     VARCHAR(100) NOT NULL,
    "version"    INTEGER NOT NULL DEFAULT 1,
    "activo"     BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
);

CREATE TABLE "flow_nodes" (
    "id"      SERIAL PRIMARY KEY,
    "flow_id" INTEGER NOT NULL,
    "type"    VARCHAR(50) NOT NULL,
    "content" JSONB NOT NULL,
    "pos_x"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pos_y"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE
);

CREATE TABLE "flow_edges" (
    "id"             SERIAL PRIMARY KEY,
    "flow_id"        INTEGER NOT NULL,
    "source_node_id" INTEGER NOT NULL,
    "target_node_id" INTEGER NOT NULL,
    "condition"      VARCHAR(255),
    FOREIGN KEY ("flow_id")        REFERENCES "flows"("id")      ON DELETE CASCADE,
    FOREIGN KEY ("source_node_id") REFERENCES "flow_nodes"("id") ON DELETE CASCADE,
    FOREIGN KEY ("target_node_id") REFERENCES "flow_nodes"("id") ON DELETE CASCADE
);

-- ── Seed: permisos base ───────────────────────────────────────────────────────
INSERT INTO "permisos" ("clave") VALUES
    ('VIEW_DASHBOARD'),
    ('VIEW_SOLICITUDES'),
    ('EDIT_SOLICITUDES'),
    ('VIEW_AGENTES'),
    ('EDIT_AGENTES'),
    ('VIEW_CONVERSACIONES'),
    ('VIEW_FLUJOS'),
    ('EDIT_FLUJOS'),
    ('VIEW_AUDITORIA'),
    ('MANAGE_ROLES'),
    ('MANAGE_TENANTS'),
    ('VIEW_METRICS');

-- ── Seed: rol Super Admin (con todos los permisos) ────────────────────────────
INSERT INTO "roles" ("tenant_id", "nombre") VALUES (NULL, 'Super Admin');

INSERT INTO "role_permisos" ("role_id", "permiso_id")
SELECT 1, "id" FROM "permisos";
