-- Step 1: Create new ProjectStatus enum
CREATE TYPE "ProjectStatus_new" AS ENUM ('DEFINITION', 'DEVELOPMENT', 'PRODUCTION', 'ON_HOLD', 'COMPLETED');

-- Step 2: Drop the default so ALTER TYPE works
ALTER TABLE "projects" ALTER COLUMN "status" DROP DEFAULT;

-- Step 3: Alter column type with data migration
ALTER TABLE "projects" ALTER COLUMN "status" TYPE "ProjectStatus_new"
  USING (
    CASE "status"::text
      WHEN 'PLANNING' THEN 'DEFINITION'
      WHEN 'ACTIVE' THEN 'DEVELOPMENT'
      WHEN 'ARCHIVED' THEN 'COMPLETED'
      ELSE "status"::text
    END
  )::"ProjectStatus_new";

-- Step 4: Set new default
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'DEFINITION'::"ProjectStatus_new";

-- Step 5: Drop old enum and rename
DROP TYPE "ProjectStatus";
ALTER TYPE "ProjectStatus_new" RENAME TO "ProjectStatus";

-- Step 6: Add MEETING_SCHEDULED to NotificationType
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MEETING_SCHEDULED';

-- Step 7: Create meetings table
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),
    "location" TEXT,
    "notify_client" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meetings_project_id_idx" ON "meetings"("project_id");
CREATE INDEX "meetings_date_idx" ON "meetings"("date");

ALTER TABLE "meetings" ADD CONSTRAINT "meetings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
