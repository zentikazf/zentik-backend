-- ============================================================================
-- Migration: Tickets ↔ Kanban Bidirectional Sync
-- Fecha: 2026-04-29
-- Cambios:
--   1. TicketStatus: agregar IN_REVIEW
--   2. Tickets: agregar close_reason, close_note, closed_at, closed_by_user_id
--   3. Tickets: agregar índices compuestos para performance
--   4. Nueva tabla ticket_events para audit log unificado
--   5. Nuevos enums: TicketEventType, TicketEventSource, TicketCloseReason
-- Idempotente: usa IF NOT EXISTS donde es posible.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Extender TicketStatus con IN_REVIEW (entre IN_PROGRESS y RESOLVED)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'IN_REVIEW' BEFORE 'RESOLVED';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Crear nuevos enums (TicketEventType, TicketEventSource, TicketCloseReason)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE "TicketEventType" AS ENUM (
        'STATUS_CHANGE',
        'ASSIGNED',
        'UNASSIGNED',
        'KANBAN_MOVE',
        'CLOSED',
        'REOPENED',
        'COMMENT_ADDED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TicketEventSource" AS ENUM (
        'TICKET',
        'KANBAN',
        'SYSTEM'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TicketCloseReason" AS ENUM (
        'RESOLVED_BY_SUPPORT',
        'RESOLVED_BY_CLIENT',
        'DUPLICATE',
        'SPAM',
        'OTHER'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Agregar columnas de cierre al modelo Ticket
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "tickets"
    ADD COLUMN IF NOT EXISTS "close_reason"        "TicketCloseReason",
    ADD COLUMN IF NOT EXISTS "close_note"          TEXT,
    ADD COLUMN IF NOT EXISTS "closed_at"           TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "closed_by_user_id"   TEXT;

-- FK del cierre (SET NULL si el usuario es eliminado, no perdemos el ticket)
DO $$ BEGIN
    ALTER TABLE "tickets"
        ADD CONSTRAINT "tickets_closed_by_user_id_fkey"
        FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Índices nuevos en tickets (performance del listado por tab + filtro)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "tickets_organization_id_status_created_at_idx"
    ON "tickets"("organization_id", "status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "tickets_closed_at_idx"
    ON "tickets"("closed_at");

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Crear tabla ticket_events (audit log unificado ticket+kanban)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ticket_events" (
    "id"          TEXT                  NOT NULL,
    "ticket_id"   TEXT                  NOT NULL,
    "type"        "TicketEventType"     NOT NULL,
    "from_value"  TEXT,
    "to_value"    TEXT,
    "source"      "TicketEventSource"   NOT NULL DEFAULT 'TICKET',
    "metadata"    JSONB,
    "user_id"     TEXT,
    "created_at"  TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- Índices de la tabla nueva
CREATE INDEX IF NOT EXISTS "ticket_events_ticket_id_created_at_idx"
    ON "ticket_events"("ticket_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "ticket_events_user_id_idx"
    ON "ticket_events"("user_id");

CREATE INDEX IF NOT EXISTS "ticket_events_type_idx"
    ON "ticket_events"("type");

-- Foreign keys de la tabla nueva
DO $$ BEGIN
    ALTER TABLE "ticket_events"
        ADD CONSTRAINT "ticket_events_ticket_id_fkey"
        FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ticket_events"
        ADD CONSTRAINT "ticket_events_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- FIN MIGRATION — sin DROP, sin renombres. 100% aditivo y compatible.
-- ============================================================================
