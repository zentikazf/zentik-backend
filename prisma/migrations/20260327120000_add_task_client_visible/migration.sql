-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "client_visible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN "review_attempts" INTEGER NOT NULL DEFAULT 0;
