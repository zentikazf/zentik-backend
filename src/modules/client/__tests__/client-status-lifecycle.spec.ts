import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * Feature #43 R3/R4 — cierre honesto al deshabilitar el cliente y restauración
 * total al reactivarlo.
 *
 * Prisma MOCKEADO — no toca DB. Cubre: (R3) el cierre por ticket que NO pisa
 * adminNotes y deja el TicketEvent con fromValue real + metadata CLIENT_DISABLED;
 * (R4) la restauración al estado natural via ese fromValue, que NO toca
 * cancelaciones manuales ni CLOSED históricos y es idempotente.
 */
describe('ClientService.changeStatus — cierre honesto + restauración (#43)', () => {
  let service: ClientService;
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let email: DeepMockProxy<EmailInvitationService>;
  let onboarding: DeepMockProxy<OnboardingService>;
  let lastTx: DeepMockProxy<Prisma.TransactionClient>;

  const ORG = 'org-1';
  const CLIENT = 'client-1';
  const ACTOR = 'user-admin-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    email = mockDeep<EmailInvitationService>();
    onboarding = mockDeep<OnboardingService>();
    service = new ClientService(prisma, audit, email, onboarding);

    // findById (previo a la tx) — cliente sin userId ni subusuarios para simplificar.
    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      name: 'Cliente Demo',
      userId: null,
      status: 'ACTIVE',
    } as never);

    prisma.$transaction.mockImplementation(async (cb: unknown) => {
      const tx = mockDeep<Prisma.TransactionClient>();
      tx.user.findMany.mockResolvedValue([] as never);
      lastTx = tx;
      return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
    });
  });

  // ── R3: cierre honesto al deshabilitar ─────────────────────────────────────
  describe('DISABLED → cierre honesto (R3)', () => {
    beforeEach(() => {
      // el barrido incluye IN_REVIEW (tombstone) además de OPEN/IN_PROGRESS
      // (lo verificamos en el where). Devolvemos tickets de distintos estados.
    });

    function stubOpenTickets(tickets: Array<{ id: string; status: string }>) {
      // dentro de la tx: closeOpenTicketsForDisabledClient hace ticket.findMany
      prisma.$transaction.mockImplementation(async (cb: unknown) => {
        const tx = mockDeep<Prisma.TransactionClient>();
        tx.user.findMany.mockResolvedValue([] as never);
        tx.ticket.findMany.mockResolvedValue(tickets as never);
        lastTx = tx;
        return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
      });
    }

    it('barre OPEN/IN_PROGRESS/IN_REVIEW (incluye el tombstone)', async () => {
      stubOpenTickets([]);
      await service.changeStatus(ORG, CLIENT, 'DISABLED', ACTOR);

      const where = lastTx.ticket.findMany.mock.calls[0][0].where as Record<string, any>;
      expect(where.clientId).toBe(CLIENT);
      expect(where.status.in).toEqual(expect.arrayContaining(['OPEN', 'IN_PROGRESS', 'IN_REVIEW']));
    });

    it('cierra cada ticket con closeNote + closedBy SIN pisar adminNotes', async () => {
      stubOpenTickets([{ id: 't1', status: 'IN_PROGRESS' }]);
      await service.changeStatus(ORG, CLIENT, 'DISABLED', ACTOR);

      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).toMatchObject({
        status: 'CLOSED',
        closeNote: 'Cliente deshabilitado',
        closedByUserId: ACTOR,
      });
      expect(data.closedAt).toBeInstanceOf(Date);
      // ⚠️ La clave de R3: adminNotes NO se toca (antes el updateMany lo destruía).
      expect(data).not.toHaveProperty('adminNotes');
    });

    it('escribe un TicketEvent con fromValue real + metadata CLIENT_DISABLED (fuente de R4)', async () => {
      stubOpenTickets([{ id: 't1', status: 'IN_REVIEW' }]);
      await service.changeStatus(ORG, CLIENT, 'DISABLED', ACTOR);

      const ev = lastTx.ticketEvent.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(ev).toMatchObject({
        ticketId: 't1',
        type: 'STATUS_CHANGE',
        fromValue: 'IN_REVIEW',
        toValue: 'CLOSED',
        source: 'SYSTEM',
        metadata: { reason: 'CLIENT_DISABLED' },
      });
    });

    it('cierra por ticket (loop), no con un updateMany mudo', async () => {
      stubOpenTickets([
        { id: 't1', status: 'OPEN' },
        { id: 't2', status: 'IN_PROGRESS' },
      ]);
      await service.changeStatus(ORG, CLIENT, 'DISABLED', ACTOR);

      expect(lastTx.ticket.update).toHaveBeenCalledTimes(2);
      expect(lastTx.ticketEvent.create).toHaveBeenCalledTimes(2);
      expect(lastTx.ticket.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── R4: restauración al reactivar ──────────────────────────────────────────
  describe('ACTIVE → restauración total (R4)', () => {
    // El discriminador es `closeReason: null` a nivel TICKET (el cierre por
    // deshabilitación es el único que NO setea motivo). El findMany del service
    // ya viene filtrado por eso; el mock devuelve lo que se le pasa, y aparte
    // asertamos el where para congelar la exclusión de cancelaciones manuales.
    function setup(
      autoClosedTickets: Array<{ id: string }>,
      fromValueByTicket: Record<string, string | null>,
    ) {
      prisma.$transaction.mockImplementation(async (cb: unknown) => {
        const tx = mockDeep<Prisma.TransactionClient>();
        tx.ticket.findMany.mockResolvedValue(autoClosedTickets as never);
        tx.ticketEvent.findFirst.mockImplementation((args: any) => {
          const id = args.where.ticketId as string;
          const fromValue = fromValueByTicket[id];
          return Promise.resolve(fromValue === undefined ? null : ({ fromValue } as never));
        });
        lastTx = tx;
        return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
      });
    }

    it('el discriminador es closeReason:null → las cancelaciones manuales quedan fuera por DB (R4.3 + fix ALTO)', async () => {
      setup([], {});
      await service.changeStatus(ORG, CLIENT, 'ACTIVE', ACTOR);

      // Regresión del bug ALTO: la restauración NO puede depender de la metadata
      // del evento (la cancelación manual escribe type:'CLOSED', que la query de
      // evento no vería, revivendo un ticket cancelado a mano). El where del
      // ticket excluye a nivel DB todo lo que tenga closeReason (manuales + históricos).
      const where = lastTx.ticket.findMany.mock.calls[0][0].where as Record<string, unknown>;
      expect(where).toMatchObject({ clientId: CLIENT, status: 'CLOSED', closeReason: null });
    });

    it('restaura al estado natural (fromValue del cierre) y limpia los campos + evento espejo', async () => {
      setup([{ id: 't1' }], { t1: 'IN_PROGRESS' });
      await service.changeStatus(ORG, CLIENT, 'ACTIVE', ACTOR);

      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).toMatchObject({
        status: 'IN_PROGRESS',
        closedAt: null,
        closeReason: null,
        closeNote: null,
        closedByUserId: null,
      });
      const ev = lastTx.ticketEvent.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(ev).toMatchObject({
        fromValue: 'CLOSED',
        toValue: 'IN_PROGRESS',
        source: 'SYSTEM',
        metadata: { reason: 'CLIENT_REACTIVATED' },
      });
    });

    it('restaura un IN_REVIEW histórico a su estado natural (no lo normaliza)', async () => {
      setup([{ id: 't1' }], { t1: 'IN_REVIEW' });
      await service.changeStatus(ORG, CLIENT, 'ACTIVE', ACTOR);

      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('IN_REVIEW');
    });

    it('defensivo: un auto-cerrado sin evento de cierre cae a OPEN (fallback)', async () => {
      setup([{ id: 't1' }], { t1: undefined as never });
      await service.changeStatus(ORG, CLIENT, 'ACTIVE', ACTOR);

      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('OPEN');
    });

    it('R4.5: reactivar sin tickets auto-cerrados es no-op (idempotente)', async () => {
      setup([], {});
      await service.changeStatus(ORG, CLIENT, 'ACTIVE', ACTOR);

      expect(lastTx.ticket.update).not.toHaveBeenCalled();
      expect(lastTx.ticketEvent.create).not.toHaveBeenCalled();
    });
  });
});
