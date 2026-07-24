import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../database/prisma.service';
import { TimeEntryService } from '../time-tracking.service';
import { TimeEntryListener } from '../time-tracking.listener';

/**
 * Fix del DOBLE COBRO por reapertura (motor de horas H2) + cobro por-carga de H7.
 *
 * Bajo H7 la aprobación cobra las cargas MANUAL reales (un time_entry.confirmed por carga)
 * y reabrir/rechazar las revierte (revertManualCharges). El carrier legacy pre-H7 se sigue
 * cubriendo por revertConfirmation, que NO se tocó (sigue excluyendo MANUAL). Piezas:
 *  - A: listener de task.reopened → revertConfirmation (carrier legacy) + revertManualCharges (H7).
 *  - A-bis: revertConfirmation EXCLUYE las cargas MANUAL (intacto: su reverso vive en revertManualCharges).
 *  - B: confirmFromApproval revierte cualquier carrier colgado y luego emite un confirmed por carga MANUAL.
 *  - C: revertManualCharges revierte SOLO las cargas con cobro vivo a su versión actual (idempotente).
 */
describe('Motor de horas — reversión al reabrir + cobro por-carga (H7)', () => {
  describe('A — TimeEntryListener.onTaskReopened', () => {
    let prisma: DeepMockProxy<PrismaService>;
    let timeEntryService: DeepMockProxy<TimeEntryService>;
    let listener: TimeEntryListener;

    beforeEach(() => {
      prisma = mockDeep<PrismaService>();
      timeEntryService = mockDeep<TimeEntryService>();
      listener = new TimeEntryListener(timeEntryService, prisma);
      timeEntryService.revertManualCharges.mockResolvedValue(0 as never);
    });

    it('reabrir revierte el carrier legacy Y las cargas MANUAL cobradas', async () => {
      timeEntryService.revertConfirmation.mockResolvedValue({ id: 'te-1' } as never);
      await listener.onTaskReopened({ entityId: 'task-1', userId: 'user-9' });
      expect(timeEntryService.revertConfirmation).toHaveBeenCalledWith('task-1', 'user-9');
      expect(timeEntryService.revertManualCharges).toHaveBeenCalledWith('task-1', 'user-9');
    });

    it('lee el taskId de event.taskId o event.entityId (compat de emisores board/task/ticket)', async () => {
      timeEntryService.revertConfirmation.mockResolvedValue(null as never);
      await listener.onTaskReopened({ taskId: 'task-X' });
      expect(timeEntryService.revertConfirmation).toHaveBeenCalledWith('task-X', 'system');
      expect(timeEntryService.revertManualCharges).toHaveBeenCalledWith('task-X', 'system');
    });

    it('sin taskId → no revierte nada', async () => {
      await listener.onTaskReopened({});
      expect(timeEntryService.revertConfirmation).not.toHaveBeenCalled();
      expect(timeEntryService.revertManualCharges).not.toHaveBeenCalled();
    });
  });

  describe('A-bis / B / C — TimeEntryService', () => {
    let prisma: DeepMockProxy<PrismaService>;
    let eventEmitter: DeepMockProxy<EventEmitter2>;
    let service: TimeEntryService;

    beforeEach(() => {
      prisma = mockDeep<PrismaService>();
      eventEmitter = mockDeep<EventEmitter2>();
      service = new TimeEntryService(prisma, eventEmitter);
    });

    it('A-bis — revertConfirmation excluye entradas MANUAL (su reverso vive en revertManualCharges)', async () => {
      prisma.timeEntry.findFirst.mockResolvedValue(null as never);
      await service.revertConfirmation('task-1', 'user-1');
      expect(prisma.timeEntry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'CONFIRMED',
            legacyMigration: false,
            OR: expect.arrayContaining([{ origin: null }, { origin: { not: 'MANUAL' } }]),
          }),
        }),
      );
    });

    it('B — confirmFromApproval revierte primero un carrier colgado y luego cobra las MANUAL (net: 1 cobro)', async () => {
      prisma.timeEntry.findFirst.mockResolvedValueOnce({
        id: 'stale-carrier',
        duration: 3600,
        task: { project: { organizationId: 'org-1' } },
      } as never); // revertConfirmation encuentra un carrier colgado
      prisma.timeEntry.update.mockResolvedValueOnce({
        id: 'stale-carrier',
        version: 2,
        duration: 3600,
        task: { project: { organizationId: 'org-1' } },
      } as never);
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: 'org-1' } } as never);
      prisma.timeEntry.findMany.mockResolvedValue([{ id: 'm1', minutes: 60, version: 1 }] as never);

      const total = await service.confirmFromApproval('task-1', 'user-1');

      const emitted = eventEmitter.emit.mock.calls.map((c) => c[0]);
      expect(emitted).toContain('time_entry.reverted'); // reembolsa el carrier colgado
      expect(emitted).toContain('time_entry.confirmed'); // cobra la carga MANUAL → net 1
      expect(total).toBe(3600); // 60 min * 60
    });

    it('B — confirmFromApproval sin carrier previo NO emite reversión (flujo normal)', async () => {
      prisma.timeEntry.findFirst.mockResolvedValueOnce(null as never); // no carrier colgado
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: 'org-1' } } as never);
      prisma.timeEntry.findMany.mockResolvedValue([{ id: 'm1', minutes: 120, version: 1 }] as never);

      const total = await service.confirmFromApproval('task-1', 'user-1');

      const emitted = eventEmitter.emit.mock.calls.map((c) => c[0]);
      expect(emitted).not.toContain('time_entry.reverted');
      expect(emitted).toContain('time_entry.confirmed');
      expect(total).toBe(7200);
    });

    it('B — multi-carga: N MANUALES → N confirmed keyed por su timeEntryId, total = suma', async () => {
      prisma.timeEntry.findFirst.mockResolvedValueOnce(null as never);
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: 'org-1' } } as never);
      prisma.timeEntry.findMany.mockResolvedValue([
        { id: 'm1', minutes: 180, version: 1 },
        { id: 'm2', minutes: 90, version: 1 },
      ] as never);

      const total = await service.confirmFromApproval('task-1', 'user-1');

      const confirmedEmits = eventEmitter.emit.mock.calls.filter((c) => c[0] === 'time_entry.confirmed');
      expect(confirmedEmits).toHaveLength(2);
      expect(confirmedEmits.map((c) => (c[1] as any).timeEntryId).sort()).toEqual(['m1', 'm2']);
      expect(total).toBe((180 + 90) * 60); // 16200
    });

    it('B — H8a: el time_entry.confirmed emitido incluye el workedOn de la carga MANUAL', async () => {
      prisma.timeEntry.findFirst.mockResolvedValueOnce(null as never);
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: 'org-1' } } as never);
      const worked = new Date('2026-06-30');
      prisma.timeEntry.findMany.mockResolvedValue([
        { id: 'm1', minutes: 60, version: 1, workedOn: worked },
      ] as never);

      await service.confirmFromApproval('task-1', 'user-1');

      const confirmedEmit = eventEmitter.emit.mock.calls.find((c) => c[0] === 'time_entry.confirmed');
      expect((confirmedEmit?.[1] as { workedOn: Date }).workedOn).toEqual(worked);
    });

    it('B — sin cargas MANUAL vivas (0 h / escape) → no cobra nada, total 0', async () => {
      prisma.timeEntry.findFirst.mockResolvedValueOnce(null as never);
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: 'org-1' } } as never);
      prisma.timeEntry.findMany.mockResolvedValue([] as never);

      const total = await service.confirmFromApproval('task-1', 'user-1');

      const emitted = eventEmitter.emit.mock.calls.map((c) => c[0]);
      expect(emitted).not.toContain('time_entry.confirmed');
      expect(total).toBe(0);
    });

    it('C — revertManualCharges: carga con cobro VIVO a su versión → bump version + reverted keyed', async () => {
      prisma.timeEntry.findMany.mockResolvedValue([
        { id: 'm1', version: 1, duration: 10800, task: { project: { organizationId: 'org-1' } } },
      ] as never);
      prisma.hoursTransaction.findFirst.mockResolvedValue({ id: 'usage-1' } as never); // existe USAGE(m1,v1)
      prisma.timeEntry.update.mockResolvedValue({} as never);

      const count = await service.revertManualCharges('task-1', 'user-1');

      expect(count).toBe(1);
      expect(prisma.timeEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'm1' }, data: { version: { increment: 1 } } }),
      );
      const revertEmit = eventEmitter.emit.mock.calls.find((c) => c[0] === 'time_entry.reverted');
      expect(revertEmit?.[1]).toEqual(
        expect.objectContaining({ timeEntryId: 'm1', entryVersion: 1 }),
      );
    });

    it('C — revertManualCharges: carga SIN cobro vivo (ya revertida o nunca cobró) → no-op', async () => {
      prisma.timeEntry.findMany.mockResolvedValue([
        { id: 'm1', version: 2, duration: 10800, task: { project: { organizationId: 'org-1' } } },
      ] as never);
      prisma.hoursTransaction.findFirst.mockResolvedValue(null as never); // no hay USAGE(m1,v2)

      const count = await service.revertManualCharges('task-1', 'user-1');

      expect(count).toBe(0);
      expect(prisma.timeEntry.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
