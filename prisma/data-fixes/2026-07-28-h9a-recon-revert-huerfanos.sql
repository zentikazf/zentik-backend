-- ============================================================================
-- H9a — Reconstrucción 2A: neutralizar cargas revertidas huérfanas (data-only)
-- ============================================================================
-- QUÉ: parea cada REFUND histórico (sin link) con la carga USAGE/LOAN viva que revirtió y
--   (1) tombstonea la carga (deleted_at + motivo centinela; priceAmount INTACTO, reversible),
--   (2) backfillea el link reverses_transaction_id en el REFUND.
-- QUÉ NO TOCA: contadores (used/loaned/contracted — el cupo ya está net-cero), filas facturadas
--   (billed_cycle_id IS NOT NULL — hoy no existen en prod; si aparecen se REPORTAN, jamás se mutan),
--   PURCHASE/INTERNAL, ninguna otra tabla. deleted_by_id queda NULL (FK a users; el centinela
--   va en delete_reason).
-- ORDEN: correr DESPUÉS de deployar el forward-fix H9a + la migración (si no, el sangrado sigue).
-- IDEMPOTENTE: re-run = no-op (los REFUND linkeados y las cargas tombstoneadas salen del pareo;
--   el único parcial rebota cualquier doble-link con error → ROLLBACK completo).
-- USO: psql "$DATABASE_URL" -f 2026-07-28-h9a-recon-revert-huerfanos.sql
--   Por defecto SOLO corre la FASE 0 (dry-run, cero writes). Para aplicar, descomentar la FASE 1.
-- ============================================================================

-- ──────────────────────────── FASE 0 — DRY-RUN (cero writes) ────────────────────────────

-- Pareo: k-ésimo REFUND sin link ↔ k-ésima carga viva sin facturar, por (client, task, hours).
-- Cargas ordenadas DESC (espeja el "más reciente" del runtime). Solo se parean cantidades iguales:
-- si hay más REFUNDs que cargas vivas (doble-revert histórico) el excedente queda sin par y se reporta.
CREATE TEMP TABLE h9a_pairs AS
WITH refunds AS (
  SELECT id, client_id, task_id, hours,
         ROW_NUMBER() OVER (PARTITION BY client_id, task_id, hours ORDER BY created_at ASC) AS rn
  FROM hours_transactions
  WHERE type = 'REFUND' AND deleted_at IS NULL AND reverses_transaction_id IS NULL
),
usages AS (
  SELECT id, client_id, task_id, hours, price_amount,
         ROW_NUMBER() OVER (PARTITION BY client_id, task_id, hours ORDER BY created_at DESC) AS rn
  FROM hours_transactions
  WHERE type IN ('USAGE', 'LOAN') AND deleted_at IS NULL AND billed_cycle_id IS NULL
)
SELECT r.id AS refund_id, u.id AS usage_id, r.client_id, r.task_id, r.hours, u.price_amount
FROM refunds r
JOIN usages u
  ON u.client_id = r.client_id
 AND u.task_id IS NOT DISTINCT FROM r.task_id
 AND u.hours = r.hours
 AND u.rn = r.rn;

-- Reporte 1: facturable ANTES / a neutralizar / DESPUÉS, por cliente.
SELECT c.name AS cliente,
       COALESCE(before_sum.total, 0) AS facturable_antes,
       COALESCE(tomb.total, 0)       AS a_neutralizar,
       COALESCE(before_sum.total, 0) - COALESCE(tomb.total, 0) AS facturable_despues,
       COALESCE(tomb.filas, 0)       AS filas_a_tombstonear
FROM clients c
LEFT JOIN (
  SELECT client_id, SUM(price_amount) AS total
  FROM hours_transactions
  WHERE type IN ('USAGE','LOAN') AND deleted_at IS NULL AND price_amount IS NOT NULL
    AND billed_cycle_id IS NULL
  GROUP BY client_id
) before_sum ON before_sum.client_id = c.id
LEFT JOIN (
  SELECT p.client_id, SUM(p.price_amount) AS total, COUNT(*) AS filas
  FROM h9a_pairs p
  GROUP BY p.client_id
) tomb ON tomb.client_id = c.id
WHERE before_sum.total IS NOT NULL OR tomb.total IS NOT NULL
ORDER BY c.name;

-- Reporte 2 (anomalía A): REFUNDs sin par (más reverts que cargas vivas = doble-revert histórico).
-- Se dejan SIN tocar; revisar a mano.
WITH refunds AS (
  SELECT id, client_id, task_id, hours,
         ROW_NUMBER() OVER (PARTITION BY client_id, task_id, hours ORDER BY created_at ASC) AS rn
  FROM hours_transactions
  WHERE type = 'REFUND' AND deleted_at IS NULL AND reverses_transaction_id IS NULL
)
SELECT r.id AS refund_sin_par, r.client_id, r.task_id, r.hours
FROM refunds r
LEFT JOIN h9a_pairs p ON p.refund_id = r.id
WHERE p.refund_id IS NULL
ORDER BY r.client_id, r.task_id;

-- Reporte 3 (anomalía B — GUARD, debe dar 0 filas hoy): cargas facturadas con REFUND huérfano.
-- Si aparece algo acá, NO se muta nada de esto: va a nota de crédito (H9b). Decisión del dueño.
WITH refunds AS (
  SELECT client_id, task_id, hours,
         COUNT(*) AS refunds_sin_link
  FROM hours_transactions
  WHERE type = 'REFUND' AND deleted_at IS NULL AND reverses_transaction_id IS NULL
  GROUP BY client_id, task_id, hours
)
SELECT ht.id AS usage_facturada, ht.client_id, ht.task_id, ht.hours, ht.billed_cycle_id
FROM hours_transactions ht
JOIN refunds r
  ON r.client_id = ht.client_id AND r.task_id IS NOT DISTINCT FROM ht.task_id AND r.hours = ht.hours
WHERE ht.type IN ('USAGE','LOAN') AND ht.deleted_at IS NULL AND ht.billed_cycle_id IS NOT NULL;

-- ──────────────────── FASE 1 — APLICAR (descomentar tras revisar el dry-run) ────────────────────
-- BEGIN;
--
-- -- (1) Backfill del link en los REFUND (el único parcial rebota doble-link → ROLLBACK total).
-- UPDATE hours_transactions ht
-- SET reverses_transaction_id = p.usage_id
-- FROM h9a_pairs p
-- WHERE ht.id = p.refund_id;
--
-- -- (2) Tombstone de las cargas revertidas (reversible: solo deleted_at + motivo; precio intacto).
-- UPDATE hours_transactions ht
-- SET deleted_at = now(),
--     delete_reason = 'H9a-recon: revert huerfano (REFUND ' || p.refund_id || ')'
-- FROM h9a_pairs p
-- WHERE ht.id = p.usage_id
--   AND ht.deleted_at IS NULL;
--
-- -- Verificación en-tx: los 3 conteos deben COINCIDIR. Scopeados a los pares/centinela del recon:
-- -- los REFUNDs que el runtime linkee entre el deploy del forward-fix y esta corrida NO cuentan acá.
-- SELECT (SELECT COUNT(*) FROM h9a_pairs) AS pares,
--        (SELECT COUNT(*) FROM hours_transactions
--           WHERE id IN (SELECT refund_id FROM h9a_pairs)
--             AND reverses_transaction_id IS NOT NULL) AS refunds_linkeados,
--        (SELECT COUNT(*) FROM hours_transactions WHERE delete_reason LIKE 'H9a-recon%') AS cargas_tombstoneadas;
--
-- COMMIT;
