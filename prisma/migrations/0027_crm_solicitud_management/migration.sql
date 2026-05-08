ALTER TABLE "solicitudes"
ADD COLUMN "categoria" VARCHAR(80),
ADD COLUMN "subcategoria" VARCHAR(120),
ADD COLUMN "due_at" TIMESTAMP(3),
ADD COLUMN "first_response_at" TIMESTAMP(3);

CREATE INDEX "solicitudes_tenant_id_categoria_estado_idx"
ON "solicitudes"("tenant_id", "categoria", "estado");

CREATE INDEX "solicitudes_tenant_id_due_at_idx"
ON "solicitudes"("tenant_id", "due_at");
