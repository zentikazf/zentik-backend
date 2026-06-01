-- ============================================================================
-- Migration: Tabla failed_emails - persistencia de envios fallidos
-- Fecha: 2026-05-19
--
-- Cambios:
--   1. Crear tabla failed_emails para registrar emails que fallaron tras
--      reintentos automaticos del AsyncEmailDispatcher.
--   2. Indice por created_at para listados/cleanup.
--
-- Idempotente: usa IF NOT EXISTS para que correr la migration multiples veces
-- no rompa.
--
-- NO destructiva: solo crea tabla nueva e indice. No toca tablas existentes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "failed_emails" (
    "id"              TEXT NOT NULL,
    "to"              TEXT NOT NULL,
    "subject"         TEXT NOT NULL,
    "html"            TEXT NOT NULL,
    "from_name"       TEXT,
    "error"           TEXT NOT NULL,
    "attempts"        INTEGER NOT NULL DEFAULT 3,
    "last_attempt_at" TIMESTAMP(3) NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_emails_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "failed_emails_created_at_idx"
    ON "failed_emails"("created_at");

-- ============================================================================
-- FIN MIGRATION - sin DROPs, sin renombres. 100% aditiva.
-- ============================================================================
