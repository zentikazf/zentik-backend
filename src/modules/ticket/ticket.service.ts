import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { UpdateTicketDto } from './dto/update-ticket.dto';

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getOrgTickets(orgId: string, status?: string) {
    return this.prisma.ticket.findMany({
      where: {
        organizationId: orgId,
        ...(status && { status: status as any }),
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true, slug: true } },
        task: { select: { id: true, title: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getProjectTickets(projectId: string) {
    return this.prisma.ticket.findMany({
      where: { projectId },
      include: {
        client: { select: { id: true, name: true, email: true } },
        task: { select: { id: true, title: true, status: true } },
        channel: { select: { id: true, name: true, _count: { select: { messages: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTicketDetail(ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        client: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true, slug: true } },
        task: { select: { id: true, title: true, status: true, priority: true } },
        channel: {
          select: {
            id: true,
            name: true,
            _count: { select: { messages: true } },
          },
        },
      },
    });

    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    return ticket;
  }

  async updateTicket(ticketId: string, dto: UpdateTicketDto) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.adminNotes !== undefined && { adminNotes: dto.adminNotes }),
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true, status: true } },
        channel: { select: { id: true, name: true } },
      },
    });

    this.logger.log(`Ticket ${ticketId} updated: status=${dto.status}`);
    return updated;
  }
}
