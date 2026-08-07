import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskApprovalService } from './task-approval.service';
import { TaskHoursGuardService } from './task-hours-guard.service';
import { TicketClassificationGuardService } from '../ticket/ticket-classification-guard.service';
import { TimeEntryService } from '../time-tracking/time-tracking.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * H6 — approveTask (T8 + no-regresión T13). El gate corre antes de escribir DONE:
 *  - con horas → aprueba y confirma/cobra igual que antes (H7 intacto).
 *  - sin horas y sin escape → WORK_HOURS_REQUIRED, cupo sin tocar (CA-11).
 *  - escape (cerrar sin horas) → aprueba pero NO confirma ni descuenta cupo (CA-22).
 */
describe('TaskApprovalService.approveTask — gate H6', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let timeEntry: DeepMockProxy<TimeEntryService>;
  let hoursGuard: DeepMockProxy<TaskHoursGuardService>;
  let classificationGuard: DeepMockProxy<TicketClassificationGuardService>;
  let service: TaskApprovalService;

  const TASK = 'task-1';
  const ORG = 'org-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    timeEntry = mockDeep<TimeEntryService>();
    hoursGuard = mockDeep<TaskHoursGuardService>();
    classificationGuard = mockDeep<TicketClassificationGuardService>();
    // #44: aprobar siempre apunta a RESOLVED → el status gatea. assertIsClassified
    // default (mockDeep) resuelve = tipificado. El test del gate lo sobreescribe.
    classificationGuard.isGatedStatus.mockReturnValue(true);
    service = new TaskApprovalService(prisma, eventEmitter, timeEntry, hoursGuard, classificationGuard);

    prisma.task.findUnique.mockResolvedValue({
      id: TASK,
      status: 'IN_REVIEW',
      title: 'Tarea',
      projectId: 'proj-1',
      estimatedHours: 4,
      endDate: null,
      project: { id: 'proj-1', name: 'Proj', responsibleId: 'r1', organizationId: ORG },
      assignments: [],
    } as never);
    prisma.boardColumn.findFirst.mockResolvedValue({ id: 'col-done' } as never);
    prisma.timeEntry.findFirst.mockResolvedValue({ duration: 3600 } as never);
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma) as never);
    prisma.task.update.mockResolvedValue({ id: TASK, status: 'DONE' } as never);
    hoursGuard.enforce.mockResolvedValue({ escaped: false } as never);
    timeEntry.confirmFromApproval.mockResolvedValue(0 as never);
    timeEntry.revertManualCharges.mockResolvedValue(0 as never);
  });

  it('T13.1 — con horas reales: aprueba y cobra el total que devuelve confirmFromApproval', async () => {
    timeEntry.confirmFromApproval.mockResolvedValue(7200 as never); // 2h reales cargadas
    await service.approveTask(TASK, 'pm-1');
    expect(hoursGuard.enforce).toHaveBeenCalledWith(
      expect.objectContaining({ targetStatus: 'DONE', task: expect.objectContaining({ id: TASK }) }),
    );
    expect(timeEntry.confirmFromApproval).toHaveBeenCalledWith(TASK, 'pm-1'); // H7: ya NO manda confirmedHours
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.approval.approved',
      expect.objectContaining({ confirmedDurationSeconds: 7200, closedWithoutHours: false }),
    );
  });

  it('CA-11 — sin horas y sin escape: WORK_HOURS_REQUIRED y NO confirma (cupo sin tocar)', async () => {
    hoursGuard.enforce.mockRejectedValue(
      Object.assign(new Error('sin horas'), { code: 'WORK_HOURS_REQUIRED', statusCode: 409 }) as never,
    );
    await expect(service.approveTask(TASK, 'pm-1')).rejects.toMatchObject({ code: 'WORK_HOURS_REQUIRED' });
    expect(timeEntry.confirmFromApproval).not.toHaveBeenCalled();
  });

  it('CA-22 — escape (cerrar sin horas): aprueba pero NO confirma ni descuenta cupo', async () => {
    hoursGuard.enforce.mockResolvedValue({ escaped: true } as never);
    await service.approveTask(TASK, 'pm-1', {
      closeWithoutHours: true,
      closeWithoutHoursReason: 'trivial',
      actor: { permissions: ['manage:projects'] },
    });
    expect(prisma.task.update).toHaveBeenCalled(); // sí pasa a DONE
    expect(timeEntry.confirmFromApproval).not.toHaveBeenCalled(); // pero no cobra
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.approval.approved',
      expect.objectContaining({ confirmedDurationSeconds: 0, closedWithoutHours: true }),
    );
  });

  it('no-regresión — task fuera de IN_REVIEW → INVALID_TASK_STATUS (sin tocar el gate)', async () => {
    prisma.task.findUnique.mockResolvedValue({ id: TASK, status: 'IN_PROGRESS', project: {}, assignments: [] } as never);
    await expect(service.approveTask(TASK, 'pm-1')).rejects.toMatchObject({ code: 'INVALID_TASK_STATUS' });
    expect(hoursGuard.enforce).not.toHaveBeenCalled();
  });

  // ── #44 T3: pre-vuelo de tipificación (el punto crítico) ──
  const taskWithTicket = {
    id: TASK,
    status: 'IN_REVIEW',
    title: 'Tarea',
    projectId: 'proj-1',
    estimatedHours: 4,
    endDate: null,
    project: { id: 'proj-1', name: 'Proj', responsibleId: 'r1', organizationId: ORG },
    assignments: [],
    ticket: { id: 'tk-1' },
  };

  it('#44 — task con ticket SIN tipificar → 409 antes de aprobar y SIN cobrar horas (task sigue en IN_REVIEW)', async () => {
    prisma.task.findUnique.mockResolvedValue(taskWithTicket as never);
    classificationGuard.assertIsClassified.mockRejectedValue(
      Object.assign(new Error('falta'), {
        code: 'TICKET_CLASSIFICATION_REQUIRED',
        statusCode: 409,
      }) as never,
    );
    await expect(service.approveTask(TASK, 'pm-1')).rejects.toMatchObject({
      code: 'TICKET_CLASSIFICATION_REQUIRED',
    });
    expect(prisma.task.update).not.toHaveBeenCalled(); // la task NO pasó a DONE
    expect(timeEntry.confirmFromApproval).not.toHaveBeenCalled(); // NO se cobraron horas
    expect(hoursGuard.enforce).not.toHaveBeenCalled(); // el gate de tipificación corre ANTES que el de horas
  });

  it('#44 — task con ticket YA tipificado → aprueba normal (el gate pasa)', async () => {
    prisma.task.findUnique.mockResolvedValue(taskWithTicket as never);
    // assertIsClassified default (mockDeep) resuelve = tipificado.
    await service.approveTask(TASK, 'pm-1');
    expect(classificationGuard.assertIsClassified).toHaveBeenCalled();
    expect(classificationGuard.assertIsClassified.mock.calls[0][0]).toBe('tk-1');
    expect(prisma.task.update).toHaveBeenCalled();
  });

  it('#44 — task SIN ticket asociado → el gate de tipificación no se invoca', async () => {
    // El mock por defecto de findUnique no trae `ticket` → task.ticket es undefined.
    await service.approveTask(TASK, 'pm-1');
    expect(classificationGuard.assertIsClassified).not.toHaveBeenCalled();
    expect(prisma.task.update).toHaveBeenCalled();
  });
});

