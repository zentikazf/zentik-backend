-- AlterTable
ALTER TABLE "hours_transactions" ADD COLUMN "reverses_transaction_id" TEXT;

-- AddForeignKey
ALTER TABLE "hours_transactions" ADD CONSTRAINT "hours_transactions_reverses_transaction_id_fkey"
  FOREIGN KEY ("reverses_transaction_id") REFERENCES "hours_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "hours_transactions_reverses_transaction_id_idx" ON "hours_transactions"("reverses_transaction_id");

-- H9a: índice único PARCIAL (un cargo se revierte a lo sumo una vez — anti doble-REFUND/doble-decremento).
-- El predicado WHERE reverses_transaction_id IS NOT NULL excluye las filas históricas (quedan NULL),
-- por eso esta migración no puede fallar por datos preexistentes. Prisma 5.x no expresa índices
-- parciales, por eso se escribe a mano acá (no declarar @@unique en el schema) — patrón H2.
CREATE UNIQUE INDEX "hours_transactions_reverses_transaction_id_key"
  ON "hours_transactions" ("reverses_transaction_id")
  WHERE "reverses_transaction_id" IS NOT NULL;
