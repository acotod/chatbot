CREATE TABLE "agent_password_resets" (
  "id" SERIAL NOT NULL,
  "agente_id" INTEGER NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_password_resets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_password_resets_token_hash_key" ON "agent_password_resets"("token_hash");
CREATE INDEX "agent_password_resets_agente_id_expires_at_idx" ON "agent_password_resets"("agente_id", "expires_at");

ALTER TABLE "agent_password_resets"
ADD CONSTRAINT "agent_password_resets_agente_id_fkey"
FOREIGN KEY ("agente_id") REFERENCES "agentes"("id") ON DELETE CASCADE ON UPDATE CASCADE;