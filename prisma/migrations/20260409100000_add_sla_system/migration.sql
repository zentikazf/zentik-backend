-- CreateEnum
CREATE TYPE "TicketCriticality" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "ticket_category_configs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "criticality" "TicketCriticality" NOT NULL DEFAULT 'MEDIUM',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_category_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_configs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "criticality" "TicketCriticality" NOT NULL,
    "response_time_minutes" INTEGER NOT NULL,
    "resolution_time_minutes" INTEGER NOT NULL,

    CONSTRAINT "sla_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_hours_configs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "business_hours_start" TEXT NOT NULL DEFAULT '08:30',
    "business_hours_end" TEXT NOT NULL DEFAULT '17:30',
    "business_days" TEXT NOT NULL DEFAULT '1,2,3,4,5',
    "timezone" TEXT NOT NULL DEFAULT 'America/Asuncion',

    CONSTRAINT "business_hours_configs_pkey" PRIMARY KEY ("id")
);

-- Add SLA columns to tickets
ALTER TABLE "tickets" ADD COLUMN "category_config_id" TEXT;
ALTER TABLE "tickets" ADD COLUMN "criticality" "TicketCriticality";
ALTER TABLE "tickets" ADD COLUMN "response_deadline" TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN "resolution_deadline" TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN "first_response_at" TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN "resolved_at" TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN "sla_response_breached" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tickets" ADD COLUMN "sla_resolution_breached" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tickets" ADD COLUMN "created_by_user_id" TEXT;

-- Add new notification types
ALTER TYPE "NotificationType" ADD VALUE 'SLA_BREACH_WARNING';
ALTER TYPE "NotificationType" ADD VALUE 'SLA_BREACHED';
ALTER TYPE "NotificationType" ADD VALUE 'PROJECT_DEVELOPMENT_STARTED';

-- CreateIndexes
CREATE INDEX "ticket_category_configs_organization_id_idx" ON "ticket_category_configs"("organization_id");
CREATE UNIQUE INDEX "ticket_category_configs_organization_id_name_key" ON "ticket_category_configs"("organization_id", "name");
CREATE UNIQUE INDEX "sla_configs_organization_id_criticality_key" ON "sla_configs"("organization_id", "criticality");
CREATE UNIQUE INDEX "business_hours_configs_organization_id_key" ON "business_hours_configs"("organization_id");
CREATE INDEX "tickets_category_config_id_idx" ON "tickets"("category_config_id");
CREATE INDEX "tickets_sla_response_breached_idx" ON "tickets"("sla_response_breached");
CREATE INDEX "tickets_sla_resolution_breached_idx" ON "tickets"("sla_resolution_breached");

-- AddForeignKeys
ALTER TABLE "ticket_category_configs" ADD CONSTRAINT "ticket_category_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sla_configs" ADD CONSTRAINT "sla_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_hours_configs" ADD CONSTRAINT "business_hours_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_config_id_fkey" FOREIGN KEY ("category_config_id") REFERENCES "ticket_category_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
