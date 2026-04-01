-- Actualizar datos existentes ANTES de cambiar el tipo
UPDATE "Project" SET status = 'DISCOVERY' WHERE status = 'DEFINITION';
UPDATE "Project" SET status = 'DEPLOY' WHERE status = 'PRODUCTION';

-- Renombrar enum viejo
ALTER TYPE "ProjectStatus" RENAME TO "ProjectStatus_old";

-- Crear enum nuevo con los 8 valores
CREATE TYPE "ProjectStatus" AS ENUM (
  'DISCOVERY', 'PLANNING', 'DEVELOPMENT', 'TESTING',
  'DEPLOY', 'SUPPORT', 'ON_HOLD', 'COMPLETED'
);

-- Migrar la columna al nuevo tipo
ALTER TABLE "Project"
  ALTER COLUMN "status" TYPE "ProjectStatus"
  USING "status"::text::"ProjectStatus";

-- Cambiar default
ALTER TABLE "Project"
  ALTER COLUMN "status" SET DEFAULT 'DISCOVERY'::"ProjectStatus";

-- Limpiar
DROP TYPE "ProjectStatus_old";
