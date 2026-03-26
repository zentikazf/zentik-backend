import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException, SprintNotFoundException } from '../../common/filters/app-exception';
import { CreateSprintDto, UpdateSprintDto, AddTasksToSprintDto } from './dto';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class SprintService {
  private readonly logger = new Logger(SprintService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createSprint(projectId: string, dto: CreateSprintDto, userId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new AppException('El proyecto no existe', 'PROJECT_NOT_FOUND', 404, { projectId });
    }

    const sprint = await this.prisma.sprint.create({
      data: {
        projectId,
        name: dto.name,
        goal: dto.goal,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        createdById: userId,
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        _count: { select: { tasks: true } },
      },
    });

    this.eventEmitter.emit('sprint.created', {
      ...domainEvent('sprint.created', 'sprint', sprint.id, project.organizationId, userId, { name: sprint.name, projectId }),
      sprint,
    });
    this.logger.log(`Sprint created: ${sprint.id} in project ${projectId}`);

    return sprint;
  }

  async getSprints(projectId: string) {
    return this.prisma.sprint.findMany({
      where: { projectId },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        _count: { select: { tasks: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getActiveSprint(projectId: string) {
    const sprint = await this.prisma.sprint.findFirst({
      where: { projectId, status: 'ACTIVE' },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        tasks: {
          include: {
            assignments: {
              include: {
                user: { select: { id: true, name: true, email: true, image: true } },
              },
            },
            taskLabels: { include: { label: true } },
            boardColumn: true,
          },
          orderBy: { position: 'asc' },
        },
        _count: { select: { tasks: true } },
      },
    });

    if (!sprint) {
      throw new AppException(
        'No hay un sprint activo en este proyecto',
        'NO_ACTIVE_SPRINT',
        404,
        { projectId },
      );
    }

    return sprint;
  }

  async getSprintById(sprintId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        tasks: {
          include: {
            assignments: {
              include: {
                user: { select: { id: true, name: true, email: true, image: true } },
              },
            },
            taskLabels: { include: { label: true } },
            boardColumn: true,
          },
          orderBy: { position: 'asc' },
        },
        _count: { select: { tasks: true } },
      },
    });

    if (!sprint) {
      throw new SprintNotFoundException(sprintId);
    }

    return sprint;
  }

  async updateSprint(sprintId: string, dto: UpdateSprintDto, userId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!sprint) {
      throw new SprintNotFoundException(sprintId);
    }

    const updated = await this.prisma.sprint.update({
      where: { id: sprintId },
      data: {
        name: dto.name,
        goal: dto.goal,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        _count: { select: { tasks: true } },
      },
    });

    this.eventEmitter.emit('sprint.updated', {
      ...domainEvent('sprint.updated', 'sprint', updated.id, sprint.project.organizationId, userId, { name: updated.name }),
      sprint: updated,
    });

    return updated;
  }

  // ============================================
  // SPRINT LIFECYCLE
  // ============================================

  async startSprint(sprintId: string, userId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!sprint) {
      throw new SprintNotFoundException(sprintId);
    }

    if (sprint.status !== 'PLANNING') {
      throw new AppException(
        'Solo se pueden iniciar sprints en estado PLANNING',
        'INVALID_SPRINT_STATUS',
        422,
        { currentStatus: sprint.status },
      );
    }

    // Check no other active sprint in the same project
    const activeSprint = await this.prisma.sprint.findFirst({
      where: { projectId: sprint.projectId, status: 'ACTIVE' },
    });

    if (activeSprint) {
      throw new AppException(
        'Ya existe un sprint activo en este proyecto. Completa o cancela el sprint actual antes de iniciar uno nuevo.',
        'ACTIVE_SPRINT_EXISTS',
        409,
        { activeSprintId: activeSprint.id },
      );
    }

    const started = await this.prisma.sprint.update({
      where: { id: sprintId },
      data: {
        status: 'ACTIVE',
        startDate: sprint.startDate ?? new Date(),
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        _count: { select: { tasks: true } },
      },
    });

    this.eventEmitter.emit('sprint.started', {
      ...domainEvent('sprint.started', 'sprint', started.id, sprint.project.organizationId, userId, { name: started.name }),
      sprint: started,
    });
    this.logger.log(`Sprint started: ${sprintId}`);

    return started;
  }

  async completeSprint(sprintId: string, userId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: {
        tasks: { select: { id: true, status: true } },
        project: { select: { organizationId: true } },
      },
    });

    if (!sprint) {
      throw new SprintNotFoundException(sprintId);
    }

    if (sprint.status !== 'ACTIVE') {
      throw new AppException(
        'Solo se pueden completar sprints en estado ACTIVE',
        'INVALID_SPRINT_STATUS',
        422,
        { currentStatus: sprint.status },
      );
    }

    // Move incomplete tasks back to backlog (remove from sprint)
    const incompleteTasks = sprint.tasks.filter((t) => t.status !== 'DONE');

    const completed = await this.prisma.$transaction(async (tx) => {
      // Remove incomplete tasks from sprint
      if (incompleteTasks.length > 0) {
        await tx.task.updateMany({
          where: {
            id: { in: incompleteTasks.map((t) => t.id) },
          },
          data: { sprintId: null },
        });
      }

      return tx.sprint.update({
        where: { id: sprintId },
        data: {
          status: 'COMPLETED',
          endDate: sprint.endDate ?? new Date(),
        },
        include: {
          createdBy: { select: { id: true, name: true, email: true, image: true } },
          _count: { select: { tasks: true } },
        },
      });
    });

    this.eventEmitter.emit('sprint.completed', {
      ...domainEvent('sprint.completed', 'sprint', completed.id, sprint.project.organizationId, userId, { name: completed.name, incompleteTaskCount: incompleteTasks.length }),
      sprint: completed,
      incompleteTaskIds: incompleteTasks.map((t) => t.id),
    });
    this.logger.log(`Sprint completed: ${sprintId}, ${incompleteTasks.length} incomplete tasks moved to backlog`);

    return {
      ...completed,
      summary: {
        totalTasks: sprint.tasks.length,
        completedTasks: sprint.tasks.filter((t) => t.status === 'DONE').length,
        incompleteTasks: incompleteTasks.length,
      },
    };
  }

  // ============================================
  // TASK MANAGEMENT WITHIN SPRINT
  // ============================================

  async addTasksToSprint(sprintId: string, dto: AddTasksToSprintDto, userId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!sprint) {
      throw new SprintNotFoundException(sprintId);
    }

    if (sprint.status === 'COMPLETED' || sprint.status === 'CANCELLED') {
      throw new AppException(
        'No se pueden agregar tareas a un sprint completado o cancelado',
        'INVALID_SPRINT_STATUS',
        422,
        { currentStatus: sprint.status },
      );
    }

    await this.prisma.task.updateMany({
      where: {
        id: { in: dto.taskIds },
        projectId: sprint.projectId,
      },
      data: { sprintId },
    });

    this.eventEmitter.emit('sprint.tasks.added', {
      ...domainEvent('sprint.tasks.added', 'sprint', sprintId, sprint.project.organizationId, userId, { taskIds: dto.taskIds }),
      sprintId,
      taskIds: dto.taskIds,
    });
    this.logger.log(`${dto.taskIds.length} tasks added to sprint ${sprintId}`);

    return this.getSprintById(sprintId);
  }

  async removeTaskFromSprint(sprintId: string, taskId: string, userId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!sprint) {
      throw new SprintNotFoundException(sprintId);
    }

    const task = await this.prisma.task.findFirst({
      where: { id: taskId, sprintId },
    });

    if (!task) {
      throw new AppException(
        'La tarea no pertenece a este sprint',
        'TASK_NOT_IN_SPRINT',
        404,
        { taskId, sprintId },
      );
    }

    await this.prisma.task.update({
      where: { id: taskId },
      data: { sprintId: null },
    });

    this.eventEmitter.emit('sprint.task.removed', {
      ...domainEvent('sprint.task.removed', 'sprint', sprintId, sprint.project.organizationId, userId, { taskId }),
      sprintId,
      taskId,
    });
  }

  // ============================================
  // BURNDOWN DATA
  // ============================================

  async getBurndownData(sprintId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: {
        tasks: {
          select: {
            id: true,
            status: true,
            storyPoints: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!sprint) {
      throw new SprintNotFoundException(sprintId);
    }

    if (!sprint.startDate || !sprint.endDate) {
      throw new AppException(
        'El sprint debe tener fechas de inicio y fin para generar el burndown',
        'MISSING_SPRINT_DATES',
        422,
        { sprintId },
      );
    }

    const totalPoints = sprint.tasks.reduce(
      (sum, task) => sum + (task.storyPoints ?? 0),
      0,
    );

    const completedTasks = sprint.tasks.filter((t) => t.status === 'DONE');
    const completedPoints = completedTasks.reduce(
      (sum, task) => sum + (task.storyPoints ?? 0),
      0,
    );

    // Generate daily data points
    const start = new Date(sprint.startDate);
    const end = new Date(sprint.endDate);
    const today = new Date();
    const effectiveEnd = today < end ? today : end;

    const days: Array<{ date: string; ideal: number; actual: number }> = [];
    const totalDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

    for (let d = new Date(start); d <= effectiveEnd; d.setDate(d.getDate() + 1)) {
      const dayIndex = Math.ceil((d.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      const idealRemaining = totalPoints - (totalPoints / totalDays) * dayIndex;

      // Count points completed up to this date
      const pointsCompletedByDate = sprint.tasks
        .filter((t) => t.status === 'DONE' && t.updatedAt <= d)
        .reduce((sum, t) => sum + (t.storyPoints ?? 0), 0);

      days.push({
        date: new Date(d).toISOString().split('T')[0],
        ideal: Math.max(0, Math.round(idealRemaining * 10) / 10),
        actual: totalPoints - pointsCompletedByDate,
      });
    }

    return {
      sprintId,
      sprintName: sprint.name,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      totalPoints,
      completedPoints,
      remainingPoints: totalPoints - completedPoints,
      totalTasks: sprint.tasks.length,
      completedTasks: completedTasks.length,
      days,
    };
  }

  // ============================================
  // BACKLOG
  // ============================================

  async getBacklog(projectId: string) {
    return this.prisma.task.findMany({
      where: {
        projectId,
        sprintId: null,
        status: { not: 'CANCELLED' },
      },
      include: {
        assignments: {
          include: {
            user: { select: { id: true, name: true, email: true, image: true } },
          },
        },
        taskLabels: { include: { label: true } },
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        _count: { select: { subTasks: true, comments: true } },
      },
      orderBy: [{ priority: 'asc' }, { position: 'asc' }],
    });
  }
}
