-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('PROJECT', 'SUPPORT');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "type" "TaskType" NOT NULL DEFAULT 'PROJECT';

-- Migrate existing data: tasks created from tickets are SUPPORT
UPDATE "tasks" SET "type" = 'SUPPORT' WHERE "title" LIKE '[Ticket]%';
