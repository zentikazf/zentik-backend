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
import { Interval } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { SessionValidityService } from '../auth/session-validity.service';

/** Codigos de rechazo de auth emitidos via `auth:error` (#19 BAJO-2). El frontend
 * los consume tal cual como senal primaria para hacer logout. */
type AuthErrorCode = 'NO_TOKEN' | 'INVALID_SESSION' | 'SERVER_ERROR';

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
    private readonly sessionValidity: SessionValidityService,
  ) {}

  // ────────────────────────────────────────────────────────────
  // Auth helpers (replican el patron de chat.gateway.ts)
  // ────────────────────────────────────────────────────────────

  /**
   * Extrae UA e IP del handshake (#19 MEDIO-1). UA del header `user-agent`; IP de
   * X-Forwarded-For[0] con fallback a `handshake.address`. XFF[0] es spoofeable sin
   * trust proxy → la IP NUNCA sube a hard-bind en este stack (solo soft-log).
   */
  private getClientContext(client: Socket): { ua?: string; ip?: string } {
    const headers = client.handshake.headers || {};
    const ua =
      typeof headers['user-agent'] === 'string' ? headers['user-agent'] : undefined;
    const xff = headers['x-forwarded-for'];
    let ip: string | undefined;
    if (typeof xff === 'string' && xff.length > 0) {
      ip = xff.split(',')[0]?.trim();
    } else if (Array.isArray(xff) && xff.length > 0) {
      ip = xff[0]?.split(',')[0]?.trim();
    }
    if (!ip) ip = client.handshake.address;
    return { ua, ip };
  }

  /**
   * Rechaza un socket en el camino de auth (#19 BAJO-2). Emite `auth:error` con el
   * code (senal primaria tipada que el frontend usa para logout) ANTES de
   * `disconnect(true)`. `'io server disconnect'` queda de respaldo.
   */
  private rejectAuth(client: Socket, code: AuthErrorCode): void {
    client.emit('auth:error', { code });
    client.disconnect(true);
  }

  /**
   * Revalida la sesion del socket en el acto (#19 ALTO-2, capa 2b). Si la sesion
   * ya no esta viva, emite `session:expired`, desconecta y devuelve false. FAIL-OPEN:
   * una excepcion de DB en isSessionLive devuelve true (no corta).
   */
  private async assertLiveSession(client: Socket): Promise<boolean> {
    const sessionId = client.data?.sessionId as string | undefined;
    if (!sessionId) return false;
    const live = await this.sessionValidity.isSessionLive(sessionId);
    if (!live) {
      client.emit('session:expired');
      client.disconnect(true);
    }
    return live;
  }

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
      this.rejectAuth(client, 'NO_TOKEN');
      return;
    }

    const sessionToken = token.startsWith('Bearer ') ? token.slice(7) : token;

    try {
      const session = await this.prisma.session.findFirst({
        where: { token: sessionToken, expiresAt: { gt: new Date() } },
        select: {
          id: true,
          userId: true,
          ipAddress: true,
          userAgent: true,
          user: { select: { id: true, name: true } },
        },
      });

      if (!session) {
        this.logger.warn(`Cliente ${client.id} rechazado: session invalida`);
        this.rejectAuth(client, 'INVALID_SESSION');
        return;
      }

      // Bind UA/IP del handshake vs la sesion (#19 MEDIO-1). SOFT-LOG en este
      // deploy: si difieren se loguea pero NO se desconecta (falsos positivos
      // moviles). Guardas null protegen sesiones legacy. Hard-reject detras de D1.
      const { ua, ip } = this.getClientContext(client);
      if (session.userAgent && ua && session.userAgent.trim() !== ua.trim()) {
        this.logger.warn(
          `Tickets WS: UA mismatch user ${session.userId} (socket ${client.id}) — soft-log, no desconecta`,
        );
      }
      if (session.ipAddress && ip && session.ipAddress.trim() !== ip.trim()) {
        this.logger.debug(
          `Tickets WS: IP mismatch user ${session.userId} (socket ${client.id}) — soft-log, no desconecta`,
        );
      }

      (client as any).userId = session.userId;
      (client as any).userName = session.user.name;
      // sessionId: necesario para el cierre por-sesion al logout (R4). Lo guardamos
      // tambien en client.data porque fetchSockets() devuelve RemoteSocket donde solo
      // .data esta garantizado (los campos sueltos en el socket no se serializan).
      (client as any).sessionId = session.id;
      client.data.sessionId = session.id;
      client.data.userId = session.userId;

      // Room personal para mensajes dirigidos a este usuario
      client.join(`user:${session.userId}`);

      this.logger.log(`Tickets WS conectado: ${client.id} (user=${session.userId})`);
    } catch (error) {
      this.logger.error(`Error validando session para ${client.id}`, error as Error);
      this.rejectAuth(client, 'SERVER_ERROR');
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Tickets WS desconectado: ${client.id}`);
  }

  /**
   * Heartbeat de revalidacion de sesion en vivo (#19 ALTO-2, capa 2a). Cada 60s
   * barre TODO el namespace via fetchSockets() (RemoteSocket → solo `socket.data`
   * garantizado) y desconecta los sockets cuya sesion ya no esta viva. Nombre unico
   * (`tickets-session-revalidation`) para no colisionar con el de chat. El ciclo va
   * en try/catch: un fallo global se saltea sin matar sockets.
   */
  @Interval('tickets-session-revalidation', 60000)
  async revalidateSessions(): Promise<void> {
    try {
      const sockets = await this.server.fetchSockets();
      for (const socket of sockets) {
        const sessionId = socket.data?.sessionId as string | undefined;
        if (!sessionId) continue;
        const live = await this.sessionValidity.isSessionLive(sessionId);
        if (!live) {
          socket.emit('session:expired');
          socket.disconnect(true);
          this.logger.log(
            `Tickets WS: socket ${socket.id} desconectado por sesion no viva (${sessionId})`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Tickets WS: error en el ciclo de revalidacion de sesiones', error as Error);
    }
  }

  /**
   * Desconecta los sockets de un usuario (R4: zombie sessions al logout/revoke).
   * - Con `sessionId`: solo el socket de ESA sesion (logout por-sesion / revoke puntual).
   * - Sin `sessionId`: TODOS los sockets del user (revoke-all / cerrar todas las sesiones).
   * Itera la room personal `user:{userId}`. Lee `sessionId` de `socket.data` porque
   * fetchSockets() devuelve RemoteSocket donde solo `.data` esta garantizado.
   */
  async disconnectUserSockets(userId: string, sessionId?: string): Promise<void> {
    const sockets = await this.server.in(`user:${userId}`).fetchSockets();
    let count = 0;
    for (const socket of sockets) {
      if (sessionId && socket.data?.sessionId !== sessionId) {
        continue;
      }
      socket.disconnect(true);
      count++;
    }
    if (count > 0) {
      this.logger.log(
        `Tickets WS: desconectados ${count} socket(s) de user ${userId}` +
          (sessionId ? ` (sessionId ${sessionId})` : ' (todas las sesiones)'),
      );
    }
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
    // Revalida la sesion en el acto (#19 ALTO-2) antes de exponer la room de org.
    if (!(await this.assertLiveSession(client))) {
      return { success: false, error: 'Sesión expirada' };
    }

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

  // ────────────────────────────────────────────────────────────
  // Aprobaciones → senal fina de invalidacion del badge (#20)
  // ────────────────────────────────────────────────────────────
  //
  // Patron: el backend NO empuja el numero, solo dice "refresca". El cliente
  // refetchea el count() real (DB = fuente de verdad), inmune al desync +1/-1.
  // Reusa la room por-org ya poblada (`org:{orgId}`) y el shape en pasado de los
  // emit de ticket (`approvals:updated`, NO imperativo `:invalidate`).
  //
  // EventEmitterModule es global (app.module.ts) → este gateway escucha los
  // eventos de dominio `task.approval.*` y `task.moved` SIN importar TaskModule
  // ni BoardModule (igual que ticket-sync.listener.ts ya hace).
  //
  // `payload.organizationId` SIEMPRE viene del helper `domainEvent(...)` (spread
  // en el emit). Leemos SOLO ese campo: `entityId` en la variante board es el
  // `boardId`, no la org — usarlo seria un bug de scope.

  /**
   * Emite la senal de invalidacion de aprobaciones a la room de la org. Helper
   * privado para no duplicar el guard + emit en cada listener.
   */
  private emitApprovalsUpdated(organizationId?: string): void {
    if (!organizationId) return;
    this.server
      .to(`org:${organizationId}`)
      .emit('approvals:updated', { orgId: organizationId });
  }

  /**
   * Toda transicion del flujo de aprobacion (solicitud / aprobada / rechazada)
   * cambia el count de pendientes → invalidamos el badge de los admins de la org.
   */
  @OnEvent('task.approval.requested')
  @OnEvent('task.approval.approved')
  @OnEvent('task.approval.rejected')
  emitApprovalsUpdatedFromApproval(payload: { organizationId?: string }) {
    this.emitApprovalsUpdated(payload.organizationId);
  }

  /**
   * Salida/entrada de IN_REVIEW por drag&drop del kanban (`task.moved`) tambien
   * cambia el count de aprobaciones, PERO `task.moved` se emite en CADA drag. Por
   * eso gateamos adentro: solo invalidamos si el movimiento toca IN_REVIEW (entra
   * o sale), para no disparar un refetch en cada movimiento de tarjeta.
   */
  @OnEvent('task.moved')
  emitApprovalsUpdatedFromMove(payload: {
    organizationId?: string;
    previousStatus?: string;
    newStatus?: string;
  }) {
    if (!payload.organizationId) return;
    const touchesReview =
      payload.previousStatus === 'IN_REVIEW' || payload.newStatus === 'IN_REVIEW';
    if (!touchesReview) return;
    this.emitApprovalsUpdated(payload.organizationId);
  }
}
