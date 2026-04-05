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
import { Server, Socket } from 'socket.io';
import { MessageService } from './chat.service';
import { PrismaService } from '../../database/prisma.service';

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/chat' })
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

  async handleConnection(client: Socket) {
    const token =
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization;

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

      const message = await this.messageService.create(
        data.channelId,
        userId,
        { content: data.content },
      );

      this.server.to(data.channelId).emit('message:new', message);

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
}