/**
 * H7 — getApprovalPreview: la fuente de verdad son las cargas MANUAL reales, no la
 * estimación. Además superficia AJ-3 (cierre-sin-horas) leyendo el AuditLog ya persistido.
 */
describe('TaskApprovalService.getApprovalPreview — H7 (horas reales + AJ-3)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: TaskApprovalService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new TaskApprovalService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<TimeEntryService>(),
      mockDeep<TaskHoursGuardService>(),
      mockDeep<TicketClassificationGuardService>(),
    );
    prisma.task.findUnique.mockResolvedValue({
      id: 'task-1',
      title: 'Tarea',
      estimatedHours: 5,
      originalEstimate: 5,
    } as never);
  });

  it('suma las cargas MANUAL vivas → realHours (no la estimación) + desglose + hasManualHours', async () => {
    prisma.timeEntry.findMany.mockResolvedValue([
      { id: 'm1', minutes: 180, workedOn: new Date('2026-07-21'), user: { id: 'u1', name: 'Juan' } },
      { id: 'm2', minutes: 90, workedOn: new Date('2026-07-22'), user: { id: 'u2', name: 'Ana' } },
    ] as never);
    prisma.auditLog.findFirst.mockResolvedValue(null as never);

    const res = await service.getApprovalPreview('task-1');
    expect(res.realMinutes).toBe(270);
    expect(res.realHours).toBe(4.5);
    expect(res.hasManualHours).toBe(true);
    expect(res.entries).toHaveLength(2);
    expect(res.originalEstimate).toBe(5); // referencia informativa, NO monto
    expect(res.closedWithoutHours).toBeNull();
  });

  it('sin cargas MANUAL → realHours=0, hasManualHours=false', async () => {
    prisma.timeEntry.findMany.mockResolvedValue([] as never);
    prisma.auditLog.findFirst.mockResolvedValue(null as never);

    const res = await service.getApprovalPreview('task-1');
    expect(res.realHours).toBe(0);
    expect(res.hasManualHours).toBe(false);
    expect(res.entries).toHaveLength(0);
  });

  it('AJ-3 — tarea cerrada sin horas → closedWithoutHours con actor y motivo', async () => {
    prisma.timeEntry.findMany.mockResolvedValue([] as never);
    prisma.auditLog.findFirst.mockResolvedValue({
      createdAt: new Date('2026-07-23'),
      newData: { reason: 'ticket trivial' },
      user: { name: 'PM Pérez', email: 'pm@x.com' },
    } as never);

    const res = await service.getApprovalPreview('task-1');
    expect(res.closedWithoutHours).toEqual(
      expect.objectContaining({ by: 'PM Pérez', reason: 'ticket trivial' }),
    );
  });
});

