-- AlterTable
ALTER TABLE "tickets" ADD COLUMN "ticket_number" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tickets_ticket_number_key" ON "tickets"("ticket_number");
