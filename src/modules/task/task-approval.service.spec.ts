import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskApprovalService } from './task-approval.service';
import { TaskHoursGuardService } from './task-hours-guard.service';
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
  let service: TaskApprovalService;

  const TASK = 'task-1';
  const ORG = 'org-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    timeEntry = mockDeep<TimeEntryService>();
    hoursGuard = mockDeep<TaskHoursGuardService>();
    service = new TaskApprovalService(prisma, eventEmitter, timeEntry, hoursGuard);

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
    timeEntry.confirmFromApproval.mockResolvedValue(undefined as never);
  });

  it('T13.1 — con horas: aprueba y confirma/cobra (H7 intacto)', async () => {
    await service.approveTask(TASK, 'pm-1', 2);
    expect(hoursGuard.enforce).toHaveBeenCalledWith(
      expect.objectContaining({ targetStatus: 'DONE', task: expect.objectContaining({ id: TASK }) }),
    );
    expect(timeEntry.confirmFromApproval).toHaveBeenCalledWith(TASK, 7200, 'pm-1'); // 2h
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
    await service.approveTask(TASK, 'pm-1', undefined, {
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
});
