import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { NotificationPushService } from './notification-push.service';
import { NotificationEmailService } from './notification-email.service';
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
    private readonly emailService: NotificationEmailService,
  ) {}

  // NOTA: el handler de 'document.shared' se movio a NotificationListener para que
  // pase por NotificationService.create() y dispare in-app + push + email en paralelo.
  // Antes este listener solo enviaba push directo (saltandose Notification + email),
  // por eso los clientes no recibian email del documento compartido.

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
          ticket: {
            select: { id: true, title: true, ticketNumber: true, status: true },
          },
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

      // 1) Push (best-effort, todos los miembros menos el sender)
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

      // 2) Email a destinatarios cliente (best-effort, con branding de su organizacion).
      // El service internamente filtra: solo envia si el destinatario es cliente
      // y tiene preferencia EMAIL para chat.message habilitada.
      await Promise.all(
        channel.members.map((m) =>
          this.emailService
            .sendChatTicketReplyToClient({
              recipientUserId: m.userId,
              senderName,
              ticketNumber: channel.ticket?.ticketNumber
                ? String(channel.ticket.ticketNumber)
                : null,
              ticketTitle: channel.ticket?.title ?? null,
              ticketStatus: channel.ticket?.status ?? null,
              ticketId: channel.ticket?.id ?? null,
              messageContent: payload.content,
            })
            .catch((err: any) =>
              this.logger.warn(
                `Error enviando email chat-ticket a ${m.userId}: ${err?.message ?? err}`,
              ),
            ),
        ),
      );
    } catch (err: any) {
      this.logger.error(`Error procesando push de chat: ${err?.message ?? err}`);
    }
  }
}
