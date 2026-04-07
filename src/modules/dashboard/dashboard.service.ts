import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { DashboardFilterDto } from './dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getManagerialDashboard(orgId: string, filters: DashboardFilterDto) {
    const { startDate, endDate, clientId, memberId } = filters;

    const dateRange = this.buildDateRange(startDate, endDate);

    const [
      activeProjects,
      pendingTasks,
      completedTasks,
      teamMembers,
      hours,
    ] = await Promise.all([
      this.getActiveProjects(orgId, clientId, memberId),
      this.getPendingTasks(orgId, dateRange, clientId, memberId),
      this.getCompletedTasks(orgId, dateRange, clientId, memberId),
      this.getTeamMembers(orgId, dateRange, clientId),
      this.getHours(orgId, dateRange, clientId, memberId),
    ]);

    return {
      activeProjects,
      pendingTasks,
      completedTasks,
      teamMembers,
      hours,
      period: { startDate: dateRange.start, endDate: dateRange.end },
    };
  }

  private buildDateRange(startDate?: string, endDate?: string) {
    const now = new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endDate ? new Date(endDate) : now;
    return { start, end };
  }

  private async getActiveProjects(orgId: string, clientId?: string, memberId?: string) {
    const where: Prisma.ProjectWhereInput = {
      organizationId: orgId,
      lifecycleStatus: 'ACTIVE',
    };
    if (clientId) where.clientId = clientId;
    if (memberId) where.members = { some: { userId: memberId } };

    const projects = await this.prisma.project.findMany({
      where,
      select: {
        id: true,
        name: true,
        status: true,
        client: { select: { id: true, name: true } },
        _count: { select: { tasks: true, members: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      count: projects.length,
      items: projects,
    };
  }

  private async getPendingTasks(
    orgId: string,
    dateRange: { start: Date; end: Date },
    clientId?: string,
    memberId?: string,
  ) {
    const where: Prisma.TaskWhereInput = {
      project: {
        organizationId: orgId,
        lifecycleStatus: 'ACTIVE',
        ...(clientId && { clientId }),
      },
      status: { in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] },
      createdAt: { gte: dateRange.start, lte: dateRange.end },
    };
    if (memberId) where.assignments = { some: { userId: memberId } };

    const tasks = await this.prisma.task.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        project: { select: { id: true, name: true, slug: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
          take: 3,
        },
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      take: 100,
    });

    return { count: tasks.length, items: tasks };
  }

  private async getCompletedTasks(
    orgId: string,
    dateRange: { start: Date; end: Date },
    clientId?: string,
    memberId?: string,
  ) {
    const where: Prisma.TaskWhereInput = {
      project: {
        organizationId: orgId,
        lifecycleStatus: 'ACTIVE',
        ...(clientId && { clientId }),
      },
      status: 'DONE',
      updatedAt: { gte: dateRange.start, lte: dateRange.end },
    };
    if (memberId) where.assignments = { some: { userId: memberId } };

    const tasks = await this.prisma.task.findMany({
      where,
      select: {
        id: true,
        title: true,
        priority: true,
        updatedAt: true,
        project: { select: { id: true, name: true, slug: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
          take: 3,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    return { count: tasks.length, items: tasks };
  }

  private async getTeamMembers(
    orgId: string,
    dateRange: { start: Date; end: Date },
    clientId?: string,
  ) {
    const projectFilter: Prisma.ProjectWhereInput = {
      organizationId: orgId,
      lifecycleStatus: 'ACTIVE',
      ...(clientId && { clientId }),
    };

    const [members, activeTaskCounts, completedTaskCounts] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { organizationId: orgId },
        select: {
          user: { select: { id: true, name: true, email: true, image: true } },
          role: { select: { id: true, name: true } },
        },
      }),
      this.prisma.taskAssignment.groupBy({
        by: ['userId'],
        where: {
          task: { ...projectFilter ? { project: projectFilter } : {},
            status: { in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] },
          },
        },
        _count: true,
      }),
      this.prisma.taskAssignment.groupBy({
        by: ['userId'],
        where: {
          task: { ...projectFilter ? { project: projectFilter } : {},
            status: 'DONE',
            updatedAt: { gte: dateRange.start, lte: dateRange.end },
          },
        },
        _count: true,
      }),
    ]);

    const activeMap = new Map(activeTaskCounts.map((r) => [r.userId, r._count]));
    const completedMap = new Map(completedTaskCounts.map((r) => [r.userId, r._count]));

    const memberStats = members.map((m) => ({
      ...m.user,
      role: m.role?.name || null,
      activeTasks: activeMap.get(m.user.id) || 0,
      completedTasks: completedMap.get(m.user.id) || 0,
    }));

    return {
      count: memberStats.length,
      items: memberStats,
    };
  }

  private async getHours(
    orgId: string,
    dateRange: { start: Date; end: Date },
    clientId?: string,
    memberId?: string,
  ) {
    const taskFilter: Prisma.TaskWhereInput = {
      project: {
        organizationId: orgId,
        lifecycleStatus: 'ACTIVE',
        ...(clientId && { clientId }),
      },
    };
    if (memberId) taskFilter.assignments = { some: { userId: memberId } };

    const timeEntries = await this.prisma.timeEntry.findMany({
      where: {
        task: taskFilter,
        startTime: { gte: dateRange.start, lte: dateRange.end },
      },
      include: {
        task: {
          select: {
            project: {
              select: {
                id: true,
                name: true,
                client: { select: { id: true, name: true } },
                estimatedHours: true,
              },
            },
          },
        },
      },
    });

    let totalMinutes = 0;
    let billableMinutes = 0;
    const byClient = new Map<string, { clientId: string; clientName: string; totalMinutes: number; projectCount: Set<string> }>();

    for (const entry of timeEntries) {
      const mins = entry.duration || 0;
      totalMinutes += mins;
      if (entry.billable) billableMinutes += mins;

      const clientKey = entry.task.project.client?.id || '__no_client__';
      const clientName = entry.task.project.client?.name || 'Sin cliente';

      if (!byClient.has(clientKey)) {
        byClient.set(clientKey, {
          clientId: clientKey,
          clientName,
          totalMinutes: 0,
          projectCount: new Set(),
        });
      }
      const c = byClient.get(clientKey)!;
      c.totalMinutes += mins;
      c.projectCount.add(entry.task.project.id);
    }

    return {
      totalMinutes,
      totalHours: Math.round((totalMinutes / 60) * 100) / 100,
      billableMinutes,
      billableHours: Math.round((billableMinutes / 60) * 100) / 100,
      byClient: Array.from(byClient.values()).map((c) => ({
        clientId: c.clientId,
        clientName: c.clientName,
        totalMinutes: c.totalMinutes,
        totalHours: Math.round((c.totalMinutes / 60) * 100) / 100,
        projectCount: c.projectCount.size,
      })),
    };
  }
}
