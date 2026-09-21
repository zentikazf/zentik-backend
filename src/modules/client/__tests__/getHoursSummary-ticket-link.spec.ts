import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * #72 C — "ir al ticket" desde el ledger de tiempos.
 *
 * C2.1: el `ticketId` NO existe en `HoursTransaction` ni en `Task`. La relacion va del TICKET a la
 *       tarea (`Ticket.taskId @unique`), asi que el id sale por la relacion INVERSA `Task.ticket`.
 *       Sin el, el front tiene el id de la TAREA y la ruta es `/tickets/[ticketId]`: no se puede
 *       armar la URL.
 * C3.1: es NULLABLE y ese es el punto del bloque. Una tarea PROJECT nunca fue un ticket y una
 *       carga manual no tiene tarea. El front dibuja el link SOLO si el id existe — un link muerto
 *       a un 404 es peor que no tener link.
 *
 * Prisma MOCKEADO — nunca toca la DB.
 */
describe('ClientService — el ledger trae el ticket de la tarea (#72 C)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let email: DeepMockProxy<EmailInvitationService>;
  let onboarding: DeepMockProxy<OnboardingService>;
  let service: ClientService;

  const ORG = 'org-1';
  const CLIENT = 'client-1';

  /** Una fila del ledger con lo minimo que mira esta suite. */
  const row = (id: string, task: unknown) => ({
    id,
    type: 'USAGE',
    hours: 2,
    note: null,
    createdAt: new Date('2026-09-10T12:00:00Z'),
    workedOn: new Date('2026-09-10T00:00:00Z'),
    priceAmount: '100000',
    billedCycleId: null,
    rebilledFromTransactionId: null,
    task,
  });

  const conTicket = row('tx-ticket', {
    id: 'task-1',
    title: 'Falla en el login',
    type: 'SUPPORT',
    project: null,
    ticket: { id: 'ticket-42' },
  });
  // Tarea de tipo PROJECT: existe la tarea, nunca existio el ticket.
  const sinTicket = row('tx-project', {
    id: 'task-2',
    title: 'Migracion del modulo de reportes',
    type: 'PROJECT',
    project: { id: 'proj-1', name: 'Reportes' },
    ticket: null,
  });
  // Carga manual: no hay tarea de la que colgar un ticket.
  const cargaManual = row('tx-manual', null);

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    email = mockDeep<EmailInvitationService>();
    onboarding = mockDeep<OnboardingService>();
    service = new ClientService(prisma, audit, email, onboarding);

    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      organizationId: ORG,
      currency: 'PYG',
      contractedHours: 100,
      usedHours: 40,
      loanedHours: 0,
      developmentHourlyRate: null,
      supportHourlyRate: null,
    } as never);

    prisma.$transaction.mockResolvedValue([
      [conTicket, sinTicket, cargaManual],
      3,
      { _sum: { priceAmount: null } },
    ] as never);
  });

  it('pide el id del ticket por la relacion inversa `Task.ticket` (C2.1)', async () => {
    await service.getHoursSummary(ORG, CLIENT);

    expect(prisma.hoursTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          task: expect.objectContaining({
            select: expect.objectContaining({ ticket: { select: { id: true } } }),
          }),
        }),
      }),
    );
  });

  it('una fila de una tarea CON ticket viaja con el id del ticket (C4.1/C4.4)', async () => {
    const res = await service.getHoursSummary(ORG, CLIENT);

    const fila = res.transactions.find((t: { id: string }) => t.id === 'tx-ticket');
    expect(fila).toBeDefined();
    expect((fila as { task: { ticket: { id: string } } }).task.ticket).toEqual({ id: 'ticket-42' });
  });

  it('una tarea PROJECT viaja SIN ticket: el front no puede dibujar un link muerto (C4.2)', async () => {
    const res = await service.getHoursSummary(ORG, CLIENT);

    const fila = res.transactions.find((t: { id: string }) => t.id === 'tx-project');
    expect((fila as { task: { ticket: unknown } }).task.ticket).toBeNull();
  });

  it('una carga manual no tiene tarea y la respuesta sale igual (C4.3)', async () => {
    const res = await service.getHoursSummary(ORG, CLIENT);

    const fila = res.transactions.find((t: { id: string }) => t.id === 'tx-manual');
    expect(fila).toBeDefined();
    expect((fila as { task: unknown }).task).toBeNull();
    expect(res.transactionsTotal).toBe(3);
  });

  it('el select del ticket NO pisa lo que el ledger ya traia de la tarea', async () => {
    await service.getHoursSummary(ORG, CLIENT);

    // El bloque C es ADITIVO: si un campo se cae de este select, la columna correspondiente de la
    // pantalla de tiempos queda en blanco sin que nada falle.
    expect(prisma.hoursTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          task: {
            select: {
              id: true,
              title: true,
              type: true,
              project: { select: { id: true, name: true } },
              ticket: { select: { id: true } },
            },
          },
        },
      }),
    );
  });
});
