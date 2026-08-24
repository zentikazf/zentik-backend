-- AlterTable
ALTER TABLE "client_billing_cycles" ADD COLUMN     "net_amount" DECIMAL(15,2),
ADD COLUMN     "tax_amount" DECIMAL(15,2),
ADD COLUMN     "tax_mode" TEXT,
ADD COLUMN     "tax_rate" DECIMAL(5,4);

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "tax_mode" TEXT,
ADD COLUMN     "tax_rate" DECIMAL(5,4);

-- AlterTable
ALTER TABLE "credit_notes" ADD COLUMN     "net_amount" DECIMAL(15,2),
ADD COLUMN     "tax_amount" DECIMAL(15,2),
ADD COLUMN     "tax_mode" TEXT,
ADD COLUMN     "tax_rate" DECIMAL(5,4);
