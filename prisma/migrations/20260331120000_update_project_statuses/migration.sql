-- Renombrar valores existentes del enum (PostgreSQL 10+)
ALTER TYPE "ProjectStatus" RENAME VALUE 'DEFINITION' TO 'DISCOVERY';
ALTER TYPE "ProjectStatus" RENAME VALUE 'PRODUCTION' TO 'DEPLOY';

-- Agregar valores nuevos
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'PLANNING';
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'TESTING';
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'SUPPORT';

-- Actualizar el default del modelo Project
ALTER TABLE "Project" ALTER COLUMN "status" SET DEFAULT 'DISCOVERY'::"ProjectStatus";
