-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'REVIEWING', 'ACCEPTED', 'REJECTED', 'IMPLEMENTED');

-- CreateEnum
CREATE TYPE "SuggestionPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TASK_APPROVAL_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'TASK_APPROVAL_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'TASK_APPROVAL_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'ALCANCE_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'ALCANCE_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'ALCANCE_REJECTED';

-- AlterTable (clients)
ALTER TABLE "clients" ADD COLUMN "user_id" TEXT;

-- CreateTable
CREATE TABLE "suggestions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "SuggestionPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "admin_notes" TEXT,
    "task_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_user_id_key" ON "clients"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "suggestions_task_id_key" ON "suggestions"("task_id");

-- CreateIndex
CREATE INDEX "suggestions_project_id_idx" ON "suggestions"("project_id");

-- CreateIndex
CREATE INDEX "suggestions_client_id_idx" ON "suggestions"("client_id");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
