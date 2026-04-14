import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateAdminTicketDto } from './dto/create-admin-ticket.dto';
import { CreateCategoryConfigDto, UpdateCategoryConfigDto } from './dto/create-category-config.dto';
import { UpsertSlaConfigDto } from './dto/upsert-sla-config.dto';
import { UpsertBusinessHoursDto } from './dto/upsert-business-hours.dto';
import { domainEvent } from '../../common/events/domain-event.helper';
import { calculateBusinessDeadline, parseBusinessDays } from './sla.util';

/**
 * Generates a sequential ticket number per org: YYYYMMDD-NNN
 * Uses the Prisma transaction client to ensure atomicity.
 */
export async function generateTicketNumber(
  tx: { ticket: { count: (args: any) => Promise<number> } },
  organizationId: string,
): Promise<string> {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000);

  const countToday = await tx.ticket.count({
    where: {
      organizationId,
      createdAt: { gte: startOfDay, lt: endOfDay },
    },
  });

  return `${dateStr}-${String(countToday + 1).padStart(3, '0')}`;
}

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Ticket CRUD ──────────────────────────────────────────

  async getOrgTickets(orgId: string, status?: string, clientId?: string, search?: string, createdByUserId?: string, categoryConfigId?: string) {
    return this.prisma.ticket.findMany({
      where: {
        organizationId: orgId,
        ...(status && { status: status as any }),
        ...(clientId && { clientId }),
        ...(createdByUserId && { createdByUserId }),
        ...(categoryConfigId && { categoryConfigId }),
        ...(search && {
          OR: [
            { title: { contains: search, mode: 'insensitive' as const } },
            { id: { contains: search, mode: 'insensitive' as const } },
          ],
        }),
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true, slug: true } },
        task: { select: { id: true, title: true, status: true } },
        channel: { select: { id: true, name: true, _count: { select: { messages: true } } } },
        categoryConfig: { select: { id: true, name: true, criticality: true } },
        createdByUser: { select: { id: true, name: true } },
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
        categoryConfig: { select: { id: true, name: true, criticality: true } },
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
        categoryConfig: { select: { id: true, name: true, criticality: true } },
        createdByUser: { select: { id: true, name: true } },
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

    const data: Record<string, any> = {};
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.adminNotes !== undefined) data.adminNotes = dto.adminNotes;

    // SLA tracking: first response when moving to IN_PROGRESS
    if (dto.status === 'IN_PROGRESS' && !ticket.firstResponseAt) {
      data.firstResponseAt = new Date();
    }

    // SLA tracking: resolved timestamp
    if (dto.status === 'RESOLVED' && !ticket.resolvedAt) {
      data.resolvedAt = new Date();
    }

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data,
      include: {
        client: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true, status: true } },
        channel: { select: { id: true, name: true } },
      },
    });

    this.logger.log(`Ticket ${ticketId} updated: status=${dto.status}`);

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

    // Resolve SLA deadlines if category config exists
    let categoryConfig: any = null;
    let criticality: string | null = null;
    let responseDeadline: Date | null = null;
    let resolutionDeadline: Date | null = null;

    if (dto.categoryConfigId) {
      categoryConfig = await this.prisma.ticketCategoryConfig.findFirst({
        where: { id: dto.categoryConfigId, organizationId: orgId, isActive: true },
      });
    }

    if (categoryConfig) {
      criticality = categoryConfig.criticality;
      const slaConfig = await this.prisma.slaConfig.findUnique({
        where: { organizationId_criticality: { organizationId: orgId, criticality: categoryConfig.criticality } },
      });

      if (slaConfig) {
        const [businessHours, holidayRows] = await Promise.all([
          this.prisma.businessHoursConfig.findUnique({ where: { organizationId: orgId } }),
          this.prisma.holiday.findMany({ where: { organizationId: orgId }, select: { date: true } }),
        ]);

        const bhConfig = businessHours
          ? { start: businessHours.businessHoursStart, end: businessHours.businessHoursEnd, days: parseBusinessDays(businessHours.businessDays), timezone: businessHours.timezone }
          : undefined;

        const holidays = holidayRows.map((h) => h.date);
        const now = new Date();
        responseDeadline = calculateBusinessDeadline(now, slaConfig.responseTimeMinutes, bhConfig, holidays);
        resolutionDeadline = calculateBusinessDeadline(now, slaConfig.resolutionTimeMinutes, bhConfig, holidays);
      }
    }

    const categoryLabel = dto.category === 'SUPPORT_REQUEST' ? 'Soporte' : 'Desarrollo';
    const channelName = `[${categoryLabel}] ${dto.title}`;
    const taskTitle = `[Ticket] ${dto.title}`;

    const memberIds = project.members.map((m) => m.userId);
    if (client.userId && !memberIds.includes(client.userId)) {
      memberIds.push(client.userId);
    }
    if (project.responsibleId && !memberIds.includes(project.responsibleId)) {
      memberIds.push(project.responsibleId);
    }
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

      // Find the BACKLOG column so the task appears in the kanban board
      const backlogColumn = await tx.boardColumn.findFirst({
        where: {
          mappedStatus: 'BACKLOG',
          board: { projectId: dto.projectId },
        },
        orderBy: { position: 'asc' },
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
          ...(backlogColumn && { boardColumnId: backlogColumn.id }),
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

      const ticketNumber = await generateTicketNumber(tx, orgId);

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
          createdByUserId,
          ticketNumber,
          ...(categoryConfig && { categoryConfigId: categoryConfig.id }),
          ...(criticality && { criticality: criticality as any }),
          ...(responseDeadline && { responseDeadline }),
          ...(resolutionDeadline && { resolutionDeadline }),
        },
        include: {
          project: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } },
          task: { select: { id: true, title: true, status: true } },
          channel: { select: { id: true, name: true } },
          categoryConfig: { select: { id: true, name: true, criticality: true } },
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

  // ── Category Configs ─────────────────────────────────────

  async getCategories(orgId: string) {
    return this.prisma.ticketCategoryConfig.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getActiveCategories(orgId: string) {
    return this.prisma.ticketCategoryConfig.findMany({
      where: { organizationId: orgId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(orgId: string, dto: CreateCategoryConfigDto) {
    return this.prisma.ticketCategoryConfig.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        description: dto.description,
        criticality: dto.criticality as any,
      },
    });
  }

  async updateCategory(orgId: string, categoryId: string, dto: UpdateCategoryConfigDto) {
    const existing = await this.prisma.ticketCategoryConfig.findFirst({
      where: { id: categoryId, organizationId: orgId },
    });
    if (!existing) {
      throw new AppException('Categoría no encontrada', 'CATEGORY_NOT_FOUND', 404);
    }

    return this.prisma.ticketCategoryConfig.update({
      where: { id: categoryId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.criticality !== undefined && { criticality: dto.criticality as any }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async deleteCategory(orgId: string, categoryId: string) {
    const existing = await this.prisma.ticketCategoryConfig.findFirst({
      where: { id: categoryId, organizationId: orgId },
    });
    if (!existing) {
      throw new AppException('Categoría no encontrada', 'CATEGORY_NOT_FOUND', 404);
    }

    // Soft-delete: deactivate instead of deleting to preserve ticket references
    return this.prisma.ticketCategoryConfig.update({
      where: { id: categoryId },
      data: { isActive: false },
    });
  }

  // ── SLA Config ───────────────────────────────────────────

  async getSlaConfigs(orgId: string) {
    return this.prisma.slaConfig.findMany({
      where: { organizationId: orgId },
      orderBy: { criticality: 'asc' },
    });
  }

  async upsertSlaConfigs(orgId: string, dto: UpsertSlaConfigDto) {
    const results = await this.prisma.$transaction(
      dto.configs.map((config) =>
        this.prisma.slaConfig.upsert({
          where: { organizationId_criticality: { organizationId: orgId, criticality: config.criticality as any } },
          create: {
            organizationId: orgId,
            criticality: config.criticality as any,
            responseTimeMinutes: config.responseTimeMinutes,
            resolutionTimeMinutes: config.resolutionTimeMinutes,
          },
          update: {
            responseTimeMinutes: config.responseTimeMinutes,
            resolutionTimeMinutes: config.resolutionTimeMinutes,
          },
        }),
      ),
    );
    return results;
  }

  // ── Business Hours ───────────────────────────────────────

  async getBusinessHours(orgId: string) {
    const config = await this.prisma.businessHoursConfig.findUnique({
      where: { organizationId: orgId },
    });

    return config || {
      businessHoursStart: '08:30',
      businessHoursEnd: '17:30',
      businessDays: '1,2,3,4,5',
      timezone: 'America/Asuncion',
    };
  }

  async upsertBusinessHours(orgId: string, dto: UpsertBusinessHoursDto) {
    return this.prisma.businessHoursConfig.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        businessHoursStart: dto.businessHoursStart,
        businessHoursEnd: dto.businessHoursEnd,
        businessDays: dto.businessDays,
        timezone: dto.timezone || 'America/Asuncion',
      },
      update: {
        businessHoursStart: dto.businessHoursStart,
        businessHoursEnd: dto.businessHoursEnd,
        businessDays: dto.businessDays,
        ...(dto.timezone && { timezone: dto.timezone }),
      },
    });
  }

  // ── Holidays ─────────────────────────────────

  async getHolidays(orgId: string) {
    return this.prisma.holiday.findMany({
      where: { organizationId: orgId },
      orderBy: { date: 'asc' },
    });
  }

  async createHoliday(orgId: string, dto: { name: string; date: string; recurring?: boolean }) {
    return this.prisma.holiday.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        date: new Date(dto.date),
        recurring: dto.recurring ?? false,
      },
    });
  }

  async deleteHoliday(orgId: string, holidayId: string) {
    const holiday = await this.prisma.holiday.findFirst({
      where: { id: holidayId, organizationId: orgId },
    });

    if (!holiday) {
      throw new AppException('El feriado no existe', 'HOLIDAY_NOT_FOUND', 404);
    }

    await this.prisma.holiday.delete({ where: { id: holidayId } });
  }
}
