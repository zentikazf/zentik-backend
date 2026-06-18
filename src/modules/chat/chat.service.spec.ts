import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MessageService } from './chat.service';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { AppException } from '../../common/filters/app-exception';
import { SendMessageDto } from './dto/send-message.dto';

/**
 * Tests del gate read-only de chat en tickets RESOLVED (feature #11, R1).
 *
 * Cuando un ticket queda RESOLVED (terminal), el chat del canal asociado queda
 * read-only PARA EL CLIENTE (`User.clientId !== null`): `MessageService.create`
 * rechaza con `AppException` 403 código `TICKET_RESOLVED_READ_ONLY`. El staff
 * (`clientId === null`) y los tickets en cualquier otro estado pasan sin cambios.
 *
 * El gate vive en `MessageService.create`, único punto por el que entran tanto el
 * POST HTTP (`/chat/channels/:id/messages`) como el WS (`message:send`).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod).
 */
describe('MessageService — gate read-only chat en ticket RESOLVED (feature #11, R1)', () => {
  let service: MessageService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let storage: DeepMockProxy<StorageService>;

  const CHANNEL_ID = 'channel-1';
  const CLIENT_USER_ID = 'user-client-1';
  const STAFF_USER_ID = 'user-staff-1';
  const CLIENT_ID = 'client-1';
  const CREATED_MESSAGE_ID = 'message-created-1';

  const dto: SendMessageDto = { content: 'Hola' };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    storage = mockDeep<StorageService>();

    service = new MessageService(prisma, eventEmitter, storage);

    // ── Stubs del camino feliz (cuando el gate NO bloquea) ──────────
    prisma.message.create.mockResolvedValue({
      id: CREATED_MESSAGE_ID,
      content: dto.content,
      channelId: CHANNEL_ID,
      user: { id: STAFF_USER_ID, name: 'Staff', email: 's@x.com', image: null, clientId: null },
      files: [],
    } as never);
    prisma.channel.update.mockResolvedValue({ id: CHANNEL_ID } as never);
  });

  /** Configura el sender (clientId) y el status del ticket del canal. */
  function arrange(senderClientId: string | null, ticketStatus: string | null) {
    prisma.user.findUnique.mockResolvedValue(
      (senderClientId === undefined ? null : { clientId: senderClientId }) as never,
    );
    prisma.channel.findUnique.mockResolvedValue(
      (ticketStatus === null ? { ticket: null } : { ticket: { status: ticketStatus } }) as never,
    );
  }

  it('(a) cliente + ticket RESOLVED → lanza AppException TICKET_RESOLVED_READ_ONLY (403)', async () => {
    arrange(CLIENT_ID, 'RESOLVED');

    await expect(service.create(CHANNEL_ID, CLIENT_USER_ID, dto)).rejects.toMatchObject({
      code: 'TICKET_RESOLVED_READ_ONLY',
      statusCode: 403,
    });
    await expect(service.create(CHANNEL_ID, CLIENT_USER_ID, dto)).rejects.toBeInstanceOf(AppException);

    // No se creó el mensaje: el gate cortó antes.
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('(b) staff (clientId null) + ticket RESOLVED → permite enviar (no throw)', async () => {
    arrange(null, 'RESOLVED');

    await expect(service.create(CHANNEL_ID, STAFF_USER_ID, dto)).resolves.toBeDefined();
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
  });

  it('(c) cliente + ticket IN_PROGRESS → permite enviar (no throw)', async () => {
    arrange(CLIENT_ID, 'IN_PROGRESS');

    await expect(service.create(CHANNEL_ID, CLIENT_USER_ID, dto)).resolves.toBeDefined();
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
  });
});
