import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { SubscribePushDto, UnsubscribePushDto } from './dto/subscribe-push.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import {
  PUSH_EVENT_CATALOG,
  PUSH_EVENT_TYPES,
  PushEventType,
} from './push-events.constants';

/**
 * Mapea el `type` de una Notification in-app al eventType de push.
 * Si retorna null, no se envia push (el evento no esta en el catalogo push).
 */
const NOTIFICATION_TYPE_TO_PUSH_EVENT: Record<string, PushEventType | null> = {
  TASK_ASSIGNED: PUSH_EVENT_TYPES.TASK_ASSIGNED,
  TICKET_CREATED: PUSH_EVENT_TYPES.TICKET_CREATED,
  TICKET_MESSAGE: PUSH_EVENT_TYPES.CHAT_MESSAGE,
  TICKET_UPDATED: PUSH_EVENT_TYPES.TICKET_STATUS_CHANGED,
  SLA_BREACHED: PUSH_EVENT_TYPES.SLA_BREACHED,
  SLA_BREACH_WARNING: PUSH_EVENT_TYPES.SLA_WARNING,
  TASK_APPROVAL_REQUESTED: PUSH_EVENT_TYPES.APPROVAL_REQUESTED,
  COMMENT_ADDED: PUSH_EVENT_TYPES.COMMENT_CREATED,
  // Otros tipos (MENTION, SPRINT_STARTED, INVOICE_*, etc.) no se envian push.
};

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  tag?: string;
  data?: Record<string, any>;
}

@Injectable()
export class NotificationPushService implements OnModuleInit {
  private readonly logger = new Logger(NotificationPushService.name);
  private pushEnabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit() {
    if (!this.config.pushEnabled) {
      this.logger.warn(
        'VAPID keys no configuradas. Push notifications DESACTIVADAS. Configurar VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en .env',
      );
      return;
    }

    webpush.setVapidDetails(
      this.config.vapidSubject,
      this.config.vapidPublicKey!,
      this.config.vapidPrivateKey!,
    );
    this.pushEnabled = true;
    this.logger.log('Web Push inicializado correctamente (VAPID OK)');
  }

  getPublicKey(): string | null {
    return this.config.vapidPublicKey ?? null;
  }

  // ── Suscripciones ─────────────────────────────────────────────

  async subscribe(userId: string, dto: SubscribePushDto) {
    const existing = await this.prisma.pushSubscription.findUnique({
      where: { endpoint: dto.endpoint },
    });

    if (existing) {
      // Si el endpoint ya existe pero para otro usuario, reasignarlo
      if (existing.userId !== userId) {
        await this.prisma.pushSubscription.update({
          where: { endpoint: dto.endpoint },
          data: {
            userId,
            p256dh: dto.keys.p256dh,
            auth: dto.keys.auth,
            userAgent: dto.userAgent ?? null,
          },
        });
      }
      return { ok: true, id: existing.id };
    }

    const created = await this.prisma.pushSubscription.create({
      data: {
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: dto.userAgent ?? null,
      },
    });

    // Seed preferences con defaults si el usuario no las tenia aun
    await this.seedDefaultPreferences(userId);

    this.logger.log(`Usuario ${userId} suscrito a push (sub id: ${created.id})`);
    return { ok: true, id: created.id };
  }

  async unsubscribe(userId: string, dto: UnsubscribePushDto) {
    await this.prisma.pushSubscription
      .deleteMany({ where: { userId, endpoint: dto.endpoint } })
      .catch(() => {});
    return { ok: true };
  }

