import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { TicketSyncListener } from './ticket-sync.listener';
import { TicketService } from './ticket.service';
import { PrismaService } from '../../database/prisma.service';
import { MessageService } from '../chat/chat.service';

/**
 * Feature #43 R2.4 — al rechazar el PM, el ticket vuelve a IN_PROGRESS y el chat
 * del cliente se reabre. Dejamos huella visible con un mensaje de sistema en el
 * hilo. El motivo INTERNO del rechazo NUNCA viaja al cliente.
 *
 * El chat no tiene emisor "sistema" (todo Message exige un User que sea
 * ChannelMember), así que el aviso se atribuye al actor y se garantiza su
 * membresía de forma idempotente. Todo mockeado — no toca DB ni WS.
 */
describe('TicketSyncListener — mensaje de sistema al reabrir (#43 R2.4)', () => {
  let listener: TicketSyncListener;
  let ticketService: DeepMockProxy<TicketService>;
  let prisma: DeepMockProxy<PrismaService>;
  let messages: DeepMockProxy<MessageService>;

  const PM = 'user-pm-1';
  const CHANNEL = 'chan-1';

  beforeEach(() => {
    ticketService = mockDeep<TicketService>();
    prisma = mockDeep<PrismaService>();
    messages = mockDeep<MessageService>();
    listener = new TicketSyncListener(ticketService, prisma, messages);
    // Estado PREVIO del ticket (default: RESOLVED = reapertura real). El aviso
    // solo se emite en RESOLVED→IN_PROGRESS.
    prisma.ticket.findFirst.mockResolvedValue({ status: 'RESOLVED' } as never);
  });

  it('rechazo con transición real → escribe el aviso de reapertura (texto fijo)', async () => {
    ticketService.syncTicketFromTaskMove.mockResolvedValue({
      channelId: CHANNEL,
      status: 'IN_PROGRESS',
    } as never);

    await listener.handleTaskRejected({
      taskId: 'task-1',
      rejectedById: PM,
      // reason interno que NO debe filtrarse al hilo del cliente
      metadata: {},
    } as never);

    // Garantiza membresía del actor (idempotente) antes de escribir.
    expect(prisma.channelMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { channelId_userId: { channelId: CHANNEL, userId: PM } },
      }),
    );
    // Escribe el mensaje atribuido al actor.
    expect(messages.create).toHaveBeenCalledTimes(1);
    const [channelId, userId, dto] = messages.create.mock.calls[0];
    expect(channelId).toBe(CHANNEL);
    expect(userId).toBe(PM);
    expect(dto.content).toBe('Reabrimos este ticket para una revisión adicional.');
  });

  it('el aviso NO incluye el motivo interno del rechazo', async () => {
    ticketService.syncTicketFromTaskMove.mockResolvedValue({
      channelId: CHANNEL,
      status: 'IN_PROGRESS',
    } as never);

    await listener.handleTaskRejected({
      taskId: 'task-1',
      rejectedById: PM,
      reason: 'El código no compila — problema interno del equipo',
    } as never);

    const dto = messages.create.mock.calls[0][2];
    expect(dto.content).not.toContain('no compila');
    expect(dto.content).not.toContain('interno');
  });

  it('rechazo desde OPEN (no era RESOLVED) → NO escribe el aviso (no es reapertura)', async () => {
    // #43: task IN_REVIEW es no-op, así que una task puede estar en revisión con
    // el ticket en OPEN; un rechazo ahí hace OPEN→IN_PROGRESS y NO es reapertura.
    prisma.ticket.findFirst.mockResolvedValue({ status: 'OPEN' } as never);
    ticketService.syncTicketFromTaskMove.mockResolvedValue({
      channelId: CHANNEL,
      status: 'IN_PROGRESS',
    } as never);

    await listener.handleTaskRejected({ taskId: 'task-1', rejectedById: PM } as never);

    expect(messages.create).not.toHaveBeenCalled();
  });

  it('sin transición (sync devuelve null) → NO escribe mensaje', async () => {
    ticketService.syncTicketFromTaskMove.mockResolvedValue(null as never);

    await listener.handleTaskRejected({ taskId: 'task-1', rejectedById: PM } as never);

    expect(messages.create).not.toHaveBeenCalled();
    expect(prisma.channelMember.upsert).not.toHaveBeenCalled();
  });

  it('actor "system" (sin usuario real) → NO escribe mensaje (no hay emisor)', async () => {
    ticketService.syncTicketFromTaskMove.mockResolvedValue({
      channelId: CHANNEL,
      status: 'IN_PROGRESS',
    } as never);

    // rejectedById ausente → userId = 'system'
    await listener.handleTaskRejected({ taskId: 'task-1' } as never);

    expect(messages.create).not.toHaveBeenCalled();
  });

  it('el evento del propio sync (loop guard) se ignora sin tocar el ticket', async () => {
    await listener.handleTaskRejected({
      taskId: 'task-1',
      rejectedById: PM,
      metadata: { fromTicketSync: true },
    } as never);

    expect(ticketService.syncTicketFromTaskMove).not.toHaveBeenCalled();
    expect(messages.create).not.toHaveBeenCalled();
  });

  it('un fallo al escribir el aviso no tumba el flujo de rechazo (falla suave)', async () => {
    ticketService.syncTicketFromTaskMove.mockResolvedValue({
      channelId: CHANNEL,
      status: 'IN_PROGRESS',
    } as never);
    messages.create.mockRejectedValue(new Error('boom') as never);

    // No debe propagar la excepción.
    await expect(
      listener.handleTaskRejected({ taskId: 'task-1', rejectedById: PM } as never),
    ).resolves.toBeUndefined();
  });
});
