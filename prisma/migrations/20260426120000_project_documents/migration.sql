-- Compartir documentos del proyecto con el cliente: extender File + tracking de descargas.
-- Datos existentes: NO se afectan. Todos los archivos preexistentes quedan con
-- project_id NULL, client_visible false, version 1, deleted_at NULL.

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('SCOPE', 'BUDGET', 'MOCKUP', 'DOCUMENTATION', 'OTHER');

-- AlterTable
ALTER TABLE "files" ADD COLUMN "project_id" TEXT;
ALTER TABLE "files" ADD COLUMN "client_visible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "files" ADD COLUMN "document_category" "DocumentCategory";
ALTER TABLE "files" ADD COLUMN "parent_file_id" TEXT;
ALTER TABLE "files" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "files" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "files" ADD COLUMN "deleted_by_id" TEXT;

-- CreateIndex
CREATE INDEX "files_project_id_idx" ON "files"("project_id");
CREATE INDEX "files_client_visible_idx" ON "files"("client_visible");
CREATE INDEX "files_document_category_idx" ON "files"("document_category");
CREATE INDEX "files_deleted_at_idx" ON "files"("deleted_at");
CREATE INDEX "files_parent_file_id_idx" ON "files"("parent_file_id");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "files" ADD CONSTRAINT "files_parent_file_id_fkey"
  FOREIGN KEY ("parent_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "files" ADD CONSTRAINT "files_deleted_by_id_fkey"
  FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: tracking de descargas
CREATE TABLE "file_download_events" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "downloaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "file_download_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_download_events_file_id_idx" ON "file_download_events"("file_id");
CREATE INDEX "file_download_events_user_id_idx" ON "file_download_events"("user_id");
CREATE INDEX "file_download_events_downloaded_at_idx" ON "file_download_events"("downloaded_at");

-- AddForeignKey
ALTER TABLE "file_download_events" ADD CONSTRAINT "file_download_events_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "file_download_events" ADD CONSTRAINT "file_download_events_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
