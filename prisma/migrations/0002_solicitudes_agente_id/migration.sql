-- AlterTable: add agente_id to solicitudes
ALTER TABLE "solicitudes" ADD COLUMN "agente_id" INTEGER;

-- AddForeignKey
ALTER TABLE "solicitudes" ADD CONSTRAINT "solicitudes_agente_id_fkey" FOREIGN KEY ("agente_id") REFERENCES "agentes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
