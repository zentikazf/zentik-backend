-- AlterTable
ALTER TABLE "clients" ADD COLUMN "development_hourly_rate" DECIMAL(12,2),
                      ADD COLUMN "support_hourly_rate" DECIMAL(12,2),
                      ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'PYG';
