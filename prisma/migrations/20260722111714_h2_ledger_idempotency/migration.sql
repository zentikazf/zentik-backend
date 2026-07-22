-- AlterTable
ALTER TABLE "hours_transactions" ADD COLUMN     "entry_version" INTEGER,
ADD COLUMN     "time_entry_id" TEXT;

-- AlterTable
ALTER TABLE "time_entries" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- H2: índice único PARCIAL (idempotencia de escritura del ledger).
-- El predicado WHERE time_entry_id IS NOT NULL excluye las filas históricas (que quedan NULL),
-- por eso esta migración no puede fallar por datos preexistentes. Prisma 5.x no expresa índices
-- parciales, por eso se escribe a mano acá (no declarar @@unique en el schema).
CREATE UNIQUE INDEX "hours_transactions_time_entry_id_entry_version_key"
  ON "hours_transactions" ("time_entry_id", "entry_version")
  WHERE "time_entry_id" IS NOT NULL;
