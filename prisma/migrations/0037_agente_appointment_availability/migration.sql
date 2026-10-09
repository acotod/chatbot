-- Migration 0037: decouple appointment-booking availability from agente.estado
ALTER TABLE "agentes"
  ADD COLUMN IF NOT EXISTS "disponible_para_citas" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "ausente_hasta" TIMESTAMP(3);
