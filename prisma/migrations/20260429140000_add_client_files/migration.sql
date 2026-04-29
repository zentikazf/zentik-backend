-- ============================================================================
-- Migration: Add client-level documents to files table
-- Fecha: 2026-04-29
--
-- Cambios:
--   1. Agregar columna client_id (FK a clients) — documentos a nivel cliente
--      independientes de cualquier proyecto (contratos marco, NDAs, legales)
--   2. Agregar columna description — subtitulo/nota opcional del documento
--   3. Indices para performance en listado por cliente
--
-- Idempotente: usa IF NOT EXISTS y DO $$ ... EXCEPTION para que correr
-- la migration multiple veces no rompa.
--
-- NO destructiva: NO elimina ni modifica ninguna columna existente.
-- Las columnas legacy (document_category, parent_file_id, version) se mantienen
-- para preservar data historica aunque la UI ya no las use.
-- ============================================================================

-- 1) Nuevas columnas
ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "client_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "description" TEXT;

-- 2) Foreign key client_id -> clients(id) ON DELETE CASCADE
DO $$ BEGIN
    ALTER TABLE "files"
        ADD CONSTRAINT "files_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "clients"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3) Indices de performance
CREATE INDEX IF NOT EXISTS "files_client_id_idx"
    ON "files"("client_id");

CREATE INDEX IF NOT EXISTS "files_client_id_deleted_at_idx"
    ON "files"("client_id", "deleted_at");

-- ============================================================================
-- FIN MIGRATION — sin DROPs, sin renombres. 100% aditiva.
-- ============================================================================
