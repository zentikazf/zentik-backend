import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskHoursGuardService, HoursGateActor } from './task-hours-guard.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * H6 — Gate "no cerrar sin horas" (T11 + escape T9/T10).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL. Se prueban los
 * code paths del choke point: la condición conservadora del count (excluye estimación,
 * SEED, DRAFT-semilla y soft-deleted), el throw WORK_HOURS_REQUIRED, el escape (permiso
 * asignado||manage:projects + motivo) y la auditoría síncrona en 3 capas.
 */
describe('TaskHoursGuardService — gate de horas H6', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let guard: TaskHoursGuardService;

  const TASK = 'task-1';
  const ORG = 'org-1';

  const assignee: HoursGateActor = { id: 'dev-1', name: 'Dev', email: 'dev@e.com', permissions: [] };
  const pm: HoursGateActor = { id: 'pm-1', name: 'PM', email: 'pm@e.com', permissions: ['manage:projects'] };
  const stranger: HoursGateActor = { id: 'x-1', name: 'Ajeno', email: 'x@e.com', permissions: [] };

  const taskRef = { id: TASK, status: 'IN_PROGRESS', title: 'Tarea', organizationId: ORG };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    guard = new TaskHoursGuardService(prisma, eventEmitter);
  });

  // ── isGatedStatus ──
  it('isGatedStatus: solo IN_REVIEW y DONE', () => {
    expect(guard.isGatedStatus('IN_REVIEW')).toBe(true);
    expect(guard.isGatedStatus('DONE')).toBe(true);
    expect(guard.isGatedStatus('IN_PROGRESS')).toBe(false);
    expect(guard.isGatedStatus('TODO')).toBe(false);
    expect(guard.isGatedStatus(null)).toBe(false);
    expect(guard.isGatedStatus(undefined)).toBe(false);
  });

  // ── hasManageProjects ──
  it('hasManageProjects: manage:projects o wildcard *:*', () => {
    expect(guard.hasManageProjects(['manage:projects'])).toBe(true);
    expect(guard.hasManageProjects(['*:*'])).toBe(true);
    expect(guard.hasManageProjects(['manage:tasks'])).toBe(false);
    expect(guard.hasManageProjects([])).toBe(false);
    expect(guard.hasManageProjects(undefined)).toBe(false);
  });

  // ── condición del count (conservadora) ──
  it('T11.where — el count excluye estimación/SEED/DRAFT-semilla/soft-deleted', async () => {
    prisma.timeEntry.count.mockResolvedValue(1 as never);
    await guard.hasRealHours(TASK, prisma);
    expect(prisma.timeEntry.count).toHaveBeenCalledWith({
      where: {
        taskId: TASK,
        deletedAt: null,
        OR: [
          { minutes: { gt: 0 } },
          { origin: 'TIMER', duration: { gt: 0 } },
          { origin: null, duration: { gt: 0 } },
        ],
      },
    });
  });

  // ── assertHasWorkedHours ──
  it('T11.a — 0 horas reales → throw WORK_HOURS_REQUIRED 409', async () => {
    prisma.timeEntry.count.mockResolvedValue(0 as never);
    prisma.taskAssignment.count.mockResolvedValue(0 as never);
    await expect(
      guard.assertHasWorkedHours(TASK, 'IN_REVIEW', stranger, prisma, 'IN_PROGRESS'),
    ).rejects.toMatchObject({
      code: 'WORK_HOURS_REQUIRED',
      statusCode: 409,
      details: { taskId: TASK, targetStatus: 'IN_REVIEW', canCloseWithoutHours: false },
    });
  });

  it('T11.b — 1 entrada con minutes>0 → pasa (no throw)', async () => {
    prisma.timeEntry.count.mockResolvedValue(1 as never);
    await expect(
      guard.assertHasWorkedHours(TASK, 'DONE', assignee, prisma, 'IN_REVIEW'),
    ).resolves.toBeUndefined();
  });

  it('canCloseWithoutHours viaja en el error según el permiso del actor (PM → true)', async () => {
    prisma.timeEntry.count.mockResolvedValue(0 as never);
    await expect(
      guard.assertHasWorkedHours(TASK, 'DONE', pm, prisma, 'IN_REVIEW'),
    ).rejects.toMatchObject({ details: { canCloseWithoutHours: true } });
    // PM tiene manage:projects → no hace falta consultar asignación
    expect(prisma.taskAssignment.count).not.toHaveBeenCalled();
  });

  // ── canCloseWithoutHours (AJ-1) ──
  it('AJ-1 — asignado sin permiso puede cerrar sin horas', async () => {
    prisma.taskAssignment.count.mockResolvedValue(1 as never);
    await expect(guard.canCloseWithoutHours(TASK, assignee, prisma)).resolves.toBe(true);
  });

  it('AJ-1 — ni asignado ni manage:projects → no puede', async () => {
    prisma.taskAssignment.count.mockResolvedValue(0 as never);
    await expect(guard.canCloseWithoutHours(TASK, stranger, prisma)).resolves.toBe(false);
  });

  // ── enforce: gate duro ──
  it('enforce sin escape y sin horas → throw WORK_HOURS_REQUIRED', async () => {
    prisma.timeEntry.count.mockResolvedValue(0 as never);
    prisma.taskAssignment.count.mockResolvedValue(0 as never);
    await expect(
      guard.enforce({ task: taskRef, targetStatus: 'IN_REVIEW', actor: stranger, tx: prisma as never }),
    ).rejects.toMatchObject({ code: 'WORK_HOURS_REQUIRED' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('enforce sin escape y con horas → pasa, sin auditar', async () => {
    prisma.timeEntry.count.mockResolvedValue(2 as never);
    const res = await guard.enforce({ task: taskRef, targetStatus: 'DONE', actor: assignee, tx: prisma as never });
    expect(res).toEqual({ escaped: false });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // ── enforce: escape ──
  it('enforce escape sin permiso ni asignación → 403 FORBIDDEN_CLOSE_WITHOUT_HOURS', async () => {
    prisma.taskAssignment.count.mockResolvedValue(0 as never);
    await expect(
      guard.enforce({
        task: taskRef,
        targetStatus: 'DONE',
        actor: stranger,
        closeWithoutHours: true,
        closeWithoutHoursReason: 'motivo',
        tx: prisma as never,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_CLOSE_WITHOUT_HOURS', statusCode: 403 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('enforce escape con permiso pero motivo vacío → 400 CLOSE_WITHOUT_HOURS_REASON_REQUIRED', async () => {
    await expect(
      guard.enforce({
        task: taskRef,
        targetStatus: 'DONE',
        actor: pm,
        closeWithoutHours: true,
        closeWithoutHoursReason: '   ',
        tx: prisma as never,
      }),
    ).rejects.toMatchObject({ code: 'CLOSE_WITHOUT_HOURS_REASON_REQUIRED', statusCode: 400 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('T10 — enforce escape OK: audita síncrono (AuditLog + system-comment + evento) y NO chequea horas', async () => {
    const res = await guard.enforce({
      task: taskRef,
      targetStatus: 'DONE',
      actor: pm,
      closeWithoutHours: true,
      closeWithoutHoursReason: '  falso positivo  ',
      tx: prisma as never,
    });

    expect(res).toEqual({ escaped: true });
    // NO mira las horas cuando el escape aplica
    expect(prisma.timeEntry.count).not.toHaveBeenCalled();

    // 1) AuditLog síncrono/transaccional
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        userId: pm.id,
        action: 'task.closed_without_hours',
        resource: 'task',
        resourceId: TASK,
        newData: expect.objectContaining({
          reason: 'falso positivo', // trim aplicado
          previousStatus: 'IN_PROGRESS',
          newStatus: 'DONE',
          confirmedZeroHours: true,
        }),
      }),
    });

    // 2) System comment en el timeline
    expect(prisma.comment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: TASK,
        userId: pm.id,
        isSystem: true,
        content: expect.stringContaining('falso positivo'),
      }),
    });

    // 3) domainEvent para el feed
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.closed_without_hours',
      expect.objectContaining({ type: 'task.closed_without_hours', entity: 'task', entityId: TASK }),
    );
  });

  // ── H8c: assertNotBilled / hasBilledHours (guard "no revertir facturado") ──
  it('H8c.where — hasBilledHours cuenta solo USAGE/LOAN facturadas (billedCycleId != null) y vivas', async () => {
    prisma.hoursTransaction.count.mockResolvedValue(0 as never);
    await guard.hasBilledHours(TASK, prisma);
    expect(prisma.hoursTransaction.count).toHaveBeenCalledWith({
      where: {
        taskId: TASK,
        billedCycleId: { not: null },
        type: { in: ['USAGE', 'LOAN'] },
        deletedAt: null,
      },
    });
  });

  it('H8c.a — con ≥1 hora facturada → assertNotBilled lanza TASK_HOURS_BILLED 409', async () => {
    prisma.hoursTransaction.count.mockResolvedValue(1 as never);
    await expect(guard.assertNotBilled(TASK, prisma)).rejects.toMatchObject({
      code: 'TASK_HOURS_BILLED',
      statusCode: 409,
      details: { taskId: TASK },
    });
  });

  it('H8c.b — sin horas facturadas → assertNotBilled pasa (no throw)', async () => {
    prisma.hoursTransaction.count.mockResolvedValue(0 as never);
    await expect(guard.assertNotBilled(TASK, prisma)).resolves.toBeUndefined();
  });

  it('CA4 — REFUND/INTERNAL no cuentan como facturado: el where filtra por type USAGE/LOAN', async () => {
    // Una tarea con solo REFUND/INTERNAL devuelve 0 por el filtro de type → no lanza.
    prisma.hoursTransaction.count.mockResolvedValue(0 as never);
    await expect(guard.assertNotBilled(TASK, prisma)).resolves.toBeUndefined();
    expect(prisma.hoursTransaction.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: { in: ['USAGE', 'LOAN'] } }) }),
    );
  });
});
