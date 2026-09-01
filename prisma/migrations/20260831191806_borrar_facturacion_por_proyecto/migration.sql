/*
  Warnings:

  - You are about to drop the `invoice_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `invoices` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_invoice_id_fkey";

-- DropForeignKey
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_task_id_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_project_id_fkey";

-- DropTable
DROP TABLE "invoice_items";

-- DropTable
DROP TABLE "invoices";

-- DropEnum
DROP TYPE "InvoiceStatus";
