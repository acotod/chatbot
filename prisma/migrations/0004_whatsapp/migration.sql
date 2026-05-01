-- ── WhatsApp Business mensajes ────────────────────────────────────────────────
CREATE TABLE "mensajes" (
    "id"         SERIAL PRIMARY KEY,
    "tenant_id"  UUID NOT NULL,
    "user_id"    INTEGER,
    "wa_msg_id"  VARCHAR(100) UNIQUE,
    "direccion"  VARCHAR(10)  NOT NULL,
    "tipo"       VARCHAR(30)  NOT NULL,
    "contenido"  JSONB        NOT NULL,
    "leido"      BOOLEAN      NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
    FOREIGN KEY ("user_id")   REFERENCES "users"("id")
);

CREATE INDEX "mensajes_tenant_user_idx"   ON "mensajes"("tenant_id", "user_id");
CREATE INDEX "mensajes_tenant_created_idx" ON "mensajes"("tenant_id", "created_at");