/**
 * H8c — rejectTask: guard "no revertir facturado". assertNotBilled corre antes del update
 * (defensa en profundidad). Bloquea rechazar una tarea con horas facturadas; el rechazo de
 * una tarea NO facturada sigue revirtiendo el cupo (flujo H7 intacto = no-regresión).
 */
describe('TaskApprovalService.rejectTask — H8c (guard revert facturado)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let timeEntry: DeepMockProxy<TimeEntryService>;
  let hoursGuard: DeepMockProxy<TaskHoursGuardService>;
  let service: TaskApprovalService;

  const TASK = 'task-1';
  const ORG = 'org-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    timeEntry = mockDeep<TimeEntryService>();
    hoursGuard = mockDeep<TaskHoursGuardService>();
    service = new TaskApprovalService(
      prisma,
      eventEmitter,
      timeEntry,
      hoursGuard,
      mockDeep<TicketClassificationGuardService>(),
    );

    prisma.task.findUnique.mockResolvedValue({
      id: TASK,
      status: 'IN_REVIEW',
      title: 'Tarea',
      projectId: 'proj-1',
      project: { id: 'proj-1', name: 'Proj', responsibleId: 'r1', organizationId: ORG },
      assignments: [],
    } as never);
    prisma.boardColumn.findFirst.mockResolvedValue({ id: 'col-dev' } as never);
    prisma.task.update.mockResolvedValue({ id: TASK, status: 'IN_PROGRESS', reviewAttempts: 1 } as never);
    timeEntry.revertConfirmation.mockResolvedValue(undefined as never);
    timeEntry.revertManualCharges.mockResolvedValue(0 as never);
  });

  it('T6 no-regresión — tarea NO facturada: rechaza y revierte el cupo (H7 intacto)', async () => {
    // hoursGuard.assertNotBilled resuelve por default (no facturada)
    await service.rejectTask(TASK, 'motivo', 'pm-1');
    expect(hoursGuard.assertNotBilled).toHaveBeenCalledWith(TASK);
    expect(prisma.task.update).toHaveBeenCalled();
    expect(timeEntry.revertConfirmation).toHaveBeenCalledWith(TASK, 'pm-1');
    expect(timeEntry.revertManualCharges).toHaveBeenCalledWith(TASK, 'pm-1');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'task.approval.rejected',
      expect.objectContaining({ taskId: TASK }),
    );
  });

  it('T6 bloqueo — tarea facturada: TASK_HOURS_BILLED y NO revierte cupo ni escribe estado', async () => {
    hoursGuard.assertNotBilled.mockRejectedValue(
      Object.assign(new Error('facturada'), { code: 'TASK_HOURS_BILLED', statusCode: 409 }) as never,
    );
    await expect(service.rejectTask(TASK, 'motivo', 'pm-1')).rejects.toMatchObject({ code: 'TASK_HOURS_BILLED' });
    expect(prisma.task.update).not.toHaveBeenCalled();
    expect(timeEntry.revertConfirmation).not.toHaveBeenCalled();
    expect(timeEntry.revertManualCharges).not.toHaveBeenCalled();
  });
});
