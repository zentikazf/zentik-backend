import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TaskStatus } from '@prisma/client';
import { TicketService } from './ticket.service';

/**
 * Listener que sincroniza el ticket cuando una task asociada cambia desde el kanban.
 * Loop guard: si el evento viene del propio sync ticket→task, lo ignora.
 */
@Injectable()
export class TicketSyncListener {
  private readonly logger = new Logger(TicketSyncListener.name);

  constructor(private readonly ticketService: TicketService) {}

  /**
   * Cuando una task se mueve en kanban, sincronizar el ticket asociado (si existe).
   * Si el evento fue originado por el ticket-side sync (metadata.fromTicketSync),
   * NO re-sincronizar para evitar loops infinitos.
   */
  @OnEvent('task.moved')
  async handleTaskMoved(payload: {
    task: { id: string; status: TaskStatus; projectId?: string };
    newStatus?: TaskStatus;
    userId?: string;
    organizationId?: string;
    metadata?: Record<string, unknown>;
  }) {
    if (payload.metadata?.fromTicketSync === true) {
      // Evento originado por nuestro propio sync — no re-procesar
      return;
    }

    const taskId = payload.task?.id;
    const newStatus = payload.newStatus ?? payload.task?.status;
    const userId = payload.userId ?? 'system';

    if (!taskId || !newStatus) return;

    try {
      await this.ticketService.syncTicketFromTaskMove(
        taskId,
        newStatus,
        userId,
        { organizationId: payload.organizationId },
      );
    } catch (err) {
      this.logger.error(
        `Error sincronizando ticket desde task.moved (taskId=${taskId})`,
        err as Error,
      );
    }
  }

  /**
   * Cuando una task pasa a DONE via aprobación explícita,
   * el ticket debe pasar a RESOLVED automáticamente.
   */
  @OnEvent('task.approval.approved')
  async handleTaskApproved(payload: {
    taskId: string;
    projectId?: string;
    approvedById?: string;
    metadata?: Record<string, unknown>;
  }) {
    if (payload.metadata?.fromTicketSync === true) return;
    const userId = payload.approvedById ?? 'system';
    try {
      await this.ticketService.syncTicketFromTaskMove(
        payload.taskId,
        'DONE',
        userId,
      );
    } catch (err) {
      this.logger.error(
        `Error sincronizando ticket desde task.approval.approved (taskId=${payload.taskId})`,
        err as Error,
      );
    }
  }

  /**
   * Cuando una task es rechazada (vuelve a IN_PROGRESS),
   * el ticket asociado debe volver a IN_PROGRESS también.
   */
  @OnEvent('task.approval.rejected')
  async handleTaskRejected(payload: {
    taskId: string;
    projectId?: string;
    rejectedById?: string;
    metadata?: Record<string, unknown>;
  }) {
    if (payload.metadata?.fromTicketSync === true) return;
    const userId = payload.rejectedById ?? 'system';
    try {
      await this.ticketService.syncTicketFromTaskMove(
        payload.taskId,
        'IN_PROGRESS',
        userId,
      );
    } catch (err) {
      this.logger.error(
        `Error sincronizando ticket desde task.approval.rejected (taskId=${payload.taskId})`,
        err as Error,
      );
    }
  }
}
