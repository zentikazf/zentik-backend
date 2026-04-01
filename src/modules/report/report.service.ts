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
        total_invoiced: number;
        total_paid: number;
      }[]
    >`
      SELECT
        p.id AS project_id,
        p.name AS project_name,
        COALESCE(SUM(te.duration) / 60.0, 0) AS total_hours,
        COALESCE((
          SELECT SUM(i.total) FROM invoices i
          WHERE i.project_id = p.id
            AND i.issue_date >= ${range.startDate}
            AND i.issue_date <= ${range.endDate}
        ), 0) AS total_invoiced,
        COALESCE((
          SELECT SUM(i.total) FROM invoices i
          WHERE i.project_id = p.id
            AND i.status = 'PAID'
            AND i.paid_at >= ${range.startDate}
            AND i.paid_at <= ${range.endDate}
        ), 0) AS total_paid
      FROM projects p
      LEFT JOIN tasks t ON p.id = t.project_id
      LEFT JOIN time_entries te ON t.id = te.task_id
        AND te.start_time >= ${range.startDate}
        AND te.start_time <= ${range.endDate}
      WHERE p.organization_id = ${orgId}
      GROUP BY p.id, p.name
      ORDER BY total_invoiced DESC
    `;

    return {
      projects: profitability.map((row) => ({
        projectId: row.project_id,
        projectName: row.project_name,
        totalHours: parseFloat(Number(row.total_hours).toFixed(2)),
        totalInvoiced: parseFloat(Number(row.total_invoiced).toFixed(2)),
        totalPaid: parseFloat(Number(row.total_paid).toFixed(2)),
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
}
