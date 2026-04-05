import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateAdminTicketDto } from './dto/create-admin-ticket.dto';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

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
        channel: { select: { id: true, name: true, _count: { select: { messages: true } } } },
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

    // Emit event for notifications when status changes
    if (dto.status !== undefined) {
      this.eventEmitter.emit('ticket.updated', {
        ticketId: updated.id,
        title: updated.title,
        status: dto.status,
        projectId: updated.project?.id,
        clientId: updated.client?.id,
      });
    }

    return updated;
  }

  async createTicket(orgId: string, dto: CreateAdminTicketDto, createdByUserId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: dto.clientId, organizationId: orgId },
    });
    if (!client) {
      throw new AppException('Cliente no encontrado', 'CLIENT_NOT_FOUND', 404);
    }

    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, organizationId: orgId, clientId: dto.clientId },
      select: {
        id: true,
        name: true,
        organizationId: true,
        createdById: true,
        responsibleId: true,
        members: { select: { userId: true } },
      },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado o no pertenece al cliente', 'PROJECT_NOT_FOUND', 404);
    }

    const categoryLabel = dto.category === 'SUPPORT_REQUEST' ? 'Soporte' : 'Desarrollo';
    const channelName = `[${categoryLabel}] ${dto.title}`;
    const taskTitle = `[Ticket] ${dto.title}`;

    // Collect channel members
    const memberIds = project.members.map((m) => m.userId);
    // Add client user if has portal access
    if (client.userId && !memberIds.includes(client.userId)) {
      memberIds.push(client.userId);
    }
    // Add project responsible
    if (project.responsibleId && !memberIds.includes(project.responsibleId)) {
      memberIds.push(project.responsibleId);
    }
    // Add PO/PM
    const poAndPm = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: orgId,
        role: { name: { in: ['Product Owner', 'Project Manager'] } },
      },
      select: { userId: true },
    });
    for (const member of poAndPm) {
      if (!memberIds.includes(member.userId)) {
        memberIds.push(member.userId);
      }
    }

    const ticket = await this.prisma.$transaction(async (tx) => {
      const maxPosition = await tx.task.aggregate({
        where: { projectId: dto.projectId },
        _max: { position: true },
      });

      const task = await tx.task.create({
        data: {
          projectId: dto.projectId,
          title: taskTitle,
          description: dto.description,
          priority: (dto.priority as any) ?? 'MEDIUM',
          status: 'BACKLOG',
          type: 'SUPPORT',
          position: (maxPosition._max.position ?? -1) + 1,
          createdById: createdByUserId,
          clientVisible: true,
        },
      });

      const channel = await tx.channel.create({
        data: {
          name: channelName,
          type: 'TICKET',
          organizationId: orgId,
          createdById: createdByUserId,
          members: {
            create: memberIds.map((id) => ({ userId: id })),
          },
        },
      });

      const created = await tx.ticket.create({
        data: {
          organizationId: orgId,
          projectId: dto.projectId,
          clientId: dto.clientId,
          title: dto.title,
          description: dto.description,
          category: dto.category as any,
          priority: (dto.priority as any) ?? 'MEDIUM',
          taskId: task.id,
          channelId: channel.id,
        },
        include: {
          project: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } },
          task: { select: { id: true, title: true, status: true } },
          channel: { select: { id: true, name: true } },
        },
      });

      return created;
    });

    this.logger.log(`Ticket created by admin: ${ticket.id} for client: ${dto.clientId}`);

    this.eventEmitter.emit('ticket.created', {
      ...domainEvent('ticket.created', 'ticket', ticket.id, orgId, createdByUserId),
      ticketId: ticket.id,
      title: dto.title,
      category: dto.category,
      projectId: dto.projectId,
      clientName: client.name,
    });

    return ticket;
  }
}
