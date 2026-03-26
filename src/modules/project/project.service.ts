import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateProjectDto, UpdateProjectDto, ProjectFilterDto } from './dto';
import {
  ProjectNotFoundException,
  OrganizationNotFoundException,
  DuplicateResourceException,
  AppException,
} from '../../common/filters/app-exception';
import { PaginatedResult } from '../../common/interfaces/request.interface';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(orgId: string, dto: CreateProjectDto, userId: string) {
    await this.validateOrganization(orgId);

    const slug = this.generateSlug(dto.name);

    // Check for duplicate slug within org
    const existing = await this.prisma.project.findUnique({
      where: {
        organizationId_slug: {
          organizationId: orgId,
          slug,
        },
      },
    });

    if (existing) {
      throw new DuplicateResourceException('proyecto', 'slug', slug);
    }

    const project = await this.prisma.$transaction(async (tx) => {
      const newProject = await tx.project.create({
        data: {
          organizationId: orgId,
          name: dto.name,
          description: dto.description,
          slug,
          status: dto.status || 'DEFINITION',
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          createdById: userId,
          clientId: dto.clientId || null,
          budget: dto.budget ?? null,
          investment: dto.investment ?? null,
          billingMonth: dto.billingMonth || null,
          responsibleId: dto.responsibleId || null,
        },
      });

      // Add the creator as a project member
      await tx.projectMember.create({
        data: {
          projectId: newProject.id,
          userId,
        },
      });

      return newProject;
    });

    this.logger.log(`Project created: ${project.id} in org: ${orgId} by user: ${userId}`);
    this.eventEmitter.emit('project.created', {
      ...domainEvent('project.created', 'project', project.id, orgId, userId, { name: project.name }),
      projectId: project.id,
      organizationId: orgId,
      userId,
    });

    return project;
  }

  async findAll(orgId: string, filters: ProjectFilterDto): Promise<PaginatedResult<any>> {
    await this.validateOrganization(orgId);

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.ProjectWhereInput = {
      organizationId: orgId,
    };

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    // Build order clause
    const orderBy = this.parseSort(filters.sort);

    const [data, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        include: {
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          client: {
            select: { id: true, name: true },
          },
          responsible: {
            select: { id: true, name: true },
          },
          _count: {
            select: {
              members: true,
              tasks: true,
              sprints: true,
            },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.project.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findById(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        _count: {
          select: {
            members: true,
            tasks: true,
            boards: true,
            sprints: true,
            invoices: true,
            suggestions: true,
          },
        },
        members: {
          include: { user: { select: { id: true, name: true, image: true } } },
          take: 5,
        },
        alcanceFile: {
          select: { id: true, originalName: true, mimeType: true, size: true, createdAt: true },
        },
      },
    });

    if (!project) {
      throw new ProjectNotFoundException(projectId);
    }

    // Get counts for badges
    const [pendingSuggestionsCount, pendingApprovalsCount, stats] = await Promise.all([
      this.prisma.suggestion.count({
        where: { projectId, status: { in: ['PENDING', 'REVIEWING'] } },
      }),
      this.prisma.task.count({
        where: { projectId, status: 'IN_REVIEW' },
      }),
      this.prisma.task.groupBy({
        by: ['status'],
        where: { projectId, status: { not: 'CANCELLED' } },
        _count: true,
      }),
    ]);

    const statsMap: Record<string, number> = {};
    for (const s of stats) {
      statsMap[s.status] = s._count;
    }

    return {
      ...project,
      pendingSuggestionsCount,
      pendingApprovalsCount,
      stats: {
        completed: statsMap['DONE'] || 0,
        inProgress: statsMap['IN_PROGRESS'] || 0,
        inReview: statsMap['IN_REVIEW'] || 0,
        todo: statsMap['TODO'] || 0,
        backlog: statsMap['BACKLOG'] || 0,
      },
    };
  }

  async update(projectId: string, dto: UpdateProjectDto) {
    await this.findById(projectId);

    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.status && { status: dto.status }),
        ...(dto.startDate !== undefined && {
          startDate: dto.startDate ? new Date(dto.startDate) : null,
        }),
        ...(dto.endDate !== undefined && {
          endDate: dto.endDate ? new Date(dto.endDate) : null,
        }),
        ...(dto.clientId !== undefined && { clientId: dto.clientId || null }),
        ...(dto.budget !== undefined && { budget: dto.budget }),
        ...(dto.investment !== undefined && { investment: dto.investment }),
        ...(dto.billingMonth !== undefined && { billingMonth: dto.billingMonth || null }),
        ...(dto.responsibleId !== undefined && { responsibleId: dto.responsibleId || null }),
        ...(dto.alcanceStatus !== undefined && { alcanceStatus: dto.alcanceStatus }),
        ...(dto.alcanceFileId !== undefined && { alcanceFileId: dto.alcanceFileId || null }),
      },
    });

    this.eventEmitter.emit('project.updated', {
      ...domainEvent('project.updated', 'project', project.id, project.organizationId),
      projectId: project.id,
    });

    // Emit alcance-specific events
    if (dto.alcanceStatus) {
      if (dto.alcanceStatus === 'PENDING_APPROVAL') {
        this.eventEmitter.emit('alcance.submitted', {
          ...domainEvent('alcance.submitted', 'project', project.id, project.organizationId, undefined, { alcanceStatus: dto.alcanceStatus }),
          projectId: project.id,
          project,
        });
      } else if (dto.alcanceStatus === 'APPROVED') {
        this.eventEmitter.emit('alcance.approved', {
          ...domainEvent('alcance.approved', 'project', project.id, project.organizationId, undefined, { alcanceStatus: dto.alcanceStatus }),
          projectId: project.id,
          project,
        });
      } else if (dto.alcanceStatus === 'REJECTED') {
        this.eventEmitter.emit('alcance.rejected', {
          ...domainEvent('alcance.rejected', 'project', project.id, project.organizationId, undefined, { alcanceStatus: dto.alcanceStatus }),
          projectId: project.id,
          project,
        });
      }
    }

    return project;
  }

  async softDelete(projectId: string, userId: string) {
    const project = await this.findById(projectId);

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        status: 'COMPLETED',
        slug: `deleted-${Date.now()}-${projectId}`,
      },
    });

    this.logger.log(`Project soft-deleted: ${projectId} by user: ${userId}`);
    this.eventEmitter.emit('project.deleted', {
      ...domainEvent('project.deleted', 'project', projectId, project.organizationId, userId, { name: project.name }),
      projectId,
      organizationId: project.organizationId,
      userId,
    });

    return updated;
  }

  async listMembers(projectId: string) {
    const project = await this.findById(projectId);

    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            organizationMembers: {
              where: { organizationId: project.organizationId },
              select: {
                role: { select: { id: true, name: true } },
              },
              take: 1,
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Flatten: move role to top level of user for easier frontend consumption
    return members.map((m) => ({
      ...m,
      user: {
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
        role: m.user.organizationMembers[0]?.role || null,
      },
    }));
  }

  async addMember(projectId: string, userId: string) {
    const project = await this.findById(projectId);

    const existing = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });

    if (existing) {
      throw new AppException(
        'El usuario ya es miembro de este proyecto',
        'ALREADY_PROJECT_MEMBER',
        409,
      );
    }

    const member = await this.prisma.projectMember.create({
      data: {
        projectId,
        userId,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    this.eventEmitter.emit('project.member.added', {
      ...domainEvent('project.member.added', 'project', projectId, project.organizationId, userId),
      projectId,
      userId,
    });

    return member;
  }

  async removeMember(projectId: string, memberId: string) {
    const project = await this.findById(projectId);

    const member = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId },
    });

    if (!member) {
      throw new AppException(
        'El miembro no existe en este proyecto',
        'PROJECT_MEMBER_NOT_FOUND',
        404,
        { memberId, projectId },
      );
    }

    await this.prisma.projectMember.delete({
      where: { id: memberId },
    });

    this.eventEmitter.emit('project.member.removed', {
      ...domainEvent('project.member.removed', 'project', projectId, project.organizationId, member.userId),
      projectId,
      userId: member.userId,
    });

    return { deleted: true };
  }

  async getStats(projectId: string) {
    const project = await this.findById(projectId);

    const [
      tasksByStatus,
      tasksByPriority,
      totalTimeEntries,
      membersCount,
      sprintsCount,
    ] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { projectId },
        _count: { status: true },
      }),
      this.prisma.task.groupBy({
        by: ['priority'],
        where: { projectId },
        _count: { priority: true },
      }),
      this.prisma.timeEntry.aggregate({
        where: { task: { projectId } },
        _sum: { duration: true },
        _count: true,
      }),
      this.prisma.projectMember.count({
        where: { projectId },
      }),
      this.prisma.sprint.count({
        where: { projectId },
      }),
    ]);

    return {
      projectId,
      projectName: project.name,
      status: project.status,
      members: membersCount,
      sprints: sprintsCount,
      tasks: {
        byStatus: tasksByStatus.map((t) => ({
          status: t.status,
          count: t._count.status,
        })),
        byPriority: tasksByPriority.map((t) => ({
          priority: t.priority,
          count: t._count.priority,
        })),
        total: tasksByStatus.reduce((sum, t) => sum + t._count.status, 0),
      },
      timeTracking: {
        totalMinutes: totalTimeEntries._sum.duration ?? 0,
        totalEntries: totalTimeEntries._count,
      },
    };
  }

  private parseSort(sort?: string): Prisma.ProjectOrderByWithRelationInput {
    if (!sort) return { createdAt: 'desc' };

    const isDesc = sort.startsWith('-');
    const field = isDesc ? sort.substring(1) : sort;
    const direction: Prisma.SortOrder = isDesc ? 'desc' : 'asc';

    const allowedFields = ['name', 'status', 'createdAt', 'updatedAt', 'startDate', 'endDate'];

    if (!allowedFields.includes(field)) {
      return { createdAt: 'desc' };
    }

    return { [field]: direction };
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // ============================================
  // BUDGET ITEMS (Presupuestador)
  // ============================================

  async getBudgetItems(projectId: string) {
    await this.findById(projectId);

    const items = await this.prisma.budgetItem.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
    });

    const total = items.reduce((sum, item) => sum + Number(item.amount), 0);

    return { items, total };
  }

  async createBudgetItem(projectId: string, dto: { description: string; category?: string; hours?: number; hourlyRate?: number }) {
    await this.findById(projectId);

    const hours = dto.hours ?? 0;
    const hourlyRate = dto.hourlyRate ?? 0;
    const amount = hours * hourlyRate;

    const maxOrder = await this.prisma.budgetItem.aggregate({
      where: { projectId },
      _max: { order: true },
    });

    const item = await this.prisma.budgetItem.create({
      data: {
        projectId,
        description: dto.description,
        category: dto.category,
        hours,
        hourlyRate,
        amount,
        order: (maxOrder._max.order ?? -1) + 1,
      },
    });

    return item;
  }

  async updateBudgetItem(projectId: string, itemId: string, dto: { description?: string; category?: string; hours?: number; hourlyRate?: number }) {
    const item = await this.prisma.budgetItem.findFirst({
      where: { id: itemId, projectId },
    });

    if (!item) {
      throw new AppException('El item de presupuesto no existe', 'BUDGET_ITEM_NOT_FOUND', 404, { itemId });
    }

    const hours = dto.hours !== undefined ? dto.hours : Number(item.hours);
    const hourlyRate = dto.hourlyRate !== undefined ? dto.hourlyRate : Number(item.hourlyRate);
    const amount = hours * hourlyRate;

    const updated = await this.prisma.budgetItem.update({
      where: { id: itemId },
      data: {
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.hours !== undefined && { hours: dto.hours }),
        ...(dto.hourlyRate !== undefined && { hourlyRate: dto.hourlyRate }),
        amount,
      },
    });

    return updated;
  }

  async deleteBudgetItem(projectId: string, itemId: string) {
    const item = await this.prisma.budgetItem.findFirst({
      where: { id: itemId, projectId },
    });

    if (!item) {
      throw new AppException('El item de presupuesto no existe', 'BUDGET_ITEM_NOT_FOUND', 404, { itemId });
    }

    await this.prisma.budgetItem.delete({ where: { id: itemId } });
  }

  async reorderBudgetItems(projectId: string, itemIds: string[]) {
    await this.findById(projectId);

    await this.prisma.$transaction(
      itemIds.map((id, index) =>
        this.prisma.budgetItem.update({
          where: { id },
          data: { order: index },
        }),
      ),
    );

    return { reordered: true };
  }

  // ============================================
  // ALCANCE (Organization-level financial view)
  // ============================================

  async getAlcance(orgId: string, filters?: { clientId?: string; status?: string; billingMonth?: string }) {
    await this.validateOrganization(orgId);

    const where: Prisma.ProjectWhereInput = {
      organizationId: orgId,
      status: { not: 'COMPLETED' },
    };

    if (filters?.clientId) where.clientId = filters.clientId;
    if (filters?.status) where.status = filters.status as any;
    if (filters?.billingMonth) where.billingMonth = filters.billingMonth;

    const projects = await this.prisma.project.findMany({
      where,
      include: {
        client: { select: { id: true, name: true } },
        responsible: { select: { id: true, name: true } },
        invoices: {
          where: { status: 'PAID' },
          select: { total: true },
        },
        budgetItems: {
          select: {
            id: true,
            description: true,
            hours: true,
            hourlyRate: true,
            amount: true,
            order: true,
          },
          orderBy: { order: 'asc' },
        },
        _count: { select: { tasks: true } },
        tasks: {
          select: {
            id: true,
            title: true,
            status: true,
            assignments: {
              select: { user: { select: { id: true, name: true } } },
              take: 1,
            },
          },
          take: 20,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = projects.map((p) => {
      const invoiced = p.invoices.reduce((sum, inv) => sum + Number(inv.total), 0);
      const budgetTotal = p.budgetItems.reduce((sum, bi) => sum + Number(bi.amount), 0);

      return {
        id: p.id,
        name: p.name,
        status: p.status,
        startDate: p.startDate,
        endDate: p.endDate,
        billingMonth: p.billingMonth,
        client: p.client,
        responsible: p.responsible,
        budget: Number(p.budget ?? 0),
        investment: Number(p.investment ?? 0),
        invoiced,
        budgetTotal,
        budgetItems: p.budgetItems.map((bi) => ({
          id: bi.id,
          description: bi.description,
          hours: Number(bi.hours),
          hourlyRate: Number(bi.hourlyRate),
          amount: Number(bi.amount),
          order: bi.order,
        })),
        tasks: p.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          assignee: t.assignments[0]?.user || null,
        })),
        taskCount: p._count.tasks,
      };
    });

    const totals = {
      budget: data.reduce((s, d) => s + d.budget, 0),
      investment: data.reduce((s, d) => s + d.investment, 0),
      invoiced: data.reduce((s, d) => s + d.invoiced, 0),
    };

    return { data, totals };
  }

  private async validateOrganization(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });

    if (!org) {
      throw new OrganizationNotFoundException(orgId);
    }

    return org;
  }
}
