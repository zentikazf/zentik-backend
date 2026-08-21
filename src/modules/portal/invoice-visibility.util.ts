// ─── #61 — Qué factura del cliente puede VER el cliente en su portal ────────────
//
// FUENTE DE VERDAD ÚNICA de la regla. Vive acá y no inline en cada query a propósito:
// es exactamente la clase de regla que diverge apenas hay dos copias, y divergir acá
// significa mostrarle a un cliente un documento que nunca existió para él (o esconderle
// uno que sí recibió).
//
// La distinción NO necesita columna nueva: `sentAt` se sella únicamente al pasar a `SENT`
// (`client-billing.service.ts`, `updateCycle`), así que ya alcanza para separar los dos
// casos que hoy comparten `status: 'CANCELLED'`:
//
//   | Caso                       | status      | sentAt | Quién lo ve      |
//   |----------------------------|-------------|--------|------------------|
//   | Borrador descartado        | CANCELLED   | null   | solo el staff    |
//   | Factura enviada y anulada  | CANCELLED   | fecha  | staff Y cliente  |
//
// Un `DRAFT` nunca es visible: es un borrador interno que el cliente no recibió.
//
// ⚠️ Esta regla es la del LISTADO (qué documentos existen para el cliente). El DETALLE y el
// PDF son más estrictos todavía —`SENT`/`PAID` solamente, ver `getMyInvoiceDetail` y
// `downloadMyInvoice`—: una anulada se lista marcada "Anulada" pero no se abre ni se baja.
//
// Si mañana hace falta la versión `where` para una query de Prisma, va acá al lado; no
// se escribe inline en el call site.

/** Lo mínimo que necesita la regla. Lo cumple cualquier fila/DTO de ciclo de facturación. */
export interface InvoiceVisibilityLike {
  status: string;
  sentAt: Date | null;
}

/**
 * ¿Este documento existe para el cliente?
 *
 * Fail-closed: cualquier estado desconocido (o un `CANCELLED` sin `sentAt`) devuelve `false`.
 * De los dos errores posibles, esconderle al cliente algo que sí recibió se reporta; mostrarle
 * un borrador interno que nunca vio, no — se lo cree.
 */
export function isPortalVisibleInvoice(cycle: InvoiceVisibilityLike): boolean {
  if (cycle.status === 'SENT' || cycle.status === 'PAID') return true;
  return cycle.status === 'CANCELLED' && cycle.sentAt !== null;
}
