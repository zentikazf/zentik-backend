-- Add messageId to files for chat attachments
ALTER TABLE "files" ADD COLUMN "message_id" TEXT;

-- Create index for message_id
CREATE INDEX "files_message_id_idx" ON "files"("message_id");

-- Add foreign key constraint
ALTER TABLE "files" ADD CONSTRAINT "files_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
