import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';

/**
 * TicketsGateway — WebSocket para sincronizacion bidireccional ticket↔kanban en tiempo real.
 *
 * Seguridad:
 * - CORS estricto basado en WEB_URL (NO wide-open)
 * - Autenticacion por session token (cookie/header/auth)
 * - Validacion de membership de organizacion antes de unir room
 * - Una room por organizacion: org:{orgId}
 *
 * Eventos server → client:
 *   ticket:updated         { ticket }
 *   ticket:created         { ticket }
 *   ticket:closed          { ticketId, reason }
 *   ticket:assigned        { ticketId, taskId, previousAssigneeId, newAssigneeId }
 *   ticket:event-appended  { ticketId, event }
 *   ticket:kanban-synced   { ticketId, status }
 */
@WebSocketGateway({
  cors: {
    origin: (origin: string, callback: (err: Error | null, allow?: boolean) => void) => {
      // Lista resuelta en runtime via env var WEB_URL (CSV)
      const allowed = (process.env.WEB_URL || 'http://localhost:3002')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  },
  namespace: '/tickets',
})
export class TicketsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TicketsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  // ────────────────────────────────────────────────────────────
  // Auth helpers (replican el patron de chat.gateway.ts)
  // ────────────────────────────────────────────────────────────

  private extractTokenFromCookies(cookieHeader?: string): string | undefined {
    if (!cookieHeader) return undefined;
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const cookie of cookies) {
      for (const name of [
        'zentik.session_token',
        'better-auth.session_token',
        '__Secure-better-auth.session_token',
      ]) {
        if (cookie.startsWith(`${name}=`)) {
          return cookie.slice(name.length + 1);
        }
      }
    }
    return undefined;
  }

  async handleConnection(client: Socket) {
    const token =
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization ||
      this.extractTokenFromCookies(client.handshake.headers?.cookie);

    if (!token) {
      this.logger.warn(`Cliente ${client.id} rechazado: sin token`);
      client.disconnect();
      return;
    }

    const sessionToken = token.startsWith('Bearer ') ? token.slice(7) : token;

    try {
      const session = await this.prisma.session.findFirst({
        where: { token: sessionToken, expiresAt: { gt: new Date() } },
        select: { userId: true, user: { select: { id: true, name: true } } },
      });

      if (!session) {
        this.logger.warn(`Cliente ${client.id} rechazado: session invalida`);
        client.disconnect();
        return;
      }

      (client as any).userId = session.userId;
      (client as any).userName = session.user.name;

      // Room personal para mensajes dirigidos a este usuario
      client.join(`user:${session.userId}`);

      this.logger.log(`Tickets WS conectado: ${client.id} (user=${session.userId})`);
    } catch (error) {
      this.logger.error(`Error validando session para ${client.id}`, error as Error);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Tickets WS desconectado: ${client.id}`);
  }

  /**
   * Cliente solicita unirse a la room de una organizacion.
   * VALIDA membership antes de unir — sin esto, cualquier user podria
   * espiar updates de cualquier org.
   */
  @SubscribeMessage('tickets:join-org')
  async handleJoinOrg(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orgId: string },
  ) {
    const userId = (client as any).userId as string | undefined;
    if (!userId || !data?.orgId) {
      return { success: false, error: 'Datos invalidos' };
    }

    const member = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId: data.orgId },
      select: { id: true },
    });

    if (!member) {
      this.logger.warn(
        `User ${userId} intento unirse a org ${data.orgId} sin ser miembro`,
      );
      return { success: false, error: 'No sos miembro de esta organizacion' };
    }

    client.join(`org:${data.orgId}`);
    return { success: true };
  }

  @SubscribeMessage('tickets:leave-org')
  async handleLeaveOrg(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orgId: string },
  ) {
    if (!data?.orgId) return { success: false };
    client.leave(`org:${data.orgId}`);
    return { success: true };
  }

  // ────────────────────────────────────────────────────────────
  // Listeners de eventos de dominio → broadcast WS
  // ────────────────────────────────────────────────────────────

  @OnEvent('ticket.updated')
  emitTicketUpdated(payload: {
    ticketId: string;
    organizationId?: string;
    status?: string;
    previousStatus?: string;
  }) {
    if (!payload.organizationId) return;
    this.server.to(`org:${payload.organizationId}`).emit('ticket:updated', {
      ticketId: payload.ticketId,
      status: payload.status,
      previousStatus: payload.previousStatus,
    });
  }

  @OnEvent('ticket.created')
  emitTicketCreated(payload: { ticketId: string; organizationId?: string; title?: string }) {
    if (!payload.organizationId) return;
    this.server.to(`org:${payload.organizationId}`).emit('ticket:created', {
      ticketId: payload.ticketId,
      title: payload.title,
    });
  }

  @OnEvent('ticket.closed')
  emitTicketClosed(payload: {
    ticketId: string;
    organizationId?: string;
    reason?: string;
  }) {
    if (!payload.organizationId) return;
    this.server.to(`org:${payload.organizationId}`).emit('ticket:closed', {
      ticketId: payload.ticketId,
      reason: payload.reason,
    });
  }

  @OnEvent('ticket.assigned')
  emitTicketAssigned(payload: {
    ticketId: string;
    taskId?: string;
    previousAssigneeId?: string | null;
    newAssigneeId?: string | null;
    organizationId?: string;
  }) {
    if (!payload.organizationId) return;
    this.server.to(`org:${payload.organizationId}`).emit('ticket:assigned', {
      ticketId: payload.ticketId,
      taskId: payload.taskId,
      previousAssigneeId: payload.previousAssigneeId,
      newAssigneeId: payload.newAssigneeId,
    });
  }
}
