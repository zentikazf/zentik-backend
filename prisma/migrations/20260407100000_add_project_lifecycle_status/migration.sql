-- CreateEnum
CREATE TYPE "ProjectLifecycleStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "lifecycle_status" "ProjectLifecycleStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "projects_organization_id_lifecycle_status_idx" ON "projects"("organization_id", "lifecycle_status");
