import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { EmailService } from '../../infrastructure/email/email.service';
import {
  notificationEmail,
  clientNotificationEmail,
} from '../../infrastructure/email/email-templates';
import { PUSH_EVENT_CATALOG, PushEventType } from './push-events.constants';

/**
 * Mapea el `type` de una Notification in-app al eventType del catalogo de notificaciones.
 * Si retorna null, no se envia email (el evento no esta en el catalogo).
 */
const NOTIFICATION_TYPE_TO_EVENT: Record<string, PushEventType | null> = {
  TASK_ASSIGNED: 'task.assigned',
  TICKET_CREATED: 'ticket.created',
  TICKET_MESSAGE: 'chat.message',
  TICKET_UPDATED: 'ticket.status_changed',
  SLA_BREACHED: 'sla.breached',
  SLA_BREACH_WARNING: 'sla.warning',
  TASK_APPROVAL_REQUESTED: 'approval.requested',
  COMMENT_ADDED: 'comment.created',
  ALCANCE_SUBMITTED: 'alcance.submitted',
  CLIENT_DOCUMENT_SHARED: 'client.document.shared',
};

interface ClientContext {
  kind: 'client';
  userId: string;
  email: string;
  userName: string;
  organizationName: string;
  organizationLogo: string | null;
}

interface TeamContext {
  kind: 'team';
  userId: string;
  email: string;
}

type RecipientContext = ClientContext | TeamContext | null;

