-- AlterTable
ALTER TABLE "client_billing_cycles" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_by_id" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'MONTH';

-- AddForeignKey
ALTER TABLE "client_billing_cycles" ADD CONSTRAINT "client_billing_cycles_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
