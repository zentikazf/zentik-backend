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
import { MessageService } from './chat.service';
import { PrismaService } from '../../database/prisma.service';
import { SessionValidityService } from '../auth/session-validity.service';

/** Codigos de rechazo de auth emitidos via `auth:error` (#19 BAJO-2). El frontend
 * los consume tal cual como senal primaria para hacer logout. */
type AuthErrorCode = 'NO_TOKEN' | 'INVALID_SESSION' | 'SERVER_ERROR';

@WebSocketGateway({
  cors: {
    origin: (origin: string, callback: (err: Error | null, allow?: boolean) => void) => {
      // CORS estricto basado en WEB_URL (CSV). Mismo validador que tickets.gateway.ts.
      // Allow-all era un agujero (ALTO-3): cualquier origen podia abrir el socket.
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
  namespace: '/chat',
})
export class ChatGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly messageService: MessageService,
    private readonly prisma: PrismaService,
    private readonly sessionValidity: SessionValidityService,
  ) {}

  private extractTokenFromCookies(cookieHeader?: string): string | undefined {
    if (!cookieHeader) return undefined;
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const cookie of cookies) {
      for (const name of ['zentik.session_token', 'better-auth.session_token', '__Secure-better-auth.session_token']) {
        if (cookie.startsWith(`${name}=`)) {
          return cookie.slice(name.length + 1);
        }
      }
    }
    return undefined;
  }

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
   * `disconnect(true)`. El writeBuffer de socket.io se drena antes de cerrar el
   * transporte, asi que el paquete llega; `'io server disconnect'` queda de respaldo.
   */
  private rejectAuth(client: Socket, code: AuthErrorCode): void {
    client.emit('auth:error', { code });
    client.disconnect(true);
  }

  /**
   * Revalida la sesion del socket en el acto (#19 ALTO-2, capa 2b). Cierra la
   * ventana de 60s del @Interval para acciones sensibles: si la sesion ya no esta
   * viva, emite `session:expired`, desconecta y devuelve false para que el handler
   * corte. FAIL-OPEN: una excepcion de DB en isSessionLive devuelve true (no corta).
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

  async handleConnection(client: Socket) {
    const token =
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization ||
      this.extractTokenFromCookies(client.handshake.headers?.cookie);

    if (!token) {
      this.logger.warn(
        `Cliente ${client.id} rechazado: sin token de autenticacion`,
      );
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
      // deploy: si difieren se loguea pero NO se desconecta (Android System
      // WebView se auto-actualiza → UA del handshake difiere del congelado en
      // login = falso positivo). Guardas null (`session.x && y &&`) protegen
      // sesiones legacy con campos null. El hard-reject queda detras de D1.
      const { ua, ip } = this.getClientContext(client);
      if (session.userAgent && ua && session.userAgent.trim() !== ua.trim()) {
        this.logger.warn(
          `Chat WS: UA mismatch user ${session.userId} (socket ${client.id}) — soft-log, no desconecta`,
        );
      }
      if (session.ipAddress && ip && session.ipAddress.trim() !== ip.trim()) {
        this.logger.warn(
          `Chat WS: IP mismatch user ${session.userId} (socket ${client.id}) — soft-log, no desconecta`,
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

      // Join personal room for real-time notifications
      client.join(`user:${session.userId}`);

      this.logger.log(`Cliente conectado: ${client.id} (user: ${session.userId})`);
    } catch (error) {
      this.logger.error(`Error validando session para ${client.id}`, error);
      this.rejectAuth(client, 'SERVER_ERROR');
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado: ${client.id}`);
  }

  /**
   * Heartbeat de revalidacion de sesion en vivo (#19 ALTO-2, capa 2a). Cada 60s
   * barre TODO el namespace via fetchSockets() (devuelve RemoteSocket → solo
   * `socket.data` esta garantizado, por eso leemos `data.sessionId`) y desconecta
   * los sockets cuya sesion ya no esta viva (expiro por TTL o se revoco). Cubre
   * sockets ociosos sin trafico. Nombre unico para no colisionar con tickets.
   * El ciclo entero va en try/catch: un fallo global se saltea sin matar sockets.
   */
  @Interval('chat-session-revalidation', 60000)
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
            `Chat WS: socket ${socket.id} desconectado por sesion no viva (${sessionId})`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Chat WS: error en el ciclo de revalidacion de sesiones', error as Error);
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
        `Chat WS: desconectados ${count} socket(s) de user ${userId}` +
          (sessionId ? ` (sessionId ${sessionId})` : ' (todas las sesiones)'),
      );
    }
  }

  @SubscribeMessage('message:send')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { channelId: string; content: string; parentId?: string },
  ) {
    // Revalida la sesion en el acto (#19 ALTO-2): un message:send con sesion ya
    // revocada se rechaza al instante, sin esperar al heartbeat de 60s.
    if (!(await this.assertLiveSession(client))) {
      return { success: false, error: 'Sesión expirada' };
    }

    try {
      const userId = (client as any).userId;

      if (!userId) {
        return { success: false, error: 'Usuario no autenticado' };
      }

      // Message created via WS — the OnEvent listener will broadcast it
      const message = await this.messageService.create(
        data.channelId,
        userId,
        { content: data.content },
      );

      return { success: true, data: message };
    } catch (error) {
      this.logger.error('Error al enviar mensaje via WebSocket', error);
      return { success: false, error: 'Error al enviar mensaje' };
    }
  }

  /**
   * Indicador de "escribiendo" (#19 MEDIO-2: typing no-spoofeable).
   * - La identidad SIEMPRE proviene del socket autenticado (userId/userName),
   *   NUNCA del payload del cliente (igual que handleMessage/handleJoinChannel).
   *   El payload entrante solo aporta `channelId`.
   * - Gate de membership zero-DB: `client.rooms.has(channelId)`. INVARIANTE: la
   *   UNICA via de entrar a la room de un canal es `handleJoinChannel`, que ya
   *   valido `ChannelMember`. Por eso estar en la room == ser miembro, sin query.
   * - Reemite con `client.to(room)` para EXCLUIR al emisor.
   */
  @SubscribeMessage('message:typing')
  async handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const userId = (client as any).userId as string | undefined;
    const userName = (client as any).userName as string | undefined;
    if (!userId || !data?.channelId || !client.rooms.has(data.channelId)) {
      return;
    }
    client.to(data.channelId).emit('message:typing', {
      userId,
      userName,
      channelId: data.channelId,
    });
  }

  /**
   * Cliente solicita unirse a la room de un canal.
   * VALIDA membership antes de unir — sin esto, cualquier user podia espiar
   * mensajes en vivo de cualquier canal (CRITICO-1: eavesdropping multi-tenant).
   * El userId se toma del SOCKET autenticado, NUNCA del payload del cliente.
   * Espejo de tickets.gateway.ts handleJoinOrg.
   */
  @SubscribeMessage('channel:join')
  async handleJoinChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    // Revalida la sesion en el acto (#19 ALTO-2) antes de exponer la room.
    if (!(await this.assertLiveSession(client))) {
      return { success: false, error: 'Sesión expirada' };
    }

    const userId = (client as any).userId as string | undefined;
    if (!userId || !data?.channelId) {
      return { success: false, error: 'Datos invalidos' };
    }

    const member = await this.prisma.channelMember.findFirst({
      where: { channelId: data.channelId, userId },
      select: { id: true },
    });

    if (!member) {
      this.logger.warn(
        `User ${userId} intento unirse al canal ${data.channelId} sin ser miembro`,
      );
      return { success: false, error: 'No sos miembro de este canal' };
    }

    client.join(data.channelId);
    this.logger.log(
      `Cliente ${client.id} se unio al canal ${data.channelId}`,
    );
    return { success: true };
  }

  @SubscribeMessage('channel:leave')
  async handleLeaveChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    client.leave(data.channelId);
    this.logger.log(
      `Cliente ${client.id} salio del canal ${data.channelId}`,
    );
  }

  /**
   * Broadcast messages created via REST to WebSocket subscribers.
   * MessageService emits 'message.sent' with enrichedMessage.
   */
  @OnEvent('message.sent')
  handleMessageSentEvent(payload: { channelId: string; enrichedMessage: any }) {
    if (!payload.enrichedMessage) return;
    this.server.to(payload.channelId).emit('message:new', payload.enrichedMessage);
  }
}