@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Envia un email al usuario si tiene habilitado el evento en sus preferencias EMAIL.
   * Best-effort: no falla si el usuario no tiene email, no esta opted-in, o Resend falla.
   *
   * Discrimina cliente vs team:
   * - Cliente -> template `clientNotificationEmail` con branding de su organizacion.
   * - Team    -> template `notificationEmail` con branding de Zentikk.
   */
  async sendFromNotification(notification: {
    userId: string;
    type: string;
    title: string;
    message: string;
    data?: any;
  }) {
    const logPrefix = `[email-notif user=${notification.userId} type=${notification.type}]`;

    if (!this.emailService.isEnabled) {
      this.logger.debug(`${logPrefix} skip: email service deshabilitado (RESEND_API_KEY?)`);
      return;
    }
    if (!notification.userId) {
      this.logger.debug(`${logPrefix} skip: sin userId`);
      return;
    }

    const eventType = NOTIFICATION_TYPE_TO_EVENT[notification.type];
    if (!eventType) {
      this.logger.debug(`${logPrefix} skip: tipo no mapeado a evento de email`);
      return;
    }

    // Verificar preference EMAIL (respeta opt-out explicito, usa default si no hay registro)
    const pref = await this.prisma.userNotificationPreference.findUnique({
      where: {
        userId_eventType_channel: {
          userId: notification.userId,
          eventType,
          channel: 'EMAIL',
        },
      },
    });
    if (pref) {
      if (!pref.enabled) {
        this.logger.log(`${logPrefix} skip: preferencia EMAIL=false para ${eventType}`);
        return;
      }
    } else {
      const meta = PUSH_EVENT_CATALOG.find((e) => e.eventType === eventType);
      if (!meta?.defaultEmailEnabled) {
        this.logger.log(
          `${logPrefix} skip: sin preferencia + default EMAIL=false para ${eventType}`,
        );
        return;
      }
    }

    const recipient = await this.resolveRecipientContext(notification.userId);
    if (!recipient) {
      this.logger.warn(`${logPrefix} skip: no se pudo resolver recipient context`);
      return;
    }

    this.logger.log(
      `${logPrefix} sending: event=${eventType} kind=${recipient.kind} to=${recipient.email}`,
    );

    const ctaPath = this.buildUrlForNotification(notification);
    const ctaUrl = `${this.config.webUrl}${ctaPath}`;

    if (recipient.kind === 'client') {
      await this.sendToClient(recipient, {
        contextLine: notification.message,
        title: notification.title,
        ctaUrl,
        statusBadge: this.deriveBadgeFromNotification(notification),
      });
    } else {
      await this.sendToTeam(recipient, {
        title: notification.title,
        message: notification.message,
        ctaUrl,
      });
    }
  }

  /**
   * Variante especifica para mensajes en chat de ticket. Construye contexto rico
   * (agente que respondio, preview del mensaje, badge del ticket). Solo aplica a
   * destinatarios cliente — el team ya recibe push via NotificationPushListener.
   */
  async sendChatTicketReplyToClient(params: {
    recipientUserId: string;
    senderName: string;
    ticketNumber?: string | null;
    ticketTitle?: string | null;
    ticketStatus?: string | null;
    ticketId?: string | null;
    messageContent: string;
  }) {
    if (!this.emailService.isEnabled) return;

    // Verificar preference EMAIL para chat.message
    const pref = await this.prisma.userNotificationPreference.findUnique({
      where: {
        userId_eventType_channel: {
          userId: params.recipientUserId,
          eventType: 'chat.message',
          channel: 'EMAIL',
        },
      },
    });
    if (pref) {
      if (!pref.enabled) return;
    } else {
      const meta = PUSH_EVENT_CATALOG.find((e) => e.eventType === 'chat.message');
      if (!meta?.defaultEmailEnabled) return;
    }

    const recipient = await this.resolveRecipientContext(params.recipientUserId);
    if (!recipient || recipient.kind !== 'client') return;

    const ticketTag = params.ticketNumber ? `#${params.ticketNumber}` : 'tu ticket';
    const titlePart = params.ticketTitle ? ` — ${params.ticketTitle}` : '';
    const subject = `[${recipient.organizationName}] ${ticketTag}${titlePart}: respuesta de ${params.senderName}`;

    const preview =
      params.messageContent.length > 300
        ? `${params.messageContent.slice(0, 300)}…`
        : params.messageContent;

    const ctaUrl = params.ticketId
      ? `${this.config.webUrl}/portal/tickets/${params.ticketId}`
      : `${this.config.webUrl}/portal/tickets`;

    const html = clientNotificationEmail({
      organizationName: recipient.organizationName,
      organizationLogo: recipient.organizationLogo,
      clientName: recipient.userName,
      contextLine: `${params.senderName} respondió a ${ticketTag}${titlePart}.`,
      quoteContent: preview,
      statusBadge: params.ticketStatus
        ? { label: this.formatStatus(params.ticketStatus), tone: this.statusTone(params.ticketStatus) }
        : undefined,
      ctaPrimary: { label: 'Responder en el portal', url: ctaUrl },
      ctaSecondary: params.ticketId
        ? { label: 'Ver historial completo', url: ctaUrl }
        : undefined,
      preferencesUrl: `${this.config.webUrl}/portal/settings`,
    });

    await this.sendWithBranding(recipient, subject, html);
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private async resolveRecipientContext(userId: string): Promise<RecipientContext> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        notificationEmail: true,
        clientProfile: {
          select: {
            organization: { select: { name: true, logo: true } },
          },
        },
        clientGroup: {
          select: {
            organization: { select: { name: true, logo: true } },
          },
        },
      },
    });

    if (!user) return null;
    const email = user.notificationEmail ?? user.email;
    if (!email) return null;

    const clientLink = user.clientProfile ?? user.clientGroup;
    if (clientLink) {
      return {
        kind: 'client',
        userId: user.id,
        email,
        userName: user.name,
        organizationName: clientLink.organization.name,
        organizationLogo: clientLink.organization.logo,
      };
    }

    return { kind: 'team', userId: user.id, email };
  }

  private async sendToClient(
    ctx: ClientContext,
    params: {
      contextLine: string;
      title: string;
      ctaUrl: string;
      statusBadge?: { label: string; tone: 'info' | 'success' | 'warning' };
    },
  ) {
    const subject = `[${ctx.organizationName}] ${params.title}`;
    const html = clientNotificationEmail({
      organizationName: ctx.organizationName,
      organizationLogo: ctx.organizationLogo,
      clientName: ctx.userName,
      contextLine: params.contextLine,
      statusBadge: params.statusBadge,
      ctaPrimary: { label: 'Ver detalle', url: params.ctaUrl },
      preferencesUrl: `${this.config.webUrl}/portal/settings`,
    });
    await this.sendWithBranding(ctx, subject, html);
  }

  private async sendToTeam(
    ctx: TeamContext,
    params: { title: string; message: string; ctaUrl: string },
  ) {
    const html = notificationEmail({
      title: params.title,
      message: params.message,
      ctaUrl: params.ctaUrl,
      ctaLabel: 'Ver detalle',
      preferencesUrl: `${this.config.webUrl}/profile/notifications`,
    });
    try {
      await this.emailService.send(ctx.email, `[Zentikk] ${params.title}`, html);
    } catch (err: any) {
      this.logger.warn(
        `Error enviando email-team a user ${ctx.userId}: ${err?.message ?? err}`,
      );
    }
  }

  private async sendWithBranding(ctx: ClientContext, subject: string, html: string) {
    try {
      await this.emailService.send(ctx.email, subject, html, {
        fromName: ctx.organizationName,
      });
    } catch (err: any) {
      this.logger.warn(
        `Error enviando email-client a user ${ctx.userId}: ${err?.message ?? err}`,
      );
    }
  }

  private buildUrlForNotification(notification: { type: string; data?: any }): string {
    const data = notification.data ?? {};
    if (notification.type === 'CLIENT_DOCUMENT_SHARED' && data.projectId) {
      return `/portal/projects/${data.projectId}/documents`;
    }
    if (data.ticketId) return `/tickets/${data.ticketId}`;
    if (data.taskId && data.projectId) return `/projects/${data.projectId}/tasks/${data.taskId}`;
    if (data.projectId) return `/projects/${data.projectId}/backlog`;
    return '/dashboard';
  }

  private deriveBadgeFromNotification(notification: {
    type: string;
    data?: any;
  }): { label: string; tone: 'info' | 'success' | 'warning' } | undefined {
    const status = notification.data?.status;
    if (status && notification.type === 'TICKET_UPDATED') {
      return { label: this.formatStatus(status), tone: this.statusTone(status) };
    }
    if (notification.type === 'SLA_BREACHED') return { label: 'SLA vencido', tone: 'warning' };
    if (notification.type === 'TASK_APPROVAL_REQUESTED')
      return { label: 'Pendiente de aprobacion', tone: 'info' };
    if (notification.type === 'ALCANCE_SUBMITTED')
      return { label: 'Pendiente de tu aprobacion', tone: 'info' };
    return undefined;
  }

  private formatStatus(status: string): string {
    const map: Record<string, string> = {
      OPEN: 'Abierto',
      IN_PROGRESS: 'En progreso',
      IN_REVIEW: 'En revision',
      RESOLVED: 'Resuelto',
      CLOSED: 'Cerrado',
    };
    return map[status] ?? status;
  }

  private statusTone(status: string): 'info' | 'success' | 'warning' {
    if (status === 'RESOLVED' || status === 'CLOSED') return 'success';
    if (status === 'IN_PROGRESS' || status === 'IN_REVIEW') return 'info';
    return 'info';
  }
}
