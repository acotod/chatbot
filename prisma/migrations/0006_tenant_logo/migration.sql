-- AlterTable: add logo_url to tenants
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "logo_url" VARCHAR(500);
