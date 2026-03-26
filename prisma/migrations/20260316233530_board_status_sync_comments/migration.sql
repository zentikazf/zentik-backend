-- AlterTable
ALTER TABLE "board_columns" ADD COLUMN     "mapped_status" "TaskStatus";

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "comment_id" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "start_date" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "files_comment_id_idx" ON "files"("comment_id");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
