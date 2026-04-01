-- Add TICKET to ChannelType enum
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'TICKET';

-- Add new NotificationType values for tickets
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TICKET_CREATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TICKET_MESSAGE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TICKET_UPDATED';

-- Create TicketCategory enum
CREATE TYPE "TicketCategory" AS ENUM ('SUPPORT_REQUEST', 'NEW_DEVELOPMENT');

-- Create TicketStatus enum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- Create tickets table
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "TicketCategory" NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "SuggestionPriority" NOT NULL DEFAULT 'MEDIUM',
    "admin_notes" TEXT,
    "task_id" TEXT,
    "channel_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- Unique indexes
CREATE UNIQUE INDEX "tickets_task_id_key" ON "tickets"("task_id");
CREATE UNIQUE INDEX "tickets_channel_id_key" ON "tickets"("channel_id");

-- Regular indexes
CREATE INDEX "tickets_organization_id_idx" ON "tickets"("organization_id");
CREATE INDEX "tickets_project_id_idx" ON "tickets"("project_id");
CREATE INDEX "tickets_client_id_idx" ON "tickets"("client_id");
CREATE INDEX "tickets_status_idx" ON "tickets"("status");

-- Foreign keys
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
