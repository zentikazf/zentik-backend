import { isPortalVisibleInvoice, PORTAL_VISIBLE_INVOICE_WHERE } from '../invoice-visibility.util';

/**
 * #61 — La regla de "qué factura puede ver el cliente", aislada de cualquier query.
 *
 * Vive en su propio archivo porque es la fuente de verdad de una decisión con consecuencias en
 * las dos direcciones: mostrar de más = el cliente ve un documento que nunca existió para él;
 * mostrar de menos = le escondemos una factura que sí recibió.
 *
 * El caso que la motivó: hoy una sola anulación (`reopenCycle`) sirve para borradores y para
 * facturas enviadas, y deja `CANCELLED` en los dos casos. `sentAt` es lo único que los separa —
 * y ya existe, por eso la regla no necesita columna nueva.
 */
describe('isPortalVisibleInvoice (#61)', () => {
  const cycle = (status: string, sentAt: Date | null) => ({ status, sentAt });
  const ENVIADA = new Date('2026-08-01T12:00:00Z');

  it('una factura ENVIADA se ve', () => {
    expect(isPortalVisibleInvoice(cycle('SENT', ENVIADA))).toBe(true);
  });

  it('una factura COBRADA se ve', () => {
    expect(isPortalVisibleInvoice(cycle('PAID', ENVIADA))).toBe(true);
  });

  it('una factura enviada y después ANULADA se ve (el cliente la recibió: tiene derecho a saber que se anuló)', () => {
    expect(isPortalVisibleInvoice(cycle('CANCELLED', ENVIADA))).toBe(true);
  });

  it('un BORRADOR DESCARTADO no se ve: `CANCELLED` sin `sentAt` nunca existió para el cliente', () => {
    expect(isPortalVisibleInvoice(cycle('CANCELLED', null))).toBe(false);
  });

  it('un BORRADOR vivo no se ve: es un documento interno del staff', () => {
    expect(isPortalVisibleInvoice(cycle('DRAFT', null))).toBe(false);
  });

  it('fail-closed: un estado desconocido no se ve, aunque tenga `sentAt`', () => {
    // Un estado nuevo que nadie enseñó a clasificar no puede caer del lado de "mostrárselo al
    // cliente" por default. Esconder algo que sí recibió se reporta; mostrarle un interno, no.
    expect(isPortalVisibleInvoice(cycle('VOIDED', ENVIADA))).toBe(false);
    expect(isPortalVisibleInvoice(cycle('', null))).toBe(false);
  });
});

/**
 * Las DOS formas de la regla tienen que decir lo mismo.
 *
 * Existen las dos porque hay call sites de los dos tipos: `getMyInvoices` filtra en la base (un
 * `where` de Prisma) y el detalle de las cards de #62 filtra en memoria (un predicado), sobre
 * ciclos que ya vinieron por otro motivo. Dos representaciones de la misma regla es exactamente
 * donde aparece la divergencia silenciosa, así que se corren las dos contra la MISMA tabla.
 */
describe('las dos formas de la regla no pueden divergir (#61)', () => {
  // Intérprete mínimo del `where`: NO reimplementa la regla, sólo entiende las dos formas que la
  // constante usa hoy (`status.in` y `status` + `sentAt: { not: null }`). Si la constante crece
  // con otra forma, esto se rompe a propósito — es la señal de que hay que mirarlo.
  const matchesWhere = (row: { status: string; sentAt: Date | null }): boolean =>
    PORTAL_VISIBLE_INVOICE_WHERE.OR.some((cond) => {
      const c = cond as { status: string | { in: string[] }; sentAt?: { not: null } };
      const okStatus =
        typeof c.status === 'string' ? c.status === row.status : c.status.in.includes(row.status);
      const okSentAt = c.sentAt === undefined ? true : row.sentAt !== null;
      return okStatus && okSentAt;
    });

  const ENVIADA = new Date('2026-08-01T12:00:00Z');
  const CASOS: Array<[string, string, Date | null]> = [
    ['enviada', 'SENT', ENVIADA],
    ['cobrada', 'PAID', ENVIADA],
    ['enviada y anulada', 'CANCELLED', ENVIADA],
    ['borrador descartado', 'CANCELLED', null],
    ['borrador vivo', 'DRAFT', null],
    ['estado desconocido', 'VOIDED', ENVIADA],
  ];

  it.each(CASOS)('%s: el where y el predicado coinciden', (_nombre, status, sentAt) => {
    const row = { status, sentAt };
    expect(matchesWhere(row)).toBe(isPortalVisibleInvoice(row));
  });

  it('el where deja afuera al borrador descartado y adentro a la enviada-anulada', () => {
    // La misma distinción, leída desde el lado de la query: es lo único que separa los dos
    // CANCELLED que hoy produce reopenCycle.
    expect(matchesWhere({ status: 'CANCELLED', sentAt: null })).toBe(false);
    expect(matchesWhere({ status: 'CANCELLED', sentAt: ENVIADA })).toBe(true);
  });
});
