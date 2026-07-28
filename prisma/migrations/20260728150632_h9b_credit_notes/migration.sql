-- AlterTable
ALTER TABLE "hours_transactions" ADD COLUMN     "rebilled_from_transaction_id" TEXT;

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "applies_to_cycle_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "return_hours_to_billable" BOOLEAN NOT NULL DEFAULT true,
    "total_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "issued_by_id" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_lines" (
    "id" TEXT NOT NULL,
    "credit_note_id" TEXT NOT NULL,
    "credited_transaction_id" TEXT NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "priceAmount" DECIMAL(15,2) NOT NULL,
    "priceRate" DECIMAL(12,2),
    "priceCurrency" TEXT,
    "worked_on" DATE,
    "description" TEXT,

    CONSTRAINT "credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_notes_applies_to_cycle_id_idx" ON "credit_notes"("applies_to_cycle_id");

-- CreateIndex
CREATE INDEX "credit_notes_client_id_idx" ON "credit_notes"("client_id");

-- CreateIndex
CREATE INDEX "credit_notes_organization_id_idx" ON "credit_notes"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_organization_id_number_key" ON "credit_notes"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_lines_credited_transaction_id_key" ON "credit_note_lines"("credited_transaction_id");

-- CreateIndex
CREATE INDEX "credit_note_lines_credit_note_id_idx" ON "credit_note_lines"("credit_note_id");

-- CreateIndex
CREATE INDEX "hours_transactions_rebilled_from_transaction_id_idx" ON "hours_transactions"("rebilled_from_transaction_id");

-- AddForeignKey
ALTER TABLE "hours_transactions" ADD CONSTRAINT "hours_transactions_rebilled_from_transaction_id_fkey" FOREIGN KEY ("rebilled_from_transaction_id") REFERENCES "hours_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_applies_to_cycle_id_fkey" FOREIGN KEY ("applies_to_cycle_id") REFERENCES "client_billing_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credited_transaction_id_fkey" FOREIGN KEY ("credited_transaction_id") REFERENCES "hours_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
