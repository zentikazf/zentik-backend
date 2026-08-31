import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '@prisma/client';

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

@Injectable()
export class MetricsAggregator {
  constructor(private readonly prisma: PrismaService) {}

  async getTaskCompletionRate(projectId: string, range: DateRange) {
    const result = await this.prisma.$queryRaw<
      { total: bigint; completed: bigint }[]
    >`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE status = 'DONE')::bigint AS completed
      FROM tasks
      WHERE project_id = ${projectId}
        AND created_at >= ${range.startDate}
        AND created_at <= ${range.endDate}
    `;

    const row = result[0];
    const total = Number(row?.total || 0);
    const completed = Number(row?.completed || 0);
    return {
      total,
      completed,
      rate: total > 0 ? parseFloat(((completed / total) * 100).toFixed(2)) : 0,
    };
  }

  async getTimeDistribution(projectId: string, range: DateRange) {
    return this.prisma.$queryRaw<
      { user_id: string; user_name: string; task_title: string; total_minutes: bigint }[]
    >`
      SELECT
        te.user_id,
        u.name AS user_name,
        t.title AS task_title,
        COALESCE(SUM(te.duration), 0)::bigint AS total_minutes
      FROM time_entries te
      JOIN tasks t ON te.task_id = t.id
      JOIN users u ON te.user_id = u.id
      WHERE t.project_id = ${projectId}
        AND te.start_time >= ${range.startDate}
        AND te.start_time <= ${range.endDate}
      GROUP BY te.user_id, u.name, t.title
      ORDER BY total_minutes DESC
    `;
  }
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsAggregator,
  ) {}

  async getOverview(orgId: string, startDate?: string, endDate?: string) {
    const range = this.buildDateRange(startDate, endDate);

    const [
      projectCount,
      activeProjects,
      totalMembers,
      tasksByStatus,
      recentActivity,
    ] = await Promise.all([
      this.prisma.project.count({ where: { organizationId: orgId } }),
      this.prisma.project.count({
        where: { organizationId: orgId, status: { in: ['DISCOVERY', 'PLANNING', 'DEVELOPMENT', 'TESTING', 'DEPLOY', 'SUPPORT'] } },
      }),
      this.prisma.organizationMember.count({
        where: { organizationId: orgId },
      }),
      this.prisma.$queryRaw<{ status: string; count: bigint }[]>`
        SELECT t.status, COUNT(*)::bigint AS count
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        WHERE p.organization_id = ${orgId}
          AND t.created_at >= ${range.startDate}
          AND t.created_at <= ${range.endDate}
        GROUP BY t.status
      `,
      this.prisma.auditLog.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: range.startDate, lte: range.endDate },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { user: { select: { id: true, name: true } } },
      }),
    ]);

    return {
      summary: {
        totalProjects: projectCount,
        activeProjects,
        totalMembers,
      },
      tasksByStatus: tasksByStatus.map((r) => ({
        status: r.status,
        count: Number(r.count),
      })),
      recentActivity,
      period: range,
    };
  }

  async getProductivity(orgId: string, startDate?: string, endDate?: string) {
    const range = this.buildDateRange(startDate, endDate);

    const productivity = await this.prisma.$queryRaw<
      {
        user_id: string;
        user_name: string;
        tasks_completed: bigint;
        total_hours: number;
        avg_completion_days: number;
      }[]
    >`
      SELECT
        u.id AS user_id,
        u.name AS user_name,
        COUNT(t.id) FILTER (WHERE t.status = 'DONE')::bigint AS tasks_completed,
        COALESCE(SUM(te.duration) / 60.0, 0) AS total_hours,
        COALESCE(AVG(
          EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) / 86400
        ) FILTER (WHERE t.status = 'DONE'), 0) AS avg_completion_days
      FROM users u
      JOIN organization_members om ON u.id = om.user_id
      LEFT JOIN task_assignments ta ON u.id = ta.user_id
      LEFT JOIN tasks t ON ta.task_id = t.id
        AND t.updated_at >= ${range.startDate}
        AND t.updated_at <= ${range.endDate}
      LEFT JOIN time_entries te ON t.id = te.task_id AND te.user_id = u.id
        AND te.start_time >= ${range.startDate}
        AND te.start_time <= ${range.endDate}
      WHERE om.organization_id = ${orgId}
      GROUP BY u.id, u.name
      ORDER BY tasks_completed DESC
    `;

    return {
      members: productivity.map((row) => ({
        userId: row.user_id,
        userName: row.user_name,
        tasksCompleted: Number(row.tasks_completed),
        totalHours: parseFloat(Number(row.total_hours).toFixed(2)),
        avgCompletionDays: parseFloat(Number(row.avg_completion_days).toFixed(1)),
      })),
      period: range,
    };
  }

  async getProfitability(orgId: string, startDate?: string, endDate?: string) {
    const range = this.buildDateRange(startDate, endDate);

    const profitability = await this.prisma.$queryRaw<
      {
        project_id: string;
        project_name: string;
        total_hours: number;
      }[]
    >`
      SELECT
        p.id AS project_id,
        p.name AS project_name,
        COALESCE(SUM(te.duration) / 60.0, 0) AS total_hours
      FROM projects p
      LEFT JOIN tasks t ON p.id = t.project_id
      LEFT JOIN time_entries te ON t.id = te.task_id
        AND te.start_time >= ${range.startDate}
        AND te.start_time <= ${range.endDate}
      WHERE p.organization_id = ${orgId}
      GROUP BY p.id, p.name
      ORDER BY total_hours DESC
    `;

    return {
      projects: profitability.map((row) => ({
        projectId: row.project_id,
        projectName: row.project_name,
        totalHours: parseFloat(Number(row.total_hours).toFixed(2)),
      })),
      period: range,
    };
  }

  async getBurndown(projectId: string, startDate?: string, endDate?: string) {
    const range = this.buildDateRange(startDate, endDate);

    const burndown = await this.prisma.$queryRaw<
      { date: Date; remaining: bigint; completed: bigint }[]
    >`
      SELECT
        d.date::date AS date,
        (
          SELECT COUNT(*)::bigint FROM tasks
          WHERE project_id = ${projectId}
            AND status != 'DONE'
            AND status != 'CANCELLED'
            AND created_at <= d.date
        ) AS remaining,
        (
          SELECT COUNT(*)::bigint FROM tasks
          WHERE project_id = ${projectId}
            AND status = 'DONE'
            AND updated_at <= d.date
        ) AS completed
      FROM generate_series(
        ${range.startDate}::date,
        ${range.endDate}::date,
        '1 day'::interval
      ) AS d(date)
      ORDER BY d.date
    `;

    return {
      chartData: burndown.map((row) => ({
        date: row.date,
        remaining: Number(row.remaining),
        completed: Number(row.completed),
      })),
      period: range,
    };
  }

  async getVelocity(projectId: string, startDate?: string, endDate?: string) {
    const range = this.buildDateRange(startDate, endDate);

    const velocity = await this.prisma.$queryRaw<
      {
        sprint_id: string;
        sprint_name: string;
        planned_points: bigint;
        completed_points: bigint;
        tasks_planned: bigint;
        tasks_completed: bigint;
      }[]
    >`
      SELECT
        s.id AS sprint_id,
        s.name AS sprint_name,
        COALESCE(SUM(t.story_points), 0)::bigint AS planned_points,
        COALESCE(SUM(t.story_points) FILTER (WHERE t.status = 'DONE'), 0)::bigint AS completed_points,
        COUNT(t.id)::bigint AS tasks_planned,
        COUNT(t.id) FILTER (WHERE t.status = 'DONE')::bigint AS tasks_completed
      FROM sprints s
      LEFT JOIN tasks t ON s.id = t.sprint_id
      WHERE s.project_id = ${projectId}
        AND s.start_date >= ${range.startDate}
        AND s.end_date <= ${range.endDate}
      GROUP BY s.id, s.name, s.start_date
      ORDER BY s.start_date ASC
    `;

    return {
      sprints: velocity.map((row) => ({
        sprintId: row.sprint_id,
        sprintName: row.sprint_name,
        plannedPoints: Number(row.planned_points),
        completedPoints: Number(row.completed_points),
        tasksPlanned: Number(row.tasks_planned),
        tasksCompleted: Number(row.tasks_completed),
      })),
      period: range,
    };
  }

  async getTimeDistribution(projectId: string, startDate?: string, endDate?: string) {
    const range = this.buildDateRange(startDate, endDate);
    const distribution = await this.metrics.getTimeDistribution(projectId, range);

    return {
      entries: distribution.map((row) => ({
        userId: row.user_id,
        userName: row.user_name,
        taskTitle: row.task_title,
        totalMinutes: Number(row.total_minutes),
        totalHours: parseFloat((Number(row.total_minutes) / 60).toFixed(2)),
      })),
      period: range,
    };
  }

  async getPersonalSummary(userId: string, startDate?: string, endDate?: string) {
    const range = this.buildDateRange(startDate, endDate);

    const [tasksCompleted, totalTimeMinutes, activeTasks, upcomingDue] = await Promise.all([
      this.prisma.task.count({
        where: {
          assignments: { some: { userId } },
          status: 'DONE',
          updatedAt: { gte: range.startDate, lte: range.endDate },
        },
      }),
      this.prisma.timeEntry.aggregate({
        where: {
          userId,
          startTime: { gte: range.startDate },
          endTime: { lte: range.endDate },
        },
        _sum: { duration: true },
      }),
      this.prisma.task.count({
        where: {
          assignments: { some: { userId } },
          status: { in: ['IN_PROGRESS', 'IN_REVIEW'] },
        },
      }),
      this.prisma.task.findMany({
        where: {
          assignments: { some: { userId } },
          status: { notIn: ['DONE', 'CANCELLED'] },
          dueDate: {
            gte: new Date(),
            lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        },
        select: { id: true, title: true, dueDate: true, priority: true, status: true },
        orderBy: { dueDate: 'asc' },
        take: 10,
      }),
    ]);

    const totalMinutes = totalTimeMinutes._sum.duration || 0;

    return {
      tasksCompleted,
      activeTasks,
      totalHours: parseFloat((totalMinutes / 60).toFixed(2)),
      upcomingDue,
      period: range,
    };
  }

  private buildDateRange(startDate?: string, endDate?: string): DateRange {
    const now = new Date();
    return {
      startDate: startDate
        ? new Date(startDate)
        : new Date(now.getFullYear(), now.getMonth(), 1),
      endDate: endDate ? new Date(endDate) : now,
    };
  }

  /**
   * Reporte mensual del equipo — Cupo 1 (gerencial).
   * Por cada miembro (excluyendo Cliente) calcula:
   * - completedTasks: tareas DONE con endDate en el mes.
   * - totalSeconds: SUM de TimeEntry.duration (en SEGUNDOS) en el mes.
   * - hours: totalSeconds / 3600 (conversion server-side, no falsear unidades).
   * - avgDaysPerTask: promedio de (endDate - startDate) en dias para DONE del mes.
   * - onTimeTasks: tareas DONE con endDate <= dueDate (entregadas a tiempo).
   * - performancePct: (onTimeTasks / completedTasks) * 100 (1 decimal). null si completedTasks=0.
   */
  async getTeamMonthly(orgId: string, month?: string) {
    // Parsear mes en formato YYYY-MM (default: mes actual)
    const now = new Date();
    let year: number;
    let monthIndex: number;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      year = y;
      monthIndex = m - 1;
    } else {
      year = now.getFullYear();
      monthIndex = now.getMonth();
    }
    const monthStart = new Date(year, monthIndex, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
    const monthLabel = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

    // Miembros del equipo (excluir rol Cliente)
    const members = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: orgId,
        role: { name: { not: 'Cliente' } },
      },
      select: {
        user: { select: { id: true, name: true, image: true } },
        role: { select: { name: true } },
      },
    });

    const memberIds = members.map((m) => m.user.id);
    if (memberIds.length === 0) {
      return { month: monthLabel, items: [] };
    }

    // 1. Tareas DONE del mes por miembro (con endDate en el mes)
    const completedRaw = await this.prisma.taskAssignment.findMany({
      where: {
        userId: { in: memberIds },
        task: {
          status: 'DONE',
          endDate: { gte: monthStart, lte: monthEnd },
          project: { organizationId: orgId },
        },
      },
      select: {
        userId: true,
        task: {
          select: {
            startDate: true,
            endDate: true,
            dueDate: true,
          },
        },
      },
    });

    // 2. Suma de TimeEntry.duration por usuario (CONFIRMED en el mes)
    const timeAgg = await this.prisma.timeEntry.groupBy({
      by: ['userId'],
      where: {
        userId: { in: memberIds },
        status: 'CONFIRMED',
        startTime: { gte: monthStart, lte: monthEnd },
        task: { project: { organizationId: orgId } },
      },
      _sum: { duration: true },
    });
    const secondsByUser = new Map<string, number>(
      timeAgg.map((r) => [r.userId, r._sum.duration || 0]),
    );

    // 3. Agregar por miembro
    const items = members.map((m) => {
      const userId = m.user.id;
      const userTasks = completedRaw.filter((r) => r.userId === userId);
      const completedTasks = userTasks.length;

      // avgDaysPerTask: solo tareas con startDate y endDate
      const validForAvg = userTasks.filter(
        (r) => r.task.startDate && r.task.endDate,
      );
      const avgDaysPerTask = validForAvg.length > 0
        ? validForAvg.reduce((sum, r) => {
            const days = (r.task.endDate!.getTime() - r.task.startDate!.getTime()) / (1000 * 60 * 60 * 24);
            return sum + days;
          }, 0) / validForAvg.length
        : 0;

      // onTimeTasks: endDate <= dueDate (sólo si dueDate existe)
      const onTimeTasks = userTasks.filter(
        (r) => r.task.dueDate && r.task.endDate && r.task.endDate.getTime() <= r.task.dueDate.getTime(),
      ).length;

      const performancePct = completedTasks > 0
        ? Math.round((onTimeTasks / completedTasks) * 1000) / 10 // 1 decimal
        : null;

      const totalSeconds = secondsByUser.get(userId) || 0;
      const hours = Math.round((totalSeconds / 3600) * 100) / 100;

      return {
        userId,
        name: m.user.name,
        image: m.user.image,
        role: m.role?.name || null,
        completedTasks,
        totalSeconds,
        hours,
        avgDaysPerTask: Math.round(avgDaysPerTask * 10) / 10,
        onTimeTasks,
        performancePct,
      };
    });

    // Ordenar: rendimiento desc (null al final), luego por horas desc
    items.sort((a, b) => {
      if (a.performancePct === null && b.performancePct === null) return b.hours - a.hours;
      if (a.performancePct === null) return 1;
      if (b.performancePct === null) return -1;
      const diff = b.performancePct - a.performancePct;
      if (diff !== 0) return diff;
      return b.hours - a.hours;
    });

    return { month: monthLabel, items };
  }
}
