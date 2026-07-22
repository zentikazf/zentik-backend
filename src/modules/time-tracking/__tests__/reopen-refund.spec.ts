import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../database/prisma.service';
import { TimeEntryService } from '../time-tracking.service';
import { TimeEntryListener } from '../time-tracking.listener';

/**
 * Fix del DOBLE COBRO por reapertura (bug del motor de horas H2/H7, destapado en el smoke de H4).
 *
 * Root cause: reabrir una tarea DONE (board/task/ticket) emitía `task.reopened`, que NADIE escuchaba
 * → el cobro no se reembolsaba → la re-aprobación creaba un segundo cobro. Fix:
 *  - A: listener de task.reopened → revertConfirmation (reembolsa al reabrir, como "Rechazar").
 *  - A-bis: revertConfirmation EXCLUYE las cargas manuales H4 (CONFIRMED pero nunca cobraron).
 *  - B: confirmFromApproval revierte cualquier CONFIRMED colgado antes de confirmar (1 cobro/tarea).
 */
describe('Fix doble cobro — reversión al reabrir + guards del motor', () => {
  describe('A — TimeEntryListener.onTaskReopened', () => {
    let prisma: DeepMockProxy<PrismaService>;
    let timeEntryService: DeepMockProxy<TimeEntryService>;
    let listener: TimeEntryListener;

    beforeEach(() => {
      prisma = mockDeep<PrismaService>();
      timeEntryService = mockDeep<TimeEntryService>();
      listener = new TimeEntryListener(timeEntryService, prisma);
    });

    it('reabrir una tarea reembolsa el cobro vía revertConfirmation', async () => {
      timeEntryService.revertConfirmation.mockResolvedValue({ id: 'te-1' } as never);
      await listener.onTaskReopened({ entityId: 'task-1', userId: 'user-9' });
      expect(timeEntryService.revertConfirmation).toHaveBeenCalledWith('task-1', 'user-9');
    });

    it('lee el taskId de event.taskId o event.entityId (compat de emisores board/task/ticket)', async () => {
      timeEntryService.revertConfirmation.mockResolvedValue(null as never);
      await listener.onTaskReopened({ taskId: 'task-X' });
      expect(timeEntryService.revertConfirmation).toHaveBeenCalledWith('task-X', 'system');
    });

    it('sin taskId → no revierte nada', async () => {
      await listener.onTaskReopened({});
      expect(timeEntryService.revertConfirmation).not.toHaveBeenCalled();
    });
  });

  describe('A-bis + B — TimeEntryService', () => {
    let prisma: DeepMockProxy<PrismaService>;
    let eventEmitter: DeepMockProxy<EventEmitter2>;
    let service: TimeEntryService;

    beforeEach(() => {
      prisma = mockDeep<PrismaService>();
      eventEmitter = mockDeep<EventEmitter2>();
      service = new TimeEntryService(prisma, eventEmitter);
    });

    it('A-bis — revertConfirmation excluye entradas MANUAL (no reembolsa cargas manuales H4)', async () => {
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

    it('B — confirmFromApproval revierte primero un CONFIRMED colgado y luego confirma (net: 1 cobro)', async () => {
      // 1ra findFirst (revertConfirmation) → CONFIRMED colgado; 2da (confirm) → un DRAFT
      prisma.timeEntry.findFirst
        .mockResolvedValueOnce({ id: 'stale-confirmed', duration: 3600, task: { project: { organizationId: 'org-1' } } } as never)
        .mockResolvedValueOnce({ id: 'draft-1', task: { project: { organizationId: 'org-1', clientId: 'client-1' } } } as never);
      prisma.timeEntry.update
        .mockResolvedValueOnce({ id: 'stale-confirmed', version: 2, duration: 3600, task: { project: { organizationId: 'org-1' } } } as never)
        .mockResolvedValueOnce({ id: 'draft-1', version: 1, task: { project: { organizationId: 'org-1', clientId: 'client-1' } } } as never);

      await service.confirmFromApproval('task-1', 7200, 'user-1');

      const emitted = eventEmitter.emit.mock.calls.map((c) => c[0]);
      expect(emitted).toContain('time_entry.reverted'); // reembolsa el cobro colgado
      expect(emitted).toContain('time_entry.confirmed'); // cobra el nuevo → net 1
    });

    it('B — confirmFromApproval sin CONFIRMED previo NO emite reversión (flujo normal, no-op)', async () => {
      prisma.timeEntry.findFirst
        .mockResolvedValueOnce(null as never) // revertConfirmation: no hay CONFIRMED
        .mockResolvedValueOnce({ id: 'draft-1', task: { project: { organizationId: 'org-1', clientId: 'client-1' } } } as never);
      prisma.timeEntry.update.mockResolvedValueOnce({ id: 'draft-1', version: 1, task: { project: { organizationId: 'org-1', clientId: 'client-1' } } } as never);

      await service.confirmFromApproval('task-1', 3600, 'user-1');

      const emitted = eventEmitter.emit.mock.calls.map((c) => c[0]);
      expect(emitted).not.toContain('time_entry.reverted');
      expect(emitted).toContain('time_entry.confirmed');
    });
  });
});
