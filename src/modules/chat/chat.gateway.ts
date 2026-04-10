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
      // Allow all origins in development, or origins matching WEB_URL in production
      callback(null, true);
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
        select: { userId: true, user: { select: { id: true, name: true } } },
      });

      if (!session) {
        this.logger.warn(`Cliente ${client.id} rechazado: session invalida`);
        client.disconnect();
        return;
      }

      (client as any).userId = session.userId;
      (client as any).userName = session.user.name;

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

  @SubscribeMessage('channel:join')
  async handleJoinChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    client.join(data.channelId);
    this.logger.log(
      `Cliente ${client.id} se unio al canal ${data.channelId}`,
    );
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
