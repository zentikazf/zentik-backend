-- CreateEnum: ClientStatus
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ARCHIVED');

-- AlterTable: Add status column to clients
ALTER TABLE "clients" ADD COLUMN "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE';
