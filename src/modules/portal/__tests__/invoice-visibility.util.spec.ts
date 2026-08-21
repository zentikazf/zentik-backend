import { isPortalVisibleInvoice } from '../invoice-visibility.util';

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
