-- AlterTable
ALTER TABLE "client_billing_cycles" ADD COLUMN     "cutoff_date" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "hours_transactions" ADD COLUMN     "worked_on" DATE;

-- CreateIndex
CREATE INDEX "hours_transactions_worked_on_idx" ON "hours_transactions"("worked_on");

-- ── H8a: BACKFILL (DML anexado a mano, patrón H2/H4 — corre atómico con el DDL en
--    migrate deploy; idempotente por WHERE worked_on IS NULL, re-corrible sin efecto). ──

-- Paso 1 — join preciso: worked_on REAL de la carga MANUAL. DATE = DATE, sin cast.
UPDATE "hours_transactions" ht
SET    "worked_on" = te."worked_on"
FROM   "time_entries" te
WHERE  ht."time_entry_id" = te."id"
  AND  te."worked_on" IS NOT NULL
  AND  ht."worked_on" IS NULL;

-- Paso 2 — fallback catch-all (sin time_entry_id, FK colgante, o TimeEntry.worked_on NULL):
--    created_at -> fecha de calendario de Asuncion.
--    created_at es TIMESTAMP(3) SIN time zone y guarda UTC -> el cast es DOBLE:
--      'UTC'              promueve el valor almacenado a un instante real (timestamptz)
--      'America/Asuncion' lo convierte a hora de pared local (timestamp sin tz)
--      ::date             toma el dia de calendario (independiente del TZ de sesion)
--    Un solo AT TIME ZONE 'America/Asuncion' interpretaria el valor como si ya fuera hora
--    de Asuncion (falso) y dejaria el ::date dependiente de la sesion -> off-by-one de mes
--    en el borde (30-jun 21:30 Asu = 01-jul 00:30 UTC caeria en julio).
UPDATE "hours_transactions"
SET    "worked_on" = (("created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Asuncion')::date
WHERE  "worked_on" IS NULL;

-- cutoff_date NO se backfillea: nace dormida (la escribe H8b).
