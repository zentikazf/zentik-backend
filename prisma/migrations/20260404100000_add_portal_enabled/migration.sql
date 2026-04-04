-- AlterTable
ALTER TABLE "clients" ADD COLUMN "portal_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Migrate existing data: clients with a user_id already have portal access
UPDATE "clients" SET "portal_enabled" = true WHERE "user_id" IS NOT NULL;
