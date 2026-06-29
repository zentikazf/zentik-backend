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
import { MessageService } from './chat.service';
import { PrismaService } from '../../database/prisma.service';

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

  async handleConnection(client: Socket) {
    const token =
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization ||
      this.extractTokenFromCookies(client.handshake.headers?.cookie);

    if (!token) {
      this.logger.warn(
        `Cliente ${client.id} rechazado: sin token de autenticacion`,
      );
      client.disconnect();
      return;
    }

    const sessionToken = token.startsWith('Bearer ') ? token.slice(7) : token;

    try {
      const session = await this.prisma.session.findFirst({
        where: { token: sessionToken, expiresAt: { gt: new Date() } },
        select: { id: true, userId: true, user: { select: { id: true, name: true } } },
      });

      if (!session) {
        this.logger.warn(`Cliente ${client.id} rechazado: session invalida`);
        client.disconnect();
        return;
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
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado: ${client.id}`);
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

  @SubscribeMessage('message:typing')
  async handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string; userId: string; userName: string },
  ) {
    client.to(data.channelId).emit('message:typing', {
      userId: data.userId,
      userName: data.userName,
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
