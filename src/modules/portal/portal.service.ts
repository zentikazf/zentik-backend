import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { CreateSuggestionDto } from './dto/create-suggestion.dto';
import { UpdateSuggestionDto } from './dto/update-suggestion.dto';
import { domainEvent } from '../../common/events/domain-event.helper';
import { CreateTicketDto } from '../ticket/dto/create-ticket.dto';
import { AuditService } from '../audit/audit.service';
import { calculateBusinessDeadline, parseBusinessDays } from '../ticket/sla.util';
import { generateTicketNumber } from '../ticket/ticket.service';

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly auditService: AuditService,
  ) {}

  private async getClientByUserId(userId: string) {
    // Check if owner
    const clientAsOwner = await this.prisma.client.findFirst({
      where: { userId },
    });
    if (clientAsOwner) return clientAsOwner;

    // Check if sub-user
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { clientId: true },
    });
    if (user?.clientId) {
      const client = await this.prisma.client.findUnique({
        where: { id: user.clientId },
      });
      if (client) return client;
    }

    throw new AppException('No se encontró un perfil de cliente', 'CLIENT_NOT_FOUND', 403);
  }

  async getProjects(userId: string) {
    const client = await this.getClientByUserId(userId);

    const projects = await this.prisma.project.findMany({
      where: { clientId: client.id, lifecycleStatus: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        status: true,
        startDate: true,
        endDate: true,
        createdAt: true,
        _count: {
          select: {
            suggestions: true,
          },
        },
        tasks: {
          where: { clientVisible: true },
          select: { status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return projects.map((p) => {
      const visibleTasks = p.tasks.length;
      const completedTasks = p.tasks.filter((t) => t.status === 'DONE').length;
      const progress = visibleTasks > 0 ? Math.round((completedTasks / visibleTasks) * 100) : 0;

      return {
        id: p.id,
        name: p.name,
        status: p.status,
        startDate: p.startDate,
        endDate: p.endDate,
        createdAt: p.createdAt,
        suggestionsCount: p._count.suggestions,
        visibleTasks,
        completedTasks,
        progress,
      };
    });
  }

  async getProjectDetail(userId: string, projectId: string) {
    const client = await this.getClientByUserId(userId);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        startDate: true,
        endDate: true,
        alcanceStatus: true,
        alcanceFileId: true,
        alcanceFile: {
          select: {
            id: true,
            originalName: true,
            mimeType: true,
            size: true,
            createdAt: true,
          },
        },
        sprints: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            name: true,
            status: true,
            startDate: true,
            endDate: true,
          },
          orderBy: { startDate: 'asc' },
        },
      },
    });

    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    const tasks = await this.prisma.task.findMany({
      where: { projectId, clientVisible: true },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        dueDate: true,
        updatedAt: true,
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    const totalVisible = tasks.length;
    const completedTasks = tasks.filter((t) => t.status === 'DONE').length;
    const progress = totalVisible > 0 ? Math.round((completedTasks / totalVisible) * 100) : 0;

    return {
      ...project,
      tasks,
      totalVisible,
      completedTasks,
      progress,
    };
  }

  async getGlobalSuggestions(userId: string) {
    const client = await this.getClientByUserId(userId);

    return this.prisma.suggestion.findMany({
      where: { clientId: client.id },
      include: { 
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true, status: true } }
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSuggestions(userId: string, projectId: string) {
    const client = await this.getClientByUserId(userId);

    // Validate project belongs to client
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    return this.prisma.suggestion.findMany({
      where: { projectId, clientId: client.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSuggestion(userId: string, projectId: string, dto: CreateSuggestionDto) {
    const client = await this.getClientByUserId(userId);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    const suggestion = await this.prisma.suggestion.create({
      data: {
        projectId,
        clientId: client.id,
        title: dto.title,
        description: dto.description,
        priority: dto.priority,
      },
    });

    this.logger.log(`Suggestion created: ${suggestion.id} by client: ${client.id}`);

    this.eventEmitter.emit('suggestion.created', {
      ...domainEvent('suggestion.created', 'suggestion', suggestion.id, project.organizationId, userId),
      suggestionId: suggestion.id,
      title: suggestion.title,
      projectId,
      clientName: client.name,
    });

    return suggestion;
  }

  // ── Project Request (Portal) ────────────────────────────

  async requestProject(userId: string, dto: { name: string; description?: string }) {
    const client = await this.getClientByUserId(userId);

    if (!client.organizationId) {
      throw new AppException('El cliente no tiene organización asociada', 'CLIENT_NO_ORG', 400);
    }

    const slug = dto.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const project = await this.prisma.project.create({
      data: {
        organizationId: client.organizationId,
        name: dto.name,
        description: dto.description || null,
        slug: `${slug}-${Date.now()}`,
        status: 'DISCOVERY',
        clientId: client.id,
        pendingClientReview: true,
        createdById: userId,
      },
    });

    this.logger.log(`Project requested by client ${client.id}: ${project.id}`);

    this.eventEmitter.emit('project.requested', {
      ...domainEvent('project.requested', 'project', project.id, client.organizationId, userId, { name: dto.name }),
      projectId: project.id,
      clientName: client.name,
    });

    return project;
  }

  // ── Admin methods ──────────────────────────────────────

  async getProjectSuggestions(projectId: string) {
    return this.prisma.suggestion.findMany({
      where: { projectId },
      include: {
        client: { select: { id: true, name: true, email: true } },
        task: { select: { id: true, title: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateSuggestion(projectId: string, suggestionId: string, dto: UpdateSuggestionDto) {
    const suggestion = await this.prisma.suggestion.findFirst({
      where: { id: suggestionId, projectId },
    });
    if (!suggestion) {
      throw new AppException('Sugerencia no encontrada', 'SUGGESTION_NOT_FOUND', 404);
    }

    return this.prisma.suggestion.update({
      where: { id: suggestionId },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.adminNotes !== undefined && { adminNotes: dto.adminNotes }),
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
      },
    });
  }

  // ── Ticket methods (Portal) ────────────────────────────

  async getTickets(
    userId: string,
    filters?: { projectId?: string; createdByUserId?: string },
  ) {
    const client = await this.getClientByUserId(userId);

    return this.prisma.ticket.findMany({
      where: {
        clientId: client.id,
        ...(filters?.projectId && { projectId: filters.projectId }),
        ...(filters?.createdByUserId && { createdByUserId: filters.createdByUserId }),
      },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, status: true } },
        createdByUser: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTicketDetail(userId: string, ticketId: string) {
    const client = await this.getClientByUserId(userId);

    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, clientId: client.id },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true, status: true } },
        channel: { select: { id: true, name: true } },
        createdByUser: { select: { id: true, name: true } },
      },
    });

    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    return ticket;
  }

  async createTicket(userId: string, projectId: string, dto: CreateTicketDto) {
    const client = await this.getClientByUserId(userId);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
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
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    // Resolve dynamic category → categoryConfigId + SLA
    let categoryConfigId: string | undefined;
    let criticality: string | undefined;
    let responseDeadline: Date | undefined;
    let resolutionDeadline: Date | undefined;
    const rawCategory = dto.category;

    if (rawCategory.startsWith('dynamic:')) {
      const configId = rawCategory.slice('dynamic:'.length);
      const categoryConfig = await this.prisma.ticketCategoryConfig.findFirst({
        where: { id: configId, organizationId: project.organizationId, isActive: true },
      });
      if (categoryConfig) {
        categoryConfigId = categoryConfig.id;
        criticality = categoryConfig.criticality;

        const slaConfig = await this.prisma.slaConfig.findUnique({
          where: { organizationId_criticality: { organizationId: project.organizationId, criticality: categoryConfig.criticality } },
        });
        if (slaConfig) {
          const [bhConfig, holidayRows] = await Promise.all([
            this.prisma.businessHoursConfig.findUnique({ where: { organizationId: project.organizationId } }),
            this.prisma.holiday.findMany({ where: { organizationId: project.organizationId }, select: { date: true } }),
          ]);
          const bh = bhConfig ? {
            start: bhConfig.businessHoursStart,
            end: bhConfig.businessHoursEnd,
            days: parseBusinessDays(bhConfig.businessDays),
            timezone: bhConfig.timezone,
          } : undefined;
          const holidays = holidayRows.map((h) => h.date);
          const now = new Date();
          responseDeadline = calculateBusinessDeadline(now, slaConfig.responseTimeMinutes, bh, holidays);
          resolutionDeadline = calculateBusinessDeadline(now, slaConfig.resolutionTimeMinutes, bh, holidays);
        }
      }
    }

    const categoryLabel = rawCategory === 'SUPPORT_REQUEST' || rawCategory.startsWith('dynamic:') ? 'Soporte' : 'Desarrollo';
    const channelName = `[${categoryLabel}] ${dto.title}`;
    const taskTitle = `[Ticket] ${dto.title}`;

    // Collect all org member user IDs for the channel
    const orgMemberIds = project.members.map((m) => m.userId);
    // Add client user if not already present
    if (userId && !orgMemberIds.includes(userId)) {
      orgMemberIds.push(userId);
    }
    // Add project responsible if exists
    if (project.responsibleId && !orgMemberIds.includes(project.responsibleId)) {
      orgMemberIds.push(project.responsibleId);
    }
    // Add Product Owners and Project Managers from the organization
    const poAndPm = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: project.organizationId,
        role: { name: { in: ['Product Owner', 'Project Manager'] } },
      },
      select: { userId: true },
    });
    for (const member of poAndPm) {
      if (!orgMemberIds.includes(member.userId)) {
        orgMemberIds.push(member.userId);
      }
    }

    const ticket = await this.prisma.$transaction(async (tx) => {
      // 1. Create the task in the project kanban
      const maxPosition = await tx.task.aggregate({
        where: { projectId },
        _max: { position: true },
      });

      // Find the TODO column so the task appears in the kanban board
      const todoColumn = await tx.boardColumn.findFirst({
        where: {
          mappedStatus: 'TODO',
          board: { projectId },
        },
        orderBy: { position: 'asc' },
      });

      const task = await tx.task.create({
        data: {
          projectId,
          title: taskTitle,
          description: dto.description,
          priority: (dto.priority as any) ?? 'MEDIUM',
          status: 'TODO',
          type: 'SUPPORT',
          position: (maxPosition._max.position ?? -1) + 1,
          createdById: project.createdById,
          clientVisible: true,
          ...(todoColumn && { boardColumnId: todoColumn.id }),
        },
      });

      // 2. Create the TICKET channel with all members
      const channel = await tx.channel.create({
        data: {
          name: channelName,
          type: 'TICKET',
          organizationId: project.organizationId,
          createdById: project.createdById,
          members: {
            create: orgMemberIds.map((id) => ({ userId: id })),
          },
        },
      });

      // 3. Create the ticket linking task and channel
      const ticketNumber = await generateTicketNumber(tx, project.organizationId);

      const created = await tx.ticket.create({
        data: {
          organizationId: project.organizationId,
          projectId,
          clientId: client.id,
          title: dto.title,
          description: dto.description,
          category: 'SUPPORT_REQUEST' as any,
          priority: (dto.priority as any) ?? 'MEDIUM',
          taskId: task.id,
          channelId: channel.id,
          createdByUserId: userId,
          ticketNumber,
          ...(categoryConfigId && { categoryConfigId }),
          ...(criticality && { criticality: criticality as any }),
          ...(responseDeadline && { responseDeadline }),
          ...(resolutionDeadline && { resolutionDeadline }),
        },
        include: {
          project: { select: { id: true, name: true } },
          task: { select: { id: true, title: true, status: true } },
          channel: { select: { id: true, name: true } },
        },
      });

      return created;
    });

    this.logger.log(`Ticket created: ${ticket.id} by client: ${client.id} for project: ${projectId}`);

    await this.auditService.create({
      organizationId: project.organizationId,
      userId,
      action: 'ticket.created',
      resource: 'ticket',
      resourceId: ticket.id,
      newData: { title: dto.title, category: dto.category, projectId, clientName: client.name },
    });

    this.eventEmitter.emit('ticket.created', {
      ...domainEvent('ticket.created', 'ticket', ticket.id, project.organizationId, userId),
      ticketId: ticket.id,
      title: dto.title,
      category: dto.category,
      projectId,
      clientName: client.name,
    });

    return ticket;
  }

  async getMyHours(userId: string) {
    const client = await this.getClientByUserId(userId);
    const available = Math.max(client.contractedHours - client.usedHours - client.loanedHours, 0);

    const recentTransactions = await this.prisma.hoursTransaction.findMany({
      where: { clientId: client.id },
      include: {
        task: {
          select: {
            id: true,
            title: true,
            project: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      contractedHours: client.contractedHours,
      usedHours: client.usedHours,
      loanedHours: client.loanedHours,
      availableHours: available,
      percentUsed: client.contractedHours > 0
        ? parseFloat(((client.usedHours / client.contractedHours) * 100).toFixed(1))
        : 0,
      transactions: recentTransactions,
    };
  }

  async convertToTask(projectId: string, suggestionId: string) {
    const suggestion = await this.prisma.suggestion.findFirst({
      where: { id: suggestionId, projectId },
    });
    if (!suggestion) {
      throw new AppException('Sugerencia no encontrada', 'SUGGESTION_NOT_FOUND', 404);
    }

    if (suggestion.taskId) {
      throw new AppException('Esta sugerencia ya fue convertida en tarea', 'ALREADY_CONVERTED', 400);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Get a creator user (first org member that isn't a client)
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { organizationId: true, createdById: true },
      });

      const task = await tx.task.create({
        data: {
          projectId,
          title: suggestion.title,
          description: suggestion.description,
          priority: suggestion.priority === 'HIGH' ? 'HIGH' : suggestion.priority === 'LOW' ? 'LOW' : 'MEDIUM',
          status: 'TODO',
          createdById: project!.createdById,
          clientVisible: true,
        },
      });

      const updated = await tx.suggestion.update({
        where: { id: suggestionId },
        data: { status: 'IMPLEMENTED', taskId: task.id },
        include: {
          client: { select: { id: true, name: true } },
          task: { select: { id: true, title: true, status: true } },
        },
      });

      return updated;
    });

    this.logger.log(`Suggestion ${suggestionId} converted to task ${result.taskId}`);
    return result;
  }

  // ── Ticket Categories (Portal) ─────────────────────────

  async getActiveTicketCategories(userId: string) {
    const client = await this.getClientByUserId(userId);

    return this.prisma.ticketCategoryConfig.findMany({
      where: { organizationId: client.organizationId, isActive: true },
      select: { id: true, name: true, description: true },
      orderBy: { name: 'asc' },
    });
  }

  async getBusinessHours(userId: string) {
    const client = await this.getClientByUserId(userId);

    const config = await this.prisma.businessHoursConfig.findUnique({
      where: { organizationId: client.organizationId },
    });

    if (!config) return null;

    const dayNames: Record<string, string> = {
      '1': 'Lunes', '2': 'Martes', '3': 'Miércoles',
      '4': 'Jueves', '5': 'Viernes', '6': 'Sábado', '0': 'Domingo',
    };
    const days = config.businessDays.split(',').map((d) => dayNames[d.trim()] || d.trim());

    return {
      start: config.businessHoursStart,
      end: config.businessHoursEnd,
      days,
      timezone: config.timezone,
    };
  }
}
