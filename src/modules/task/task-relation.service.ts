import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException, TaskNotFoundException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';
import { BulkUpdateTaskDto } from './dto';

@Injectable()
export class TaskRelationService {
  private readonly logger = new Logger(TaskRelationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ============================================
  // ASSIGNMENTS
  // ============================================

  async assignTask(taskId: string, userId: string, requesterId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { project: { select: { organizationId: true } } } });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    const assignment = await this.prisma.taskAssignment.create({
      data: { taskId, userId },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    this.eventEmitter.emit('task.assigned', {
      ...domainEvent('task.assigned', 'task', taskId, task.project.organizationId, requesterId, { taskTitle: task.title, assigneeId: userId, projectId: task.projectId }),
      taskId,
      taskTitle: task.title,
      assigneeId: userId,
      assignedById: requesterId,
      projectId: task.projectId,
    });

    return assignment;
  }

  async unassignTask(taskId: string, userId: string, requesterId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { project: { select: { organizationId: true } } } });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    const assignment = await this.prisma.taskAssignment.findUnique({
      where: { taskId_userId: { taskId, userId } },
    });

    if (!assignment) {
      throw new AppException(
        'El usuario no esta asignado a esta tarea',
        'ASSIGNMENT_NOT_FOUND',
        404,
        { taskId, userId },
      );
    }

    await this.prisma.taskAssignment.delete({
      where: { taskId_userId: { taskId, userId } },
    });

    this.eventEmitter.emit('task.unassigned', {
      ...domainEvent('task.unassigned', 'task', taskId, task.project.organizationId, requesterId, { userId, projectId: task.projectId }),
    });
  }

  // ============================================
  // LABELS
  // ============================================

  async addLabel(taskId: string, labelId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { project: { select: { organizationId: true } } } });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    const taskLabel = await this.prisma.taskLabel.create({
      data: { taskId, labelId },
      include: { label: true },
    });

    this.eventEmitter.emit('task.label.added', {
      ...domainEvent('task.label.added', 'task', taskId, task.project.organizationId, userId, {
        labelId,
        labelName: taskLabel.label.name,
        labelColor: taskLabel.label.color,
        taskTitle: task.title,
        projectId: task.projectId,
      }),
    });

    return taskLabel;
  }

  async removeLabel(taskId: string, labelId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { project: { select: { organizationId: true } } } });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    const taskLabel = await this.prisma.taskLabel.findUnique({
      where: { taskId_labelId: { taskId, labelId } },
    });

    if (!taskLabel) {
      throw new AppException(
        'La etiqueta no esta asociada a esta tarea',
        'LABEL_NOT_FOUND',
        404,
        { taskId, labelId },
      );
    }

    await this.prisma.taskLabel.delete({
      where: { taskId_labelId: { taskId, labelId } },
    });

    const label = await this.prisma.label.findUnique({ where: { id: labelId }, select: { name: true, color: true } });

    this.eventEmitter.emit('task.label.removed', {
      ...domainEvent('task.label.removed', 'task', taskId, task.project.organizationId, userId, {
        labelId,
        labelName: label?.name,
        labelColor: label?.color,
        taskTitle: task.title,
        projectId: task.projectId,
      }),
    });
  }

  // ============================================
  // BULK OPERATIONS
  // ============================================

  async bulkUpdate(projectId: string, dto: BulkUpdateTaskDto, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } });
    const results = await this.prisma.$transaction(
      dto.operations.map((op) =>
        this.prisma.task.update({
          where: { id: op.taskId },
          data: {
            ...(op.status && { status: op.status }),
            ...(op.priority && { priority: op.priority }),
            ...(op.sprintId !== undefined && { sprintId: op.sprintId }),
          },
          include: {
            assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
            taskLabels: { include: { label: true } },
          },
        }),
      ),
    );

    this.eventEmitter.emit('tasks.bulk.updated', {
      ...domainEvent('tasks.bulk.updated', 'task', projectId, project?.organizationId || '', userId, { count: results.length, projectId }),
    });
    this.logger.log(`Bulk updated ${results.length} tasks in project ${projectId}`);

    return results;
  }
}
