-- Migration 0024: admin notifications + permission

CREATE TABLE "admin_notifications" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "admin_user_id" INTEGER NOT NULL,
  "type" VARCHAR(60) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "message" TEXT NOT NULL,
  "data" JSONB,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admin_notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admin_notifications_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "admin_notifications_tenant_id_created_at_idx" ON "admin_notifications"("tenant_id", "created_at");
CREATE INDEX "admin_notifications_admin_user_id_created_at_idx" ON "admin_notifications"("admin_user_id", "created_at");
CREATE INDEX "admin_notifications_tenant_id_admin_user_id_read_at_idx" ON "admin_notifications"("tenant_id", "admin_user_id", "read_at");

INSERT INTO "permisos" ("clave") VALUES
  ('VIEW_NOTIFICATIONS')
ON CONFLICT ("clave") DO NOTHING;
