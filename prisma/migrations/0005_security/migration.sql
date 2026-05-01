-- AlterTable: add brute-force fields to admin_users
ALTER TABLE "admin_users" ADD COLUMN "failed_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "admin_users" ADD COLUMN "locked_until" TIMESTAMP(3);

-- AlterTable: add ip + userAgent to audit_logs
ALTER TABLE "audit_logs" ADD COLUMN "ip" VARCHAR(45);
ALTER TABLE "audit_logs" ADD COLUMN "user_agent" VARCHAR(500);

-- CreateTable: refresh_tokens
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "admin_user_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_admin_user_id_idx" ON "refresh_tokens"("admin_user_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
