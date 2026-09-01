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
// La regla existe en DOS formas —un `where` de Prisma y un predicado en memoria— porque hay
// call sites de los dos tipos. Tienen que decir lo MISMO: cualquier cambio va en las dos, y el
// test las corre contra la misma tabla de casos para que no puedan divergir en silencio.

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
  // #65 A1.4: `WRITTEN_OFF` es visible sin condición, igual que SENT y PAID. Sólo se llega ahí
  // desde SENT, o sea que el cliente YA recibió ese documento; que después se cierre sin cobro
  // es una decisión contable nuestra y no puede hacerle desaparecer una factura que tiene.
  // (Si no estuviera acá, el fail-closed del final se la escondería en silencio.)
  if (cycle.status === 'SENT' || cycle.status === 'PAID' || cycle.status === 'WRITTEN_OFF') {
    return true;
  }
  return cycle.status === 'CANCELLED' && cycle.sentAt !== null;
}

/**
 * La misma regla como `where` de Prisma, para las queries que listan facturas del cliente.
 *
 * Se compone con el resto del `where` (`{ clientId, ...PORTAL_VISIBLE_INVOICE_WHERE }`). Va como
 * `OR` y no como `status: { in: [...] }` justamente porque `CANCELLED` no es incondicional: sin la
 * condición de `sentAt`, un borrador descartado —que el cliente nunca recibió— le aparece en el
 * portal como una factura anulada.
 */
export const PORTAL_VISIBLE_INVOICE_WHERE = {
  OR: [
    { status: { in: ['SENT', 'PAID', 'WRITTEN_OFF'] } }, // #65 A1.4
    { status: 'CANCELLED', sentAt: { not: null } },
  ],
};
