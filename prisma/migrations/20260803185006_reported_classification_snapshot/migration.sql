-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "reported_criticality" "TicketCriticality",
ADD COLUMN     "reported_ticket_type_id" TEXT;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_reported_ticket_type_id_fkey" FOREIGN KEY ("reported_ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
