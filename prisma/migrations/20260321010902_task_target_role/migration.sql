-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "role_id" TEXT;

-- CreateIndex
CREATE INDEX "tasks_role_id_idx" ON "tasks"("role_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
