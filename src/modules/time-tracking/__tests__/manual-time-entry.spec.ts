import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TimeEntryService } from '../time-tracking.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuthenticatedUser } from '../../../common/interfaces/request.interface';

/**
 * H4 — Carga manual + corrección con traza + soft delete (T15/T16).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod). Se prueban
 * los code paths (gates, validaciones de workedOn, uno-por-día, traza, soft delete); el
 * constraint único parcial real lo verifica el runbook psql del dueño (§9), no el unit.
 *
 * Fechas deterministas: task.createdAt en el pasado lejano ('2024-01-01') y workedOn
 * pasado-pero-posterior ('2024-06-15') → válidas siempre (no dependen del "hoy" del runner).
 * El único caso "futuro" usa '2999-01-01' (siempre > hoy).
 */
describe('TimeEntryService — carga manual (H4)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let service: TimeEntryService;

  const TASK = 'task-1';
  const ORG = 'org-1';
  const CLIENT = 'client-1';

  const assignedActor = {
    id: 'user-1',
    email: 'a@e.com',
    name: 'Asignado',
    organizationIds: [ORG],
    clientId: null,
    permissions: [],
  } as AuthenticatedUser;

  const pmActor = {
    id: 'pm-1',
    email: 'pm@e.com',
    name: 'PM',
    organizationIds: [ORG],
    clientId: null,
    permissions: ['manage:time-entries'],
  } as AuthenticatedUser;

  const strangerActor = {
    id: 'stranger-1',
    email: 's@e.com',
    name: 'Ajeno',
    organizationIds: [ORG],
    clientId: null,
    permissions: [],
  } as AuthenticatedUser;

  function mockTask(over: Record<string, unknown> = {}) {
    prisma.task.findUnique.mockResolvedValue({
      billable: true,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      assignments: [{ userId: 'user-1' }],
      project: { organizationId: ORG, clientId: CLIENT },
      ...over,
    } as never);
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    service = new TimeEntryService(prisma, eventEmitter);

    mockTask();
    prisma.clientBillingCycle.findFirst.mockResolvedValue(null as never); // mes NO facturado
    prisma.timeEntry.findFirst.mockResolvedValue(null as never); // no hay entrada previa del día
    prisma.timeEntry.create.mockResolvedValue({ id: 'te-1', minutes: 90 } as never);
  });

  // ── createManual ──

  it('T1 — asignado carga lo suyo: create con MANUAL/CONFIRMED/duration=minutes*60/billable heredado + evento bien formado', async () => {
    await service.createManual(assignedActor, TASK, { minutes: 90, workedOn: '2024-06-15' });

    expect(prisma.timeEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: TASK,
          userId: assignedActor.id,
          createdById: assignedActor.id,
          minutes: 90,
          origin: 'MANUAL',
          billable: true, // heredado de task.billable, NO del DTO
          duration: 5400, // 90 * 60
          status: 'CONFIRMED',
          workedOn: expect.any(Date),
          startTime: expect.any(Date),
        }),
      }),
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'time_entry.created',
      expect.objectContaining({
        type: 'time_entry.created',
        entity: 'task',
        entityId: TASK,
        organizationId: ORG,
        data: expect.objectContaining({ minutes: 90, forUserId: assignedActor.id, origin: 'MANUAL' }),
      }),
    );
  });

  it('T2 — PM imputa a otro: userId = otro, createdById = PM', async () => {
    await service.createManual(pmActor, TASK, { minutes: 60, workedOn: '2024-06-15', userId: 'dev-2' });

    expect(prisma.timeEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'dev-2', createdById: pmActor.id }),
      }),
    );
  });

  it('T3 — no asignado y sin manage → 403 FORBIDDEN', async () => {
    await expect(
      service.createManual(strangerActor, TASK, { minutes: 60, workedOn: '2024-06-15' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.timeEntry.create).not.toHaveBeenCalled();
  });

  it('T4 — imputar a otro sin manage → 403 FORBIDDEN', async () => {
    await expect(
      service.createManual(assignedActor, TASK, { minutes: 60, workedOn: '2024-06-15', userId: 'dev-2' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('T5a — workedOn futuro → 400 WORKED_ON_IN_FUTURE', async () => {
    await expect(
      service.createManual(assignedActor, TASK, { minutes: 60, workedOn: '2999-01-01' }),
    ).rejects.toMatchObject({ code: 'WORKED_ON_IN_FUTURE', statusCode: 400 });
  });

  it('T5b — workedOn anterior a la tarea → 400 WORKED_ON_BEFORE_TASK', async () => {
    mockTask({ createdAt: new Date('2024-06-01T00:00:00Z') });
    await expect(
      service.createManual(assignedActor, TASK, { minutes: 60, workedOn: '2024-01-01' }),
    ).rejects.toMatchObject({ code: 'WORKED_ON_BEFORE_TASK', statusCode: 400 });
  });

  it('T6 — mes ya facturado (ciclo != CANCELLED cubre el día) → 409 WORKED_ON_MONTH_BILLED', async () => {
    prisma.clientBillingCycle.findFirst.mockResolvedValue({ id: 'cyc1' } as never);
    await expect(
      service.createManual(assignedActor, TASK, { minutes: 60, workedOn: '2024-06-15' }),
    ).rejects.toMatchObject({ code: 'WORKED_ON_MONTH_BILLED', statusCode: 409 });
  });

  it('T7a — duplicado del día (chequeo de app) → 409 TIME_ENTRY_DAY_EXISTS', async () => {
    prisma.timeEntry.findFirst.mockResolvedValue({ id: 'existing' } as never);
    await expect(
      service.createManual(assignedActor, TASK, { minutes: 60, workedOn: '2024-06-15' }),
    ).rejects.toMatchObject({ code: 'TIME_ENTRY_DAY_EXISTS', statusCode: 409 });
    expect(prisma.timeEntry.create).not.toHaveBeenCalled();
  });

  it('T7b — duplicado por carrera (P2002 del índice único parcial) → 409 TIME_ENTRY_DAY_EXISTS', async () => {
    prisma.timeEntry.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5.22.0' }) as never,
    );
    await expect(
      service.createManual(assignedActor, TASK, { minutes: 60, workedOn: '2024-06-15' }),
    ).rejects.toMatchObject({ code: 'TIME_ENTRY_DAY_EXISTS', statusCode: 409 });
  });

  it('T8 — tarea inexistente → 404 TASK_NOT_FOUND', async () => {
    prisma.task.findUnique.mockResolvedValue(null as never);
    await expect(
      service.createManual(assignedActor, TASK, { minutes: 60, workedOn: '2024-06-15' }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', statusCode: 404 });
  });

  it('T8b — org distinta a la del actor → 404 TASK_NOT_FOUND (no revela cross-org)', async () => {
    mockTask({ project: { organizationId: 'org-OTRA', clientId: CLIENT } });
    await expect(
      service.createManual(pmActor, TASK, { minutes: 60, workedOn: '2024-06-15' }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', statusCode: 404 });
  });

  // ── update (corrección) ──

  describe('update — corrección PM con traza', () => {
    function mockExisting(over: Record<string, unknown> = {}) {
      prisma.timeEntry.findFirst.mockResolvedValue({
        id: 'te-1',
        userId: 'dev-2',
        minutes: 210,
        duration: 12600,
        workedOn: new Date('2024-06-15T00:00:00Z'),
        taskId: TASK,
        task: {
          createdAt: new Date('2024-01-01T00:00:00Z'),
          project: { organizationId: ORG, clientId: CLIENT },
        },
        ...over,
      } as never);
      prisma.timeEntry.update.mockResolvedValue({ id: 'te-1', userId: 'dev-2', minutes: 180 } as never);
    }

    it('T9 — PM corrige ajena 210→180: setea previousMinutes/correctedById/correctedAt/duration + emite corrected con oldData', async () => {
      mockExisting();
      await service.update('te-1', pmActor, { minutes: 180 });

      expect(prisma.timeEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'te-1' },
          data: expect.objectContaining({
            previousMinutes: 210,
            minutes: 180,
            duration: 10800, // 180 * 60
            correctedById: pmActor.id,
            correctedAt: expect.any(Date),
          }),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'time_entry.corrected',
        expect.objectContaining({
          entity: 'task',
          entityId: TASK,
          data: expect.objectContaining({ minutes: 180 }),
          oldData: expect.objectContaining({ minutes: 210 }),
        }),
      );
    });

    it('T9b — ajeno sin manage ni ownership → 404 (no filtra existencia)', async () => {
      mockExisting();
      await expect(
        service.update('te-1', strangerActor, { minutes: 180 }),
      ).rejects.toMatchObject({ code: 'TIME_ENTRY_NOT_FOUND', statusCode: 404 });
      expect(prisma.timeEntry.update).not.toHaveBeenCalled();
    });

    it('T9c — el dueño sigue editando lo suyo (sin regresión)', async () => {
      mockExisting({ userId: assignedActor.id });
      await service.update('te-1', assignedActor, { minutes: 180 });
      expect(prisma.timeEntry.update).toHaveBeenCalled();
    });
  });

  // ── delete (soft) ──

  describe('delete — soft delete', () => {
    beforeEach(() => {
      prisma.timeEntry.findFirst.mockResolvedValue({
        id: 'te-1',
        userId: 'dev-2',
        minutes: 90,
        workedOn: new Date('2024-06-15T00:00:00Z'),
        taskId: TASK,
        task: { project: { organizationId: ORG } },
      } as never);
      prisma.timeEntry.update.mockResolvedValue({ id: 'te-1', deletedAt: new Date() } as never);
    });

    it('T10 — soft delete: UPDATE con deletedAt/deletedById, NUNCA prisma.delete, + emite deleted', async () => {
      await service.delete('te-1', pmActor, 'ya no aplica');

      expect(prisma.timeEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'te-1' },
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
            deletedById: pmActor.id,
            deleteReason: 'ya no aplica',
          }),
        }),
      );
      expect(prisma.timeEntry.delete).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith('time_entry.deleted', expect.objectContaining({ entity: 'task', entityId: TASK }));
    });

    it('T10b — entrada ya borrada / inexistente → 404 (idempotente)', async () => {
      prisma.timeEntry.findFirst.mockResolvedValue(null as never);
      await expect(service.delete('te-1', pmActor)).rejects.toMatchObject({
        code: 'TIME_ENTRY_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  // ── lecturas excluyen soft-deleted ──

  it('T11 — findByUser filtra deletedAt: null', async () => {
    prisma.timeEntry.findMany.mockResolvedValue([] as never);
    await service.findByUser('user-1', {});
    expect(prisma.timeEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });
});
