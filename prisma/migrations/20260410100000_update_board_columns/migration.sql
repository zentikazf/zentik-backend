-- Rename "En progreso" -> "En desarrollo"
UPDATE "board_columns"
SET "name" = 'En desarrollo'
WHERE "name" = 'En progreso' AND "mapped_status" = 'IN_PROGRESS';

-- Rename "Por hacer" -> "Pendiente" and remap BACKLOG -> TODO
UPDATE "board_columns"
SET "name" = 'Pendiente', "mapped_status" = 'TODO'
WHERE "name" = 'Por hacer' AND "mapped_status" = 'BACKLOG';

-- Shift positions +1 for existing columns to make room for "Nuevo" at position 0
-- Only for boards that don't already have a BACKLOG column (i.e. they were just remapped)
UPDATE "board_columns" bc
SET "position" = bc."position" + 1
FROM "boards" b
WHERE bc."board_id" = b."id"
  AND NOT EXISTS (
    SELECT 1 FROM "board_columns" bc2
    WHERE bc2."board_id" = b."id" AND bc2."mapped_status" = 'BACKLOG'
  );

-- Insert "Nuevo" column (BACKLOG) at position 0 for boards missing it
INSERT INTO "board_columns" ("id", "board_id", "name", "position", "color", "mapped_status", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  b."id",
  'Nuevo',
  0,
  '#6366F1',
  'BACKLOG',
  NOW(),
  NOW()
FROM "boards" b
WHERE NOT EXISTS (
  SELECT 1 FROM "board_columns" bc
  WHERE bc."board_id" = b."id" AND bc."mapped_status" = 'BACKLOG'
);

-- Move existing tasks with status BACKLOG to the new "Nuevo" column
UPDATE "tasks" t
SET "board_column_id" = bc."id"
FROM "board_columns" bc
JOIN "boards" b ON bc."board_id" = b."id"
WHERE t."project_id" = b."project_id"
  AND t."status" = 'BACKLOG'
  AND bc."mapped_status" = 'BACKLOG'
  AND (t."board_column_id" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "board_columns" bc2 WHERE bc2."id" = t."board_column_id"
  ));

-- Move existing tasks with status TODO to the "Pendiente" column
UPDATE "tasks" t
SET "board_column_id" = bc."id"
FROM "board_columns" bc
JOIN "boards" b ON bc."board_id" = b."id"
WHERE t."project_id" = b."project_id"
  AND t."status" = 'TODO'
  AND bc."mapped_status" = 'TODO'
  AND (t."board_column_id" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "board_columns" bc2 WHERE bc2."id" = t."board_column_id"
  ));
