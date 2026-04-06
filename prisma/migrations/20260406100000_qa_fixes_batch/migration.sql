-- CreateEnum: ClientStatus
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ARCHIVED');

-- AlterTable: Add status to Client
ALTER TABLE "clients" ADD COLUMN "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable: Add isSystem to Comment
ALTER TABLE "comments" ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Add pendingClientReview to Project
ALTER TABLE "projects" ADD COLUMN "pending_client_review" BOOLEAN NOT NULL DEFAULT false;

-- AlterEnum: Add NEW_PROJECT to TicketCategory
ALTER TYPE "TicketCategory" ADD VALUE 'NEW_PROJECT';