  async unsubscribeAll(userId: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { userId } });
    return { ok: true };
  }

  // ── Preferences ───────────────────────────────────────────────

  async getPreferences(userId: string) {
    const stored = await this.prisma.userNotificationPreference.findMany({
      where: { userId, channel: 'PUSH' },
    });

    const storedMap = new Map(stored.map((p) => [p.eventType, p]));

    // Devolver siempre el catalogo completo con el estado actual
    return PUSH_EVENT_CATALOG.map((meta) => {
      const record = storedMap.get(meta.eventType);
      return {
        eventType: meta.eventType,
        label: meta.label,
        description: meta.description,
        enabled: record ? record.enabled : meta.defaultEnabled,
      };
    });
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    const ops = dto.preferences.map((pref) =>
      this.prisma.userNotificationPreference.upsert({
        where: {
          userId_eventType_channel: {
            userId,
            eventType: pref.eventType,
            channel: pref.channel || 'PUSH',
          },
        },
        update: { enabled: pref.enabled },
        create: {
          userId,
          eventType: pref.eventType,
          channel: pref.channel || 'PUSH',
          enabled: pref.enabled,
        },
      }),
    );
    await this.prisma.$transaction(ops);
    return { ok: true };
  }

  private async seedDefaultPreferences(userId: string) {
    const existing = await this.prisma.userNotificationPreference.count({
      where: { userId, channel: 'PUSH' },
    });
    if (existing > 0) return;

    await this.prisma.userNotificationPreference.createMany({
      data: PUSH_EVENT_CATALOG.map((meta) => ({
        userId,
        eventType: meta.eventType,
        channel: 'PUSH',
        enabled: meta.defaultEnabled,
      })),
      skipDuplicates: true,
    });
  }

  // ── Envio ─────────────────────────────────────────────────────

  /**
   * Envia push a un usuario si tiene habilitado el evento en sus preferencias.
   * No falla si el usuario no esta suscrito o el evento esta deshabilitado.
   */
  async sendToUser(userId: string, eventType: PushEventType, payload: PushPayload) {
    if (!this.pushEnabled) return;
    if (!userId) return;

    // Verificar preferences (respeta opt-out explicito, usa default del catalogo si no hay registro)
    const pref = await this.prisma.userNotificationPreference.findUnique({
      where: {
        userId_eventType_channel: { userId, eventType, channel: 'PUSH' },
      },
    });
    if (pref) {
      if (!pref.enabled) return;
    } else {
      const meta = PUSH_EVENT_CATALOG.find((e) => e.eventType === eventType);
      if (!meta?.defaultEnabled) return;
    }

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
    });
    if (subs.length === 0) return;

    const payloadStr = JSON.stringify(payload);

    await this.dispatchToSubs(userId, subs, payloadStr);
  }

  /**
   * Conveniencia: dado una Notification in-app recien creada, dispara push
   * si corresponde (segun mapping + preferences).
   */
  async sendFromNotification(notification: {
    userId: string;
    type: string;
    title: string;
    message: string;
    data?: any;
  }) {
    if (!this.pushEnabled) return;
    const eventType = NOTIFICATION_TYPE_TO_PUSH_EVENT[notification.type];
    if (!eventType) return;

    const url = this.buildUrlForNotification(notification);

    await this.sendToUser(notification.userId, eventType, {
      title: notification.title,
      body: notification.message,
      url,
      data: {
        notificationType: notification.type,
        ...(notification.data ?? {}),
      },
    });
  }

  private buildUrlForNotification(notification: { type: string; data?: any }): string {
    const data = notification.data ?? {};
    if (data.ticketId) return `/tickets/${data.ticketId}`;
    if (data.taskId && data.projectId) return `/projects/${data.projectId}/tasks/${data.taskId}`;
    if (data.projectId) return `/projects/${data.projectId}/backlog`;
    return '/dashboard';
  }

  private async dispatchToSubs(userId: string, subs: any[], payloadStr: string) {
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payloadStr,
        );
      } catch (err: any) {
        const statusCode = err?.statusCode;
        // 410 Gone o 404 Not Found -> endpoint invalido, borrarlo
        if (statusCode === 410 || statusCode === 404) {
          this.logger.warn(
            `Push endpoint invalido (${statusCode}), borrando subscription ${sub.id}`,
          );
          await this.prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => {});
        } else {
          this.logger.error(
            `Error enviando push a user ${userId} (sub ${sub.id}): ${err?.message ?? err}`,
          );
        }
      }
    }
  }
}
