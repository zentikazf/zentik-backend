import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException, TaskNotFoundException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class TaskApprovalService {
  private readonly logger = new Logger(TaskApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async approveTask(taskId: string, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true, responsibleId: true, organizationId: true } },
        assignments: { select: { userId: true } },
      },
    }) as any;

    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    if (task.status !== 'IN_REVIEW') {
      throw new AppException(
        'Solo se pueden aprobar tareas en estado Testing (IN_REVIEW)',
        'INVALID_TASK_STATUS',
        400,
      );
    }

    const deployColumn = await this.prisma.boardColumn.findFirst({
      where: {
        board: { projectId: task.projectId },
        mappedStatus: 'DONE',
      },
      orderBy: { position: 'asc' },
    });

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'DONE',
        endDate: task.endDate ?? new Date(),
        ...(deployColumn && { boardColumnId: deployColumn.id }),
      },
    });

    this.eventEmitter.emit('task.approval.approved', {
      ...domainEvent('task.approval.approved', 'task', task.id, task.project.organizationId, userId, { taskTitle: task.title, projectId: task.projectId, projectName: task.project.name }),
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      projectName: task.project.name,
      approvedById: userId,
      assigneeIds: task.assignments.map((a: { userId: string }) => a.userId),
    });

    // Emit task.completed so HoursListener deducts SUPPORT hours
    this.eventEmitter.emit('task.completed', {
      ...domainEvent('task.completed', 'task', task.id, task.project.organizationId, userId, { title: task.title, projectId: task.projectId }),
      task: { ...updated, type: (task as any).type, projectId: task.projectId, createdAt: task.createdAt, estimatedHours: (task as any).estimatedHours },
    });

    return updated;
  }

  async rejectTask(taskId: string, reason: string | undefined, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true, responsibleId: true, organizationId: true } },
        assignments: { select: { userId: true } },
      },
    });

    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    if (task.status !== 'IN_REVIEW') {
      throw new AppException(
        'Solo se pueden rechazar tareas en estado Testing (IN_REVIEW)',
        'INVALID_TASK_STATUS',
        400,
      );
    }

    const desarrolloColumn = await this.prisma.boardColumn.findFirst({
      where: {
        board: { projectId: task.projectId },
        mappedStatus: 'IN_PROGRESS',
      },
      orderBy: { position: 'asc' },
    });

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'IN_PROGRESS',
        reviewAttempts: { increment: 1 },
        ...(desarrolloColumn && { boardColumnId: desarrolloColumn.id }),
      },
    });

    // Create system comment with rejection reason
    await this.prisma.comment.create({
      data: {
        taskId,
        userId,
        content: reason ? `Tarea rechazada: ${reason}` : 'Tarea rechazada (sin motivo)',
        isSystem: true,
      },
    });

    this.eventEmitter.emit('task.approval.rejected', {
      ...domainEvent('task.approval.rejected', 'task', task.id, task.project.organizationId, userId, { taskTitle: task.title, projectId: task.projectId, reason: reason || '' }),
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      projectName: task.project.name,
      rejectedById: userId,
      reason: reason || '',
      reviewAttempts: updated.reviewAttempts,
      assigneeIds: task.assignments.map((a) => a.userId),
    });

    return updated;
  }

  async findPendingApprovalsByProject(projectId: string) {
    const tasks = await this.prisma.task.findMany({
      where: {
        status: 'IN_REVIEW',
        projectId,
      },
      include: {
        project: { select: { id: true, name: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
        },
        boardColumn: { select: { id: true, name: true, color: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      reviewAttempts: t.reviewAttempts,
      updatedAt: t.updatedAt,
      project: t.project,
      assignees: t.assignments.map((a) => a.user),
      column: t.boardColumn,
    }));
  }

  async countPendingApprovals(orgId: string): Promise<number> {
    return this.prisma.task.count({
      where: {
        status: 'IN_REVIEW',
        project: { organizationId: orgId },
      },
    });
  }

  async findPendingApprovals(orgId: string) {
    const tasks = await this.prisma.task.findMany({
      where: {
        status: 'IN_REVIEW',
        project: { organizationId: orgId },
      },
      include: {
        project: { select: { id: true, name: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
        },
        boardColumn: { select: { id: true, name: true, color: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      reviewAttempts: t.reviewAttempts,
      updatedAt: t.updatedAt,
      project: t.project,
      assignees: t.assignments.map((a) => a.user),
      column: t.boardColumn,
    }));
  }
}
