-- Cambiar el unique de `ticket_number` de GLOBAL a PER ORGANIZATION.
-- Antes: una org no podia generar un numero que otra org ya haya usado
-- (ej: 20260424-001 global) -> colisiones entre organizaciones.
-- Ahora: cada organizacion tiene su propia secuencia diaria.

-- DropIndex
DROP INDEX "tickets_ticket_number_key";

-- CreateIndex
CREATE UNIQUE INDEX "tickets_organization_id_ticket_number_key" ON "tickets"("organization_id", "ticket_number");
