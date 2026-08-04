-- AlterEnum
ALTER TYPE "TicketEventType" ADD VALUE 'RECLASSIFIED';

-- CreateTable
CREATE TABLE "ticket_criticality_configs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "criticality" "TicketCriticality" NOT NULL,
    "display_name" TEXT NOT NULL,
    "client_label" TEXT,
    "client_visible" BOOLEAN NOT NULL DEFAULT true,
    "level" INTEGER NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_criticality_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_criticality_configs_organization_id_client_visible_idx" ON "ticket_criticality_configs"("organization_id", "client_visible");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_criticality_configs_organization_id_criticality_key" ON "ticket_criticality_configs"("organization_id", "criticality");

-- AddForeignKey
ALTER TABLE "ticket_criticality_configs" ADD CONSTRAINT "ticket_criticality_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
