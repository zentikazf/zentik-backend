-- Fix: columns were marked as applied but never created in the database
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'review_attempts') THEN
    ALTER TABLE "tasks" ADD COLUMN "review_attempts" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'client_visible') THEN
    ALTER TABLE "tasks" ADD COLUMN "client_visible" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
