import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TaskStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MessageService } from '../chat/chat.service';
import { TicketService } from './ticket.service';

/**
 * Mensaje de sistema que ve el CLIENTE en el hilo del ticket cuando el PM
 * rechaza (#43 R2.4). Texto fijo — el motivo interno del rechazo NUNCA viaja
 * al cliente. Se persiste como mensaje real del chat (no hay tipo "system" en
 * el modelo Message: cada mensaje exige un userId real que sea ChannelMember),
 * atribuido al actor que rechazó. Ver design §D3.
 */
const TICKET_REOPENED_NOTICE = 'Reabrimos este ticket para una revisión adicional.';

/**
 * Listener que sincroniza el ticket cuando una task asociada cambia desde el kanban.
 * Loop guard: si el evento viene del propio sync ticket→task, lo ignora.
 */
@Injectable()
export class TicketSyncListener {
  private readonly logger = new Logger(TicketSyncListener.name);

  constructor(
    private readonly ticketService: TicketService,
    private readonly prisma: PrismaService,
    private readonly messages: MessageService,
  ) {}

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
   *
   * #43 R2.4: el rechazo reabre el chat del cliente (el ticket deja de estar
   * RESOLVED). Dejamos huella visible con un mensaje de sistema en el hilo. El
   * `resolvedAt` del primer "Resuelto" se conserva (garantía del feature: el
   * SLA no revive — decisión B del dueño), eso ya lo asegura `syncTicketFromTaskMove`.
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

    // Estado del ticket ANTES del sync: el aviso de reapertura (R2.4) solo tiene
    // sentido cuando se reabre un ticket RESOLVED. Como #43 hizo que task IN_REVIEW
    // sea no-op, una task puede estar en revisión con el ticket todavía en OPEN;
    // un rechazo ahí haría OPEN→IN_PROGRESS y NO es una "reapertura".
    const before = await this.prisma.ticket
      .findFirst({ where: { taskId: payload.taskId }, select: { status: true } })
      .catch(() => null);

    let updated: { channelId: string | null; status: string } | null = null;
    try {
      const result = await this.ticketService.syncTicketFromTaskMove(
        payload.taskId,
        'IN_PROGRESS',
        userId,
      );
      updated = result as { channelId: string | null; status: string } | null;
    } catch (err) {
      this.logger.error(
        `Error sincronizando ticket desde task.approval.rejected (taskId=${payload.taskId})`,
        err as Error,
      );
      return;
    }

    // Mensaje de sistema al reabrir (R2.4). Solo en una reapertura REAL: el ticket
    // estaba RESOLVED y el sync lo movió a IN_PROGRESS, con canal + actor real. Un
    // rechazo con actor 'system' o desde otro estado se salta sin ruido.
    if (
      before?.status === 'RESOLVED' &&
      updated &&
      updated.status === 'IN_PROGRESS' &&
      updated.channelId &&
      userId &&
      userId !== 'system'
    ) {
      await this.postReopenNotice(updated.channelId, userId, payload.taskId);
    }
  }

  /**
   * Persiste el aviso de reapertura en el canal del ticket. El chat no tiene
   * emisor "sistema" (cada Message exige un User que sea ChannelMember), así que
   * lo atribuimos al actor y garantizamos su membresía de forma idempotente.
   * Falla suave: un aviso de cortesía que no se pudo escribir no debe tumbar el
   * flujo de rechazo (que ya se commiteó).
   */
  private async postReopenNotice(channelId: string, userId: string, taskId: string) {
    try {
      // El actor puede no ser miembro del canal (p. ej. un PM que revisa pero no
      // está asignado). Upsert idempotente antes de escribir — MessageService.create
      // exige membresía. Efecto colateral aceptado: el actor pasa a ver el canal.
      await this.prisma.channelMember.upsert({
        where: { channelId_userId: { channelId, userId } },
        create: { channelId, userId },
        update: {},
      });
      await this.messages.create(channelId, userId, { content: TICKET_REOPENED_NOTICE });
    } catch (err) {
      this.logger.warn(
        `No se pudo escribir el aviso de reapertura en el canal ${channelId} (taskId=${taskId}): ${(err as Error).message}`,
      );
    }
  }
}
