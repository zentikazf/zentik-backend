import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { TicketService } from './ticket.service';
import { PrismaService } from '../../database/prisma.service';
import { TicketEventsService } from './ticket-events.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService } from '../sync/outbox.service';
import { TaskHoursGuardService } from '../task/task-hours-guard.service';
import { SlaResolverService } from '../sla/sla-resolver.service';
import { TicketClassificationGuardService } from './ticket-classification-guard.service';
import { CloseTicketDto, CloseReasonDto } from './dto/close-ticket.dto';
import { classifySlaOutcome, calculateSlaOvershoot, TicketSlaShape } from '../sla/sla.util';

/**
 * Feature #43 — Ciclo de vida del ticket: estados simplificados, cancelación
 * manual, rechazo sin breach retroactivo.
 *
 * Prisma MOCKEADO (jest-mock-extended) — NUNCA toca la DB. Cubre las decisiones
 * cerradas del dueño: IN_REVIEW retirado del ciclo, CLOSED reutilizado como
 * «Cancelado» con comentario obligatorio, y la garantía dura de que el rechazo
 * NO revive el SLA (resolvedAt se conserva).
 */
describe('TicketService — ciclo de vida #43', () => {
  let service: TicketService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let events: DeepMockProxy<TicketEventsService>;
  let config: DeepMockProxy<AppConfigService> & { slaCascadeEnabled: boolean };
  let outbox: DeepMockProxy<OutboxService>;
  let hoursGuard: DeepMockProxy<TaskHoursGuardService>;
  let slaResolver: DeepMockProxy<SlaResolverService>;
  let classificationGuard: DeepMockProxy<TicketClassificationGuardService>;
  let lastTx: DeepMockProxy<Prisma.TransactionClient>;

  const ORG = 'org-1';
  const TICKET = 'ticket-1';
  const USER = 'user-staff-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    events = mockDeep<TicketEventsService>();
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & { slaCascadeEnabled: boolean };
    outbox = mockDeep<OutboxService>();
    hoursGuard = mockDeep<TaskHoursGuardService>();
    slaResolver = mockDeep<SlaResolverService>();
    classificationGuard = mockDeep<TicketClassificationGuardService>();
    // #44: por defecto los tickets están tipificados (el gate no interfiere con
    // los tests de ciclo de vida). isGatedStatus se comporta como el real (solo
    // RESOLVED gatea). Los tests del gate sobreescriben estos mocks.
    classificationGuard.isGatedStatus.mockImplementation((s?: string | null) => s === 'RESOLVED');
    classificationGuard.isClassified.mockResolvedValue(true);
    config.slaCascadeEnabled = false;

    service = new TicketService(prisma, eventEmitter, events, config, outbox, hoursGuard, slaResolver, classificationGuard);

    // $transaction: corre el callback con un tx mockeado (recorre el cuerpo real).
    prisma.$transaction.mockImplementation(async (cb: unknown) => {
      const tx = mockDeep<Prisma.TransactionClient>();
      tx.ticket.update.mockResolvedValue({
        id: TICKET,
        project: { id: 'p1', name: 'P' },
        client: { id: 'c1', name: 'C' },
        task: null,
      } as never);
      tx.ticket.findUniqueOrThrow.mockResolvedValue({
        id: TICKET,
        project: { id: 'p1', name: 'P' },
        client: { id: 'c1', name: 'C' },
        task: null,
      } as never);
      lastTx = tx;
      return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
    });
  });

  // ── T2: transiciones + guards del PATCH ────────────────────────────────────
  describe('updateTicket — guards de estado (D2)', () => {
    function stubTicket(status: string, extra: Record<string, unknown> = {}) {
      prisma.ticket.findUnique.mockResolvedValue({
        id: TICKET,
        status,
        organizationId: ORG,
        category: 'SUPPORT_REQUEST',
        firstResponseAt: null,
        resolvedAt: null,
        channelId: null,
        task: null,
        ...extra,
      } as never);
    }

    it('destino IN_REVIEW → TICKET_STATUS_RETIRED (estado retirado del ciclo)', async () => {
      stubTicket('IN_PROGRESS');
      await expect(
        service.updateTicket(TICKET, { status: 'IN_REVIEW' } as never, USER),
      ).rejects.toMatchObject({ code: 'TICKET_STATUS_RETIRED', statusCode: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('destino CLOSED por el PATCH genérico → TICKET_CANCEL_REQUIRES_ACTION (necesita la acción cancelar)', async () => {
      stubTicket('IN_PROGRESS');
      await expect(
        service.updateTicket(TICKET, { status: 'CLOSED' } as never, USER),
      ).rejects.toMatchObject({ code: 'TICKET_CANCEL_REQUIRES_ACTION', statusCode: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('transición inválida (OPEN → RESOLVED, sin pasar por IN_PROGRESS) → INVALID_STATUS_TRANSITION', async () => {
      stubTicket('OPEN');
      await expect(
        service.updateTicket(TICKET, { status: 'RESOLVED' } as never, USER),
      ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION', statusCode: 400 });
    });

    it('reabrir una cancelación: CLOSED → OPEN es válido (R1.1)', async () => {
      stubTicket('CLOSED');
      await expect(
        service.updateTicket(TICKET, { status: 'OPEN' } as never, USER),
      ).resolves.toBeDefined();
      // el update escribió status=OPEN
      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('OPEN');
    });

    it('tombstone operable: un IN_REVIEW histórico puede salir a IN_PROGRESS (R1.3)', async () => {
      stubTicket('IN_REVIEW');
      await expect(
        service.updateTicket(TICKET, { status: 'IN_PROGRESS' } as never, USER),
      ).resolves.toBeDefined();
      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('IN_PROGRESS');
    });
  });

  // ── T2b: cancelación manual (closeTicket) ──────────────────────────────────
  describe('closeTicket — cancelación manual (R1b)', () => {
    const dto: CloseTicketDto = { reason: CloseReasonDto.OTHER, note: 'Duplicado del #123' };

    function stubTicket(status: string, extra: Record<string, unknown> = {}) {
      prisma.ticket.findUnique.mockResolvedValue({
        id: TICKET,
        status,
        organizationId: ORG,
        category: 'SUPPORT_REQUEST',
        firstResponseAt: null,
        resolvedAt: null,
        task: { id: 'task-1', status: 'IN_PROGRESS', projectId: 'p1' },
      } as never);
    }

    it('exige comentario: note vacío → CANCEL_NOTE_REQUIRED', async () => {
      stubTicket('IN_PROGRESS');
      await expect(
        service.closeTicket(TICKET, { reason: CloseReasonDto.OTHER, note: '   ' }, USER),
      ).rejects.toMatchObject({ code: 'CANCEL_NOTE_REQUIRED', statusCode: 400 });
    });

    it('desde RESOLVED no se cancela → TICKET_RESOLVED_NOT_CANCELLABLE (ya entregado)', async () => {
      stubTicket('RESOLVED', { resolvedAt: new Date('2026-08-01T10:00:00Z') });
      await expect(service.closeTicket(TICKET, dto, USER)).rejects.toMatchObject({
        code: 'TICKET_RESOLVED_NOT_CANCELLABLE',
        statusCode: 400,
      });
    });

    it('ya cancelado → ALREADY_CLOSED', async () => {
      stubTicket('CLOSED');
      await expect(service.closeTicket(TICKET, dto, USER)).rejects.toMatchObject({
        code: 'ALREADY_CLOSED',
        statusCode: 400,
      });
    });

    it('cancela desde IN_PROGRESS: CLOSED + closeNote + closedBy, SIN estampar resolvedAt (R1b.6)', async () => {
      stubTicket('IN_PROGRESS');
      await service.closeTicket(TICKET, dto, USER);

      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).toMatchObject({
        status: 'CLOSED',
        closeReason: 'OTHER',
        closeNote: 'Duplicado del #123',
        closedByUserId: USER,
      });
      // ⚠️ Cancelar NO es resolver: no se estampa resolvedAt/firstResponseAt.
      expect(data).not.toHaveProperty('resolvedAt');
      expect(data).not.toHaveProperty('firstResponseAt');
    });

    it('el evento CLOSED lleva fromValue real (para la reapertura y la auditoría)', async () => {
      stubTicket('OPEN');
      await service.closeTicket(TICKET, dto, USER);

      const closedEvent = events.writeEventTx.mock.calls
        .map((c) => c[1] as Record<string, unknown>)
        .find((input) => input.type === 'CLOSED');
      expect(closedEvent).toMatchObject({ type: 'CLOSED', fromValue: 'OPEN', toValue: 'CLOSED' });
    });

    it('lleva la task asociada a CANCELLED (R1b.4)', async () => {
      stubTicket('IN_PROGRESS');
      await service.closeTicket(TICKET, dto, USER);

      expect(lastTx.task.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
    });

    it('encola STATUS_CHANGED al outbox Onnix solo para tickets de soporte', async () => {
      stubTicket('IN_PROGRESS');
      await service.closeTicket(TICKET, dto, USER);
      expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
      expect(outbox.enqueueTx.mock.calls[0][1]).toMatchObject({
        eventType: 'STATUS_CHANGED',
        aggregateId: TICKET,
      });
    });

    it('NO encola al outbox si el ticket NO es de soporte', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: TICKET,
        status: 'IN_PROGRESS',
        organizationId: ORG,
        category: 'NEW_DEVELOPMENT',
        firstResponseAt: null,
        resolvedAt: null,
        task: { id: 'task-1', status: 'IN_PROGRESS', projectId: 'p1' },
      } as never);
      await service.closeTicket(TICKET, dto, USER);
      expect(outbox.enqueueTx).not.toHaveBeenCalled();
    });
  });

  // ── T1 + T3: syncTicketFromTaskMove (rechazo sin breach + IN_REVIEW no-op) ──
  describe('syncTicketFromTaskMove — kanban → ticket', () => {
    function stubTicket(status: string, extra: Record<string, unknown> = {}) {
      prisma.ticket.findFirst.mockResolvedValue({
        id: TICKET,
        status,
        organizationId: ORG,
        firstResponseAt: new Date('2026-08-01T09:00:00Z'),
        resolvedAt: null,
        channelId: 'chan-1',
        ...extra,
      } as never);
    }

    it('T3: task IN_REVIEW = no-op sobre el ticket (return null, sin tx)', async () => {
      stubTicket('RESOLVED', { resolvedAt: new Date('2026-08-01T12:00:00Z') });
      const res = await service.syncTicketFromTaskMove('task-1', 'IN_REVIEW', USER);
      expect(res).toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('T1: rechazo RESOLVED → IN_PROGRESS conserva resolvedAt (no lo borra ni re-estampa)', async () => {
      const firstResolved = new Date('2026-08-01T12:00:00Z');
      stubTicket('RESOLVED', { resolvedAt: firstResolved });
      await service.syncTicketFromTaskMove('task-1', 'IN_PROGRESS', USER);

      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('IN_PROGRESS');
      // La garantía dura del feature: el reloj no revive. El update NO toca resolvedAt.
      expect(data).not.toHaveProperty('resolvedAt');
    });

    it('T1: re-resolver conserva el PRIMER resolvedAt (solo estampa si era null)', async () => {
      const firstResolved = new Date('2026-08-01T12:00:00Z');
      stubTicket('IN_PROGRESS', { resolvedAt: firstResolved });
      await service.syncTicketFromTaskMove('task-1', 'DONE', USER); // DONE → RESOLVED

      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('RESOLVED');
      expect(data).not.toHaveProperty('resolvedAt'); // ya tenía uno → no se pisa
    });

    it('primera resolución SÍ estampa resolvedAt cuando era null', async () => {
      stubTicket('IN_PROGRESS', { resolvedAt: null });
      await service.syncTicketFromTaskMove('task-1', 'DONE', USER);

      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('RESOLVED');
      expect(data.resolvedAt).toBeInstanceOf(Date);
    });
  });

  // ── #44 T2: gate de tipificación en updateTicket (D2.1) ─────────────────────
  describe('updateTicket — gate de tipificación #44 (D2.1)', () => {
    function stubTicket(status: string, extra: Record<string, unknown> = {}) {
      prisma.ticket.findUnique.mockResolvedValue({
        id: TICKET,
        status,
        organizationId: ORG,
        category: 'SUPPORT_REQUEST',
        firstResponseAt: null,
        resolvedAt: null,
        channelId: null,
        task: null,
        ...extra,
      } as never);
    }

    it('sin tipificar: resolver (IN_PROGRESS → RESOLVED) → 409 y el ticket NO queda resuelto (la tx revirtió)', async () => {
      stubTicket('IN_PROGRESS');
      classificationGuard.assertIsClassified.mockRejectedValue(
        Object.assign(new Error('falta'), {
          code: 'TICKET_CLASSIFICATION_REQUIRED',
          statusCode: 409,
        }) as never,
      );
      await expect(
        service.updateTicket(TICKET, { status: 'RESOLVED' } as never, USER),
      ).rejects.toMatchObject({ code: 'TICKET_CLASSIFICATION_REQUIRED', statusCode: 409 });
      // El gate corre DENTRO de la tx → al lanzar, no se escribió el status.
      expect(lastTx.ticket.update).not.toHaveBeenCalled();
    });

    it('tipificado: resolver desde IN_PROGRESS resuelve normal y estampa resolvedAt', async () => {
      stubTicket('IN_PROGRESS');
      // assertIsClassified default (mockDeep) resuelve = tipificado.
      await service.updateTicket(TICKET, { status: 'RESOLVED' } as never, USER);
      expect(classificationGuard.assertIsClassified).toHaveBeenCalled();
      expect(classificationGuard.assertIsClassified.mock.calls[0][0]).toBe(TICKET);
      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('RESOLVED');
      expect(data.resolvedAt).toBeInstanceOf(Date);
    });

    it('cancelar (CLOSED) NO exige tipificación: el gate no se invoca al cancelar', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: TICKET,
        status: 'IN_PROGRESS',
        organizationId: ORG,
        category: 'SUPPORT_REQUEST',
        firstResponseAt: null,
        resolvedAt: null,
        task: { id: 'task-1', status: 'IN_PROGRESS', projectId: 'p1' },
      } as never);
      await service.closeTicket(TICKET, { reason: CloseReasonDto.OTHER, note: 'Duplicado' }, USER);
      expect(classificationGuard.assertIsClassified).not.toHaveBeenCalled();
    });
  });

  // ── #44 T4: defensa en syncTicketFromTaskMove (D2.3) ────────────────────────
  describe('syncTicketFromTaskMove — defensa de tipificación #44 (D2.3)', () => {
    function stubTicket(status: string, extra: Record<string, unknown> = {}) {
      prisma.ticket.findFirst.mockResolvedValue({
        id: TICKET,
        status,
        organizationId: ORG,
        firstResponseAt: new Date('2026-08-01T09:00:00Z'),
        resolvedAt: null,
        channelId: 'chan-1',
        ...extra,
      } as never);
    }

    it('sync a RESOLVED con ticket sin tipificar → NO lanza, no abre tx, no cambia estado, loguea', async () => {
      stubTicket('IN_PROGRESS');
      classificationGuard.isClassified.mockResolvedValue(false);
      const errSpy = jest
        .spyOn((service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error')
        .mockImplementation(() => undefined);

      const res = await service.syncTicketFromTaskMove('task-1', 'DONE', USER); // DONE → RESOLVED

      expect(res).toBeNull();
      // NO lanza (el listener lo tragaría → divergencia silenciosa) y NO escribe.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();
    });

    it('sync a RESOLVED con ticket tipificado → procede y escribe el estado (no-regresión)', async () => {
      stubTicket('IN_PROGRESS', { resolvedAt: null });
      classificationGuard.isClassified.mockResolvedValue(true);
      await service.syncTicketFromTaskMove('task-1', 'DONE', USER);
      const data = lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('RESOLVED');
    });
  });

  // ── T1 + T2b: helpers SLA (semántica congelada) ────────────────────────────
  describe('helpers SLA (sla.util)', () => {
    const base: TicketSlaShape = {
      status: 'RESOLVED',
      responseDeadline: new Date('2026-08-01T10:00:00Z'),
      resolutionDeadline: new Date('2026-08-01T18:00:00Z'),
      firstResponseAt: new Date('2026-08-01T09:00:00Z'),
      resolvedAt: new Date('2026-08-01T17:00:00Z'),
      slaResponseBreached: false,
      slaResolutionBreached: false,
    };

    it('un ticket CLOSED (cancelado) con deadlines y sin breach NO es COMPLIED → IN_FLIGHT (R1b.6)', () => {
      // Solo RESOLVED es terminal para classifySlaOutcome: un cancelado no cuenta
      // como cumplido. El cron tampoco lo mira (CLOSED fuera de todos sus filtros).
      expect(classifySlaOutcome({ ...base, status: 'CLOSED' })).toBe('IN_FLIGHT');
    });

    it('un CLOSED que YA tenía un breach marcado sigue clasificando BREACHED (comportamiento pre-existente documentado, R1b.6)', () => {
      // Los flags de breach los estampa el cron mientras el ticket estaba activo;
      // persisten al cancelar. classifySlaOutcome los evalúa ANTES del estado
      // terminal → un cancelado que incumplió mientras vivía conserva el desenlace.
      // Se documenta a propósito: cancelar NO reescribe un incumplimiento histórico.
      expect(classifySlaOutcome({ ...base, status: 'CLOSED', slaResolutionBreached: true }))
        .toBe('BREACHED_RESOLUTION');
    });

    it('un RESOLVED sin breach sigue siendo COMPLIED (no-regresión)', () => {
      expect(classifySlaOutcome(base)).toBe('COMPLIED');
    });

    it('calculateSlaOvershoot mide contra el resolvedAt provisto (el primero, R2.5)', () => {
      const deadline = new Date('2026-08-01T18:00:00Z');
      const firstResolved = new Date('2026-08-01T19:30:00Z'); // 90 min tarde
      expect(calculateSlaOvershoot(deadline, firstResolved)).toBe(90);
      // A tiempo → 0; sin datos → null.
      expect(calculateSlaOvershoot(deadline, new Date('2026-08-01T17:00:00Z'))).toBe(0);
      expect(calculateSlaOvershoot(null, firstResolved)).toBeNull();
    });
  });
});
