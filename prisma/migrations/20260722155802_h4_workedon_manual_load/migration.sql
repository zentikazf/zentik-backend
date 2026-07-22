-- CreateEnum
CREATE TYPE "TimeEntryOrigin" AS ENUM ('MANUAL', 'TIMER', 'SEED');

-- AlterTable
ALTER TABLE "time_entries" ADD COLUMN     "corrected_at" TIMESTAMP(3),
ADD COLUMN     "corrected_by_id" TEXT,
ADD COLUMN     "correction_note" TEXT,
ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "delete_reason" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_by_id" TEXT,
ADD COLUMN     "minutes" INTEGER,
ADD COLUMN     "origin" "TimeEntryOrigin",
ADD COLUMN     "previous_minutes" INTEGER,
ADD COLUMN     "worked_on" DATE;

-- CreateIndex
CREATE INDEX "time_entries_worked_on_idx" ON "time_entries"("worked_on");

-- CreateIndex
CREATE INDEX "time_entries_deleted_at_idx" ON "time_entries"("deleted_at");

-- H4 (SQL raw, anexado a mano — Prisma 5.x no expresa el predicado WHERE de un índice único parcial):
-- Regla de negocio "una entrada por (tarea, usuario, día) viva, NO acumulativa".
-- El predicado hace que el índice arranque VACÍO: todas las filas legacy tienen worked_on = NULL → no se indexan
-- (imposible colisionar al crearlo). deleted_at IS NULL libera el slot al hacer soft delete (se puede recargar ese día).
-- CreateIndex
CREATE UNIQUE INDEX "time_entries_task_user_worked_on_key"
  ON "time_entries" ("task_id", "user_id", "worked_on")
  WHERE "worked_on" IS NOT NULL AND "deleted_at" IS NULL;
