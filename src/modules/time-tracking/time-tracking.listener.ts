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
   * `task.reopened`. Como venía de DONE, YA cobró → hay que devolver el cupo, igual que el botón
   * "Rechazar". H7: se revierten dos fuentes de cobro, ambas idempotentes / no-op si no hay cobro
   * vivo, así que aunque otro camino también dispare la reversión nunca reembolsa de más:
   *  - revertConfirmation → carrier de aprobación legacy pre-H7 (excluye MANUAL).
   *  - revertManualCharges → las cargas MANUAL cobradas por H7 (bump version + refund keyed).
   */
  @OnEvent('task.reopened')
  async onTaskReopened(event: { taskId?: string; entityId?: string; userId?: string }) {
    try {
      const taskId = event.taskId ?? event.entityId;
      const userId = event.userId ?? 'system';
      if (!taskId) return;
      const reverted = await this.timeEntryService.revertConfirmation(taskId, userId);
      const revertedManuals = await this.timeEntryService.revertManualCharges(taskId, userId);
      if (reverted || revertedManuals > 0) {
        this.logger.log(
          `task.reopened → cupo revertido para task ${taskId} (carrier: ${reverted ? reverted.id : 'no'}, cargas MANUAL: ${revertedManuals})`,
        );
      }
    } catch (err) {
      this.logger.error('Error revirtiendo cobro tras task.reopened', err);
    }
  }
}
