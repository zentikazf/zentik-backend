import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { NotificationPushService } from './notification-push.service';
import { PUSH_EVENT_TYPES } from './push-events.constants';

/**
 * Listener dedicado para eventos que NO pasan por NotificationService
 * (las que SI pasan por ahi son notificadas via `sendFromNotification` automaticamente).
 *
 * Hoy el unico evento especial es `message.sent` en canales tipo TICKET, que no
 * genera una Notification in-app estandar — se notifica solo por push.
 */
@Injectable()
export class NotificationPushListener {
  private readonly logger = new Logger(NotificationPushListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: NotificationPushService,
  ) {}

  @OnEvent('message.sent')
  async onMessageSent(payload: {
    messageId: string;
    channelId: string;
    userId: string; // sender
    content: string;
    enrichedMessage?: any;
  }) {
    try {
      const channel = await this.prisma.channel.findUnique({
        where: { id: payload.channelId },
        select: {
          id: true,
          type: true,
          name: true,
          ticket: { select: { id: true, title: true, ticketNumber: true } },
          members: {
            where: { userId: { not: payload.userId } },
            select: { userId: true },
          },
        },
      });

      if (!channel) return;
      if (channel.type !== 'TICKET') return; // solo canales de ticket

      const sender = await this.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { name: true },
      });

      const senderName = sender?.name ?? 'Alguien';
      const preview = payload.content.length > 80
        ? `${payload.content.slice(0, 80)}...`
        : payload.content;

      const title = channel.ticket?.ticketNumber
        ? `${senderName} en #${channel.ticket.ticketNumber}`
        : `Nuevo mensaje de ${senderName}`;

      const url = channel.ticket?.id ? `/tickets/${channel.ticket.id}` : '/dashboard';

      // Enviar a todos los miembros del canal excepto al sender
      await Promise.all(
        channel.members.map((m) =>
          this.pushService.sendToUser(m.userId, PUSH_EVENT_TYPES.CHAT_MESSAGE, {
            title,
            body: preview,
            url,
            tag: `chat:${channel.id}`,
            data: {
              channelId: channel.id,
              messageId: payload.messageId,
              ticketId: channel.ticket?.id,
            },
          }),
        ),
      );
    } catch (err: any) {
      this.logger.error(`Error procesando push de chat: ${err?.message ?? err}`);
    }
  }
}
