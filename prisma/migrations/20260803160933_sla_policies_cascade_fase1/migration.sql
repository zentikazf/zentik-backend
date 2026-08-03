-- CreateEnum
CREATE TYPE "SlaSource" AS ENUM ('CONTRACT', 'PROJECT', 'CLIENT', 'CRITICALITY', 'STANDARD', 'NONE');

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "default_sla_policy_id" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "sla_policy_id" TEXT;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "sla_policy_id" TEXT,
ADD COLUMN     "sla_source" "SlaSource",
ADD COLUMN     "ticket_type_id" TEXT;

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "criticality" "TicketCriticality" NOT NULL,
    "first_response_hours" INTEGER NOT NULL,
    "resolution_hours" INTEGER NOT NULL,
    "pauses_on_waiting" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_types" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_ticket_type_slas" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "ticket_type_id" TEXT NOT NULL,
    "sla_policy_id" TEXT NOT NULL,
    "contract_notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_ticket_type_slas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sla_policies_organization_id_criticality_idx" ON "sla_policies"("organization_id", "criticality");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_organization_id_name_key" ON "sla_policies"("organization_id", "name");

-- CreateIndex
CREATE INDEX "ticket_types_organization_id_is_active_idx" ON "ticket_types"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_types_organization_id_slug_key" ON "ticket_types"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "project_ticket_type_slas_project_id_is_active_idx" ON "project_ticket_type_slas"("project_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "project_ticket_type_slas_project_id_ticket_type_id_key" ON "project_ticket_type_slas"("project_id", "ticket_type_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_default_sla_policy_id_fkey" FOREIGN KEY ("default_sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_ticket_type_slas" ADD CONSTRAINT "project_ticket_type_slas_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_ticket_type_slas" ADD CONSTRAINT "project_ticket_type_slas_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_ticket_type_slas" ADD CONSTRAINT "project_ticket_type_slas_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
