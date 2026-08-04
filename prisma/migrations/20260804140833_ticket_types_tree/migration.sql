-- AlterTable
ALTER TABLE "ticket_types" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "parent_id" TEXT,
ADD COLUMN     "path" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "ticket_types_organization_id_parent_id_idx" ON "ticket_types"("organization_id", "parent_id");

-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill (#42 Fase 3): los tipos que ya existian pasan a ser RAICES del arbol.
-- `path` se agrego con default '' para poder crear la columna NOT NULL sobre una
-- tabla con filas; sin este UPDATE quedarian todos con path vacio y el orden/
-- busqueda por rama no funcionaria. parent_id ya queda NULL y level en 0, que es
-- exactamente "raiz", asi que no hace falta tocarlos.
UPDATE "ticket_types" SET "path" = "slug" WHERE "path" = '';
