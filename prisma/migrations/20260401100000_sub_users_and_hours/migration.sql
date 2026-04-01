-- Épica 7: Sub-usuarios de cliente
-- Add client_id to users table for sub-user relation
ALTER TABLE "users" ADD COLUMN "client_id" TEXT;
CREATE INDEX "users_client_id_idx" ON "users"("client_id");
ALTER TABLE "users" ADD CONSTRAINT "users_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Épica 8: Horas contratadas
-- Add hours fields to clients
ALTER TABLE "clients" ADD COLUMN "contracted_hours" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "clients" ADD COLUMN "used_hours" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "clients" ADD COLUMN "loaned_hours" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Create hours_transactions table
CREATE TABLE "hours_transactions" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "task_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hours_transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hours_transactions_client_id_idx" ON "hours_transactions"("client_id");
CREATE INDEX "hours_transactions_task_id_idx" ON "hours_transactions"("task_id");
CREATE INDEX "hours_transactions_type_idx" ON "hours_transactions"("type");
CREATE INDEX "hours_transactions_created_at_idx" ON "hours_transactions"("created_at");

ALTER TABLE "hours_transactions" ADD CONSTRAINT "hours_transactions_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hours_transactions" ADD CONSTRAINT "hours_transactions_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
