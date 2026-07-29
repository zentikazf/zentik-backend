-- AlterTable
ALTER TABLE "client_billing_cycles" ADD COLUMN     "variables_billing" JSONB;

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "botmaker_account_id" TEXT;

-- CreateTable
CREATE TABLE "client_billing_statements" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "billed_cycle_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_billing_statements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_billing_statements_client_period_uq" ON "client_billing_statements"("client_id", "period");

-- AddForeignKey
ALTER TABLE "client_billing_statements" ADD CONSTRAINT "client_billing_statements_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
