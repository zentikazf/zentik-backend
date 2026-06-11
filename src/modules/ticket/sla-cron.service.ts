import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { TicketEventsService } from './ticket-events.service';

@Injectable()
export class SlaCronService {
  private readonly logger = new Logger(SlaCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly events: TicketEventsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkSlaBreaches() {
    const now = new Date();

    // Response SLA breaches
    const responseBreached = await this.prisma.ticket.findMany({
      where: {
        responseDeadline: { lt: now },
        firstResponseAt: null,
        slaResponseBreached: false,
        status: { in: ['OPEN'] },
      },
      select: {
        id: true,
        title: true,
        organizationId: true,
        projectId: true,
        clientId: true,
      },
    });

    if (responseBreached.length > 0) {
      // Transaccion: flag + TicketEvent atomicos para no quedar en estado
      // inconsistente (flag seteado sin evento o viceversa).
      await this.prisma.$transaction(async (tx) => {
        await tx.ticket.updateMany({
          where: { id: { in: responseBreached.map((t) => t.id) } },
          data: { slaResponseBreached: true },
        });
        for (const ticket of responseBreached) {
          await this.events.writeEventTx(tx, {
            ticketId: ticket.id,
            type: 'SLA_BREACH_RESPONSE',
            source: 'SYSTEM',
            metadata: { detectedAt: now.toISOString() },
          });
        }
      });

      for (const ticket of responseBreached) {
        this.logger.warn(`SLA response breached: ticket ${ticket.id}`);
        this.eventEmitter.emit('sla.breached', {
          ticketId: ticket.id,
          title: ticket.title,
          type: 'response',
          organizationId: ticket.organizationId,
          projectId: ticket.projectId,
        });
      }
    }

    // Resolution SLA breaches
    const resolutionBreached = await this.prisma.ticket.findMany({
      where: {
        resolutionDeadline: { lt: now },
        resolvedAt: null,
        slaResolutionBreached: false,
        status: { in: ['OPEN', 'IN_PROGRESS'] },
      },
      select: {
        id: true,
        title: true,
        organizationId: true,
        projectId: true,
        clientId: true,
      },
    });

    if (resolutionBreached.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.ticket.updateMany({
          where: { id: { in: resolutionBreached.map((t) => t.id) } },
          data: { slaResolutionBreached: true },
        });
        for (const ticket of resolutionBreached) {
          await this.events.writeEventTx(tx, {
            ticketId: ticket.id,
            type: 'SLA_BREACH_RESOLUTION',
            source: 'SYSTEM',
            metadata: { detectedAt: now.toISOString() },
          });
        }
      });

      for (const ticket of resolutionBreached) {
        this.logger.warn(`SLA resolution breached: ticket ${ticket.id}`);
        this.eventEmitter.emit('sla.breached', {
          ticketId: ticket.id,
          title: ticket.title,
          type: 'resolution',
          organizationId: ticket.organizationId,
          projectId: ticket.projectId,
        });
      }
    }

    // 80% warning for response
    const warningCandidates = await this.prisma.ticket.findMany({
      where: {
        responseDeadline: { not: null },
        firstResponseAt: null,
        slaResponseBreached: false,
        status: 'OPEN',
      },
      select: {
        id: true,
        title: true,
        organizationId: true,
        projectId: true,
        createdAt: true,
        responseDeadline: true,
      },
    });

    for (const ticket of warningCandidates) {
      if (!ticket.responseDeadline) continue;
      const total = ticket.responseDeadline.getTime() - ticket.createdAt.getTime();
      const elapsed = now.getTime() - ticket.createdAt.getTime();
      const progress = elapsed / total;

      if (progress >= 0.8 && progress < 1.0) {
        // Idempotencia: el cron corre cada 5min y el ticket puede permanecer
        // en la ventana [80%, 100%) varios ciclos. Persistimos UN solo
        // SLA_WARNING por ticket para no inflar el timeline.
        const existing = await this.prisma.ticketEvent.findFirst({
          where: { ticketId: ticket.id, type: 'SLA_WARNING' },
          select: { id: true },
        });
        if (!existing) {
          await this.events.writeEvent({
            ticketId: ticket.id,
            type: 'SLA_WARNING',
            source: 'SYSTEM',
            metadata: {
              detectedAt: now.toISOString(),
              progress: Math.round(progress * 100),
            },
          });
        }

        this.eventEmitter.emit('sla.warning', {
          ticketId: ticket.id,
          title: ticket.title,
          type: 'response',
          organizationId: ticket.organizationId,
          projectId: ticket.projectId,
          progress: Math.round(progress * 100),
        });
      }
    }

    const total = responseBreached.length + resolutionBreached.length;
    if (total > 0) {
      this.logger.log(`SLA check: ${total} breaches detected`);
    }
  }
}
