import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskRelationService } from './task-relation.service';
import { TaskHoursGuardService } from './task-hours-guard.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * H6 — bulkUpdate (T7): gate de horas por op gated + cierre de la fuga de tenancy
 * (el `where` del update ahora incluye projectId, antes solo {id} → tocaba tasks de
 * otra org/proyecto). Prisma MOCKEADO — no toca DATABASE_URL.
 */
describe('TaskRelationService.bulkUpdate — gate + tenancy (H6)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let hoursGuard: DeepMockProxy<TaskHoursGuardService>;
  let service: TaskRelationService;

  const PROJECT = 'proj-1';
  const ORG = 'org-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    hoursGuard = mockDeep<TaskHoursGuardService>();
    service = new TaskRelationService(prisma, eventEmitter, hoursGuard);

    prisma.project.findUnique.mockResolvedValue({ organizationId: ORG } as never);
    // La tx callback recibe el propio prisma mock como tx
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma) as never);
    prisma.task.update.mockResolvedValue({ id: 'x', assignments: [], taskLabels: [] } as never);
    hoursGuard.isGatedStatus.mockImplementation((s?: string | null) => s === 'IN_REVIEW' || s === 'DONE');
    hoursGuard.assertHasWorkedHours.mockResolvedValue(undefined as never);
  });

  it('T7.tenancy — el where del update incluye projectId (cierra la fuga cross-org)', async () => {
    await service.bulkUpdate(PROJECT, { operations: [{ taskId: 't1', priority: 'HIGH' as never }] }, 'u1');

    expect(prisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't1', projectId: PROJECT } }),
    );
    // op no-gated (solo prioridad) → no toca el gate
    expect(hoursGuard.assertHasWorkedHours).not.toHaveBeenCalled();
  });

  it('T7.gate — op que lleva a DONE dispara el gate por esa op', async () => {
    await service.bulkUpdate(
      PROJECT,
      { operations: [{ taskId: 't2', status: 'DONE' as never }] },
      'u1',
      { permissions: [] },
    );

    expect(hoursGuard.assertHasWorkedHours).toHaveBeenCalledWith(
      't2',
      'DONE',
      expect.objectContaining({ id: 'u1' }),
      prisma,
    );
  });

  it('T7.block — si el gate lanza, toda la transacción falla y no emite el evento de bulk', async () => {
    hoursGuard.assertHasWorkedHours.mockRejectedValue(
      Object.assign(new Error('sin horas'), { code: 'WORK_HOURS_REQUIRED' }) as never,
    );
    await expect(
      service.bulkUpdate(PROJECT, { operations: [{ taskId: 't3', status: 'IN_REVIEW' as never }] }, 'u1'),
    ).rejects.toMatchObject({ code: 'WORK_HOURS_REQUIRED' });
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
