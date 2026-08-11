import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { Socket } from 'socket.io';
import { ChannelService, MessageService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { OutboxService } from '../sync/outbox.service';
import { SessionValidityService } from '../auth/session-validity.service';
import { AppException } from '../../common/filters/app-exception';
import { SendMessageDto } from './dto/send-message.dto';

/**
 * Tests del membership gate del chat (feature #18, R1/R2/R3).
 *
 * Cierra el eavesdropping multi-tenant: solo un miembro del canal
 * (`ChannelMember`) puede unirse al socket del canal, leer mensajes/miembros via
 * REST y escribir. El `userId` SIEMPRE proviene del request autenticado
 * (socket/sesion), nunca del payload del cliente.
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod).
 */
describe('Chat — membership gate (feature #18)', () => {
  const CHANNEL_ID = 'channel-1';
  const MEMBER_USER_ID = 'user-member-1';
  const OUTSIDER_USER_ID = 'user-outsider-1';

  const dto: SendMessageDto = { content: 'Hola' };

  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let storage: DeepMockProxy<StorageService>;
  let outbox: DeepMockProxy<OutboxService>;
  let sessionValidity: DeepMockProxy<SessionValidityService>;
  let messageService: MessageService;
  let channelService: ChannelService;
  let gateway: ChatGateway;

  /** Stub: el user es (true) / no es (false) miembro del canal. */
  function setMembership(isMember: boolean) {
    prisma.channelMember.findFirst.mockResolvedValue(
      (isMember ? { id: 'member-row-1' } : null) as never,
    );
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    storage = mockDeep<StorageService>();
    // OutboxService: 4º parametro del constructor desde #50 D5. Mockeado — este
    // spec no testea el encolado (eso vive en chat.service.spec.ts), solo necesita
    // que MessageService se pueda construir.
    outbox = mockDeep<OutboxService>();
    sessionValidity = mockDeep<SessionValidityService>();
    // Por default la sesion esta viva (el gate de membership es lo que se testea
    // aca; la revalidacion de sesion #19 tiene su propio spec).
    sessionValidity.isSessionLive.mockResolvedValue(true);

    messageService = new MessageService(prisma, eventEmitter, storage, outbox);
    channelService = new ChannelService(prisma, eventEmitter);
    gateway = new ChatGateway(messageService, prisma, sessionValidity);

    // Camino feliz de create (cuando el membership gate NO bloquea).
    prisma.user.findUnique.mockResolvedValue({ clientId: null } as never);
    // Canal sin ticket: el gate de encolado del outbox (#50 D5) no aplica.
    prisma.channel.findUnique.mockResolvedValue({ ticket: null } as never);
    // `create` abre `$transaction` SOLO si hay fila de outbox que atomizar; con
    // canal sin ticket (el arrange de arriba) escribe suelto contra `this.prisma`,
    // igual que antes de #50. El stub queda de todas formas para que el spec no
    // dependa del camino: corre el callback con el propio mock de prisma como `tx`,
    // asi las aserciones sobre `prisma.message.create` valen en los dos. Los casts
    // son puntuales: `$transaction` esta sobrecargado (array | callback) y TS tipa
    // la implementacion contra la firma del array.
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (cb: unknown) =>
      (cb as (tx: Prisma.TransactionClient) => Promise<unknown>)(
        prisma as unknown as Prisma.TransactionClient,
      ),
    );
    prisma.message.create.mockResolvedValue({
      id: 'message-created-1',
      content: dto.content,
      channelId: CHANNEL_ID,
      user: { id: MEMBER_USER_ID, name: 'Miembro', email: 'm@x.com', image: null, clientId: null },
      files: [],
    } as never);
    prisma.channel.update.mockResolvedValue({ id: CHANNEL_ID } as never);
  });

  // ── R1: channel:join (WebSocket) ────────────────────────────────────

  describe('R1 — channel:join (gateway)', () => {
    it('(a) user NO miembro → join rechazado, NO se une a la room', async () => {
      setMembership(false);
      const join = jest.fn();
      const client = {
        id: 'sock-1',
        userId: OUTSIDER_USER_ID,
        join,
        data: { sessionId: 'sess-1' },
      } as unknown as Socket;

      const result = await gateway.handleJoinChannel(client, { channelId: CHANNEL_ID });

      expect(result).toEqual({ success: false, error: 'No sos miembro de este canal' });
      expect(join).not.toHaveBeenCalled();
    });

    it('(d) user miembro → join OK, se une a la room', async () => {
      setMembership(true);
      const join = jest.fn();
      const client = {
        id: 'sock-2',
        userId: MEMBER_USER_ID,
        join,
        data: { sessionId: 'sess-2' },
      } as unknown as Socket;

      const result = await gateway.handleJoinChannel(client, { channelId: CHANNEL_ID });

      expect(result).toEqual({ success: true });
      expect(join).toHaveBeenCalledWith(CHANNEL_ID);
    });

    it('usa el userId del SOCKET, no del payload (no se puede spoofear)', async () => {
      setMembership(false);
      const join = jest.fn();
      const client = {
        id: 'sock-3',
        userId: OUTSIDER_USER_ID,
        join,
        data: { sessionId: 'sess-3' },
      } as unknown as Socket;

      await gateway.handleJoinChannel(client, { channelId: CHANNEL_ID });

      expect(prisma.channelMember.findFirst).toHaveBeenCalledWith({
        where: { channelId: CHANNEL_ID, userId: OUTSIDER_USER_ID },
        select: { id: true },
      });
    });
  });

  // ── R3: message:send / POST → MessageService.create ─────────────────

  describe('R3 — MessageService.create (WS message:send + POST REST)', () => {
    it('(b) user NO miembro → lanza CHANNEL_FORBIDDEN (403), NO crea el mensaje', async () => {
      setMembership(false);

      await expect(
        messageService.create(CHANNEL_ID, OUTSIDER_USER_ID, dto),
      ).rejects.toMatchObject({ code: 'CHANNEL_FORBIDDEN', statusCode: 403 });
      await expect(
        messageService.create(CHANNEL_ID, OUTSIDER_USER_ID, dto),
      ).rejects.toBeInstanceOf(AppException);

      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('(d) user miembro → crea el mensaje', async () => {
      setMembership(true);

      await expect(
        messageService.create(CHANNEL_ID, MEMBER_USER_ID, dto),
      ).resolves.toBeDefined();
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
    });
  });

  // ── R2: REST listMessages (findByChannel) ───────────────────────────

  describe('R2 — MessageService.findByChannel (GET /channels/:id/messages)', () => {
    it('(c) user NO miembro → lanza CHANNEL_FORBIDDEN (403), NO consulta mensajes', async () => {
      setMembership(false);

      await expect(
        messageService.findByChannel(CHANNEL_ID, OUTSIDER_USER_ID),
      ).rejects.toMatchObject({ code: 'CHANNEL_FORBIDDEN', statusCode: 403 });

      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    it('(d) user miembro → devuelve los mensajes', async () => {
      setMembership(true);
      prisma.message.findMany.mockResolvedValue([] as never);

      const result = await messageService.findByChannel(CHANNEL_ID, MEMBER_USER_ID);

      expect(result).toEqual({ data: [], nextCursor: null });
      expect(prisma.message.findMany).toHaveBeenCalledTimes(1);
    });
  });

  // ── R2: REST listMembers (getMembers) ───────────────────────────────

  describe('R2 — ChannelService.getMembers (GET /channels/:id/members)', () => {
    it('user NO miembro → lanza CHANNEL_FORBIDDEN (403), NO lista miembros', async () => {
      setMembership(false);

      await expect(
        channelService.getMembers(CHANNEL_ID, OUTSIDER_USER_ID),
      ).rejects.toMatchObject({ code: 'CHANNEL_FORBIDDEN', statusCode: 403 });

      expect(prisma.channelMember.findMany).not.toHaveBeenCalled();
    });

    it('user miembro → lista los miembros', async () => {
      setMembership(true);
      prisma.channelMember.findMany.mockResolvedValue([] as never);

      const result = await channelService.getMembers(CHANNEL_ID, MEMBER_USER_ID);

      expect(result).toEqual([]);
      expect(prisma.channelMember.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
