import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { TicketClassificationGuardService } from './ticket-classification-guard.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * #44 — Gate "no resolver sin tipificar" (T1).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL. Se prueban:
 *  - isGatedStatus: solo RESOLVED gatea (cancelar/otros no).
 *  - assertIsClassified: falta tipo / falta categoría / faltan ambos / completo,
 *    con el code estable y `details.missing` correcto (el contrato con el front).
 *  - isClassified: la variante booleana del path defensivo del sync.
 */
describe('TicketClassificationGuardService — gate de tipificación #44', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let guard: TicketClassificationGuardService;

  const TICKET = 'ticket-1';

  function stubTicket(fields: { ticketTypeId?: string | null; categoryConfigId?: string | null }) {
    prisma.ticket.findUnique.mockResolvedValue({
      ticketTypeId: fields.ticketTypeId ?? null,
      categoryConfigId: fields.categoryConfigId ?? null,
    } as never);
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    guard = new TicketClassificationGuardService(prisma);
  });

  // ── isGatedStatus ──
  it('isGatedStatus: solo RESOLVED gatea (cancelar/otros no)', () => {
    expect(guard.isGatedStatus('RESOLVED')).toBe(true);
    expect(guard.isGatedStatus('CLOSED')).toBe(false); // cancelar NO exige tipificación
    expect(guard.isGatedStatus('IN_PROGRESS')).toBe(false);
    expect(guard.isGatedStatus('OPEN')).toBe(false);
    expect(guard.isGatedStatus(null)).toBe(false);
    expect(guard.isGatedStatus(undefined)).toBe(false);
  });

  // ── la lectura: una sola query, sin joins, solo los 2 campos que definen tipificado ──
  it('lee únicamente ticketTypeId + categoryConfigId del ticket', async () => {
    stubTicket({ ticketTypeId: 't1', categoryConfigId: 'c1' });
    await guard.isClassified(TICKET, prisma);
    expect(prisma.ticket.findUnique).toHaveBeenCalledWith({
      where: { id: TICKET },
      select: { ticketTypeId: true, categoryConfigId: true },
    });
  });

  // ── assertIsClassified ──
  it('completo (tipo + categoría) → no lanza', async () => {
    stubTicket({ ticketTypeId: 't1', categoryConfigId: 'c1' });
    await expect(guard.assertIsClassified(TICKET, prisma)).resolves.toBeUndefined();
  });

  it('falta la categoría interna → 409 con missing=[categoryConfig]', async () => {
    // Caso típico del portal: nace con ticketType (elección del cliente) pero sin categoría.
    stubTicket({ ticketTypeId: 't1', categoryConfigId: null });
    await expect(guard.assertIsClassified(TICKET, prisma)).rejects.toMatchObject({
      code: 'TICKET_CLASSIFICATION_REQUIRED',
      statusCode: 409,
      details: { ticketId: TICKET, missing: ['categoryConfig'] },
    });
  });

  it('falta el tipo → 409 con missing=[ticketType]', async () => {
    stubTicket({ ticketTypeId: null, categoryConfigId: 'c1' });
    await expect(guard.assertIsClassified(TICKET, prisma)).rejects.toMatchObject({
      code: 'TICKET_CLASSIFICATION_REQUIRED',
      statusCode: 409,
      details: { missing: ['ticketType'] },
    });
  });

  it('faltan ambos → 409 con missing=[ticketType, categoryConfig] y mensaje que nombra los dos (R2.4)', async () => {
    stubTicket({ ticketTypeId: null, categoryConfigId: null });
    await expect(guard.assertIsClassified(TICKET, prisma)).rejects.toMatchObject({
      code: 'TICKET_CLASSIFICATION_REQUIRED',
      details: { missing: ['ticketType', 'categoryConfig'] },
    });
    // El mensaje nombra qué falta, no un genérico.
    await guard.assertIsClassified(TICKET, prisma).catch((e) => {
      expect(e.message).toMatch(/tipo de solicitud/i);
      expect(e.message).toMatch(/categoría interna/i);
    });
  });

  it('ticket inexistente → cuenta como no tipificado (defensa)', async () => {
    prisma.ticket.findUnique.mockResolvedValue(null as never);
    await expect(guard.assertIsClassified(TICKET, prisma)).rejects.toMatchObject({
      code: 'TICKET_CLASSIFICATION_REQUIRED',
      details: { missing: ['ticketType', 'categoryConfig'] },
    });
  });

  // ── isClassified (booleana) ──
  it('isClassified: true solo con ambos campos; false si falta cualquiera', async () => {
    stubTicket({ ticketTypeId: 't1', categoryConfigId: 'c1' });
    await expect(guard.isClassified(TICKET, prisma)).resolves.toBe(true);

    stubTicket({ ticketTypeId: 't1', categoryConfigId: null });
    await expect(guard.isClassified(TICKET, prisma)).resolves.toBe(false);

    stubTicket({ ticketTypeId: null, categoryConfigId: 'c1' });
    await expect(guard.isClassified(TICKET, prisma)).resolves.toBe(false);
  });
});
