import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  TicketEventType,
  TicketEventSource,
  Prisma,
} from '@prisma/client';

interface WriteEventInput {
  ticketId: string;
  type: TicketEventType;
  fromValue?: string | null;
  toValue?: string | null;
  source?: TicketEventSource;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class TicketEventsService {
  private readonly logger = new Logger(TicketEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write a single ticket event using the global Prisma client.
   * For events that must be transactional with another mutation,
   * use writeEventTx() with a Prisma transaction client instead.
   */
  async writeEvent(input: WriteEventInput) {
    return this.prisma.ticketEvent.create({
      data: {
        ticketId: input.ticketId,
        type: input.type,
        fromValue: input.fromValue ?? null,
        toValue: input.toValue ?? null,
        source: input.source ?? 'TICKET',
        userId: input.userId ?? null,
        metadata: (input.metadata ?? null) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Write a ticket event INSIDE an existing transaction.
   * Use this when the event must be atomic with the mutation that triggers it.
   */
  async writeEventTx(
    tx: Prisma.TransactionClient,
    input: WriteEventInput,
  ) {
    return tx.ticketEvent.create({
      data: {
        ticketId: input.ticketId,
        type: input.type,
        fromValue: input.fromValue ?? null,
        toValue: input.toValue ?? null,
        source: input.source ?? 'TICKET',
        userId: input.userId ?? null,
        metadata: (input.metadata ?? null) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Get the timeline of a ticket (most recent first).
   */
  async listByTicket(ticketId: string, limit = 100) {
    return this.prisma.ticketEvent.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
    });
  }
}
