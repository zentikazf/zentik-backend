import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { TimeEntryService } from './time-tracking.service';

/**
 * Listener del motor de horas. Tras H5 (matar timer + siembras automaticas) conserva
 * UN solo handler: onTaskReopened (refund del doble-cobro al reabrir, H2/H7).
 *
 * Los antiguos handlers de siembra (task.estimated / task.assigned -> upsertDraftFromTask,
 * que creaban un TimeEntry DRAFT con la estimacion) se eliminaron en H5: la unica via de
 * creacion de horas es la carga MANUAL (H4). La estimacion vuelve a ser solo un numero en
 * la tarea (task.estimatedHours), sin generar ningun TimeEntry.
 */
@Injectable()
export class TimeEntryListener {
  private readonly logger = new Logger(TimeEntryListener.name);

  constructor(
    private readonly timeEntryService: TimeEntryService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Reabrir una tarea DONE por CUALQUIER camino (board, task.service, ticket.service) emite
   * `task.reopened`. Antes NADIE lo escuchaba → el cobro de horas de la aprobación quedaba y una
   * re-aprobación creaba un SEGUNDO cobro (doble cobro por una sola tarea). Este listener reembolsa
   * al reabrir, exactamente como hace el botón "Rechazar" (rejectTask → revertConfirmation).
   * revertConfirmation es idempotente (solo actúa sobre un CONFIRMED de aprobación, excluye MANUAL)
   * → nunca reembolsa de más aunque otro camino también dispare la reversión.
   */
  @OnEvent('task.reopened')
  async onTaskReopened(event: { taskId?: string; entityId?: string; userId?: string }) {
    try {
      const taskId = event.taskId ?? event.entityId;
      const userId = event.userId ?? 'system';
      if (!taskId) return;
      const reverted = await this.timeEntryService.revertConfirmation(taskId, userId);
      if (reverted) {
        this.logger.log(`task.reopened → cobro de horas revertido para task ${taskId} (entry ${reverted.id})`);
      }
    } catch (err) {
      this.logger.error('Error revirtiendo cobro tras task.reopened', err);
    }
  }
}
