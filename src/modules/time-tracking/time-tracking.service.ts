import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';
import { UpdateTimeEntryDto } from './dto/update-time-entry.dto';
import { TimeReportFilterDto } from './dto/time-report-filter.dto';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';

// ============================================
// TimeEntryService — CRUD de entradas de tiempo
// ============================================

@Injectable()
export class TimeEntryService {
  private readonly logger = new Logger(TimeEntryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(userId: string, dto: CreateTimeEntryDto) {
    const duration =
      dto.duration ??
      Math.floor(
        (new Date(dto.endTime).getTime() - new Date(dto.startTime).getTime()) /
          1000,
      );

    const timeEntry = await this.prisma.timeEntry.create({
      data: {
        userId,
        taskId: dto.taskId,
        description: dto.description,
        startTime: new Date(dto.startTime),
        endTime: new Date(dto.endTime),
        duration,
        billable: dto.billable ?? false,
      },
      include: { task: { include: { project: { select: { organizationId: true } } } } },
    });

    const organizationId = timeEntry.task.project.organizationId;

    this.eventEmitter.emit('time_entry.created', {
      ...domainEvent('time_entry.created', 'time_entry', timeEntry.id, organizationId, userId),
      timeEntryId: timeEntry.id,
      userId,
      taskId: dto.taskId,
      duration,
    });

    this.logger.log(
      `Entrada de tiempo creada: ${timeEntry.id} por usuario ${userId}`,
    );

    return timeEntry;
  }

  async findByUser(
    userId: string,
    filters?: { startDate?: string; endDate?: string; projectId?: string },
  ) {
    const where: any = { userId };

    if (filters?.startDate || filters?.endDate) {
      where.startTime = {};
      if (filters.startDate) {
        where.startTime.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        where.startTime.lte = new Date(filters.endDate);
      }
    }

    if (filters?.projectId) {
      where.task = { projectId: filters.projectId };
    }

    return this.prisma.timeEntry.findMany({
      where,
      include: { task: true },
      orderBy: { startTime: 'desc' },
    });
  }

  async findById(id: string) {
    return this.prisma.timeEntry.findUnique({
      where: { id },
      include: { task: true },
    });
  }

  async update(id: string, userId: string, dto: UpdateTimeEntryDto) {
    const existing = await this.prisma.timeEntry.findUnique({
      where: { id },
    });

    if (!existing || existing.userId !== userId) {
      throw new AppException(
        'La entrada de tiempo no existe o no te pertenece',
        'TIME_ENTRY_NOT_FOUND',
        404,
      );
    }

    const data: any = { ...dto };
    if (dto.startTime) data.startTime = new Date(dto.startTime);
    if (dto.endTime) data.endTime = new Date(dto.endTime);

    if (dto.startTime && dto.endTime && !dto.duration) {
      data.duration = Math.floor(
        (new Date(dto.endTime).getTime() -
          new Date(dto.startTime).getTime()) /
          1000,
      );
    }

    return this.prisma.timeEntry.update({
      where: { id },
      data,
      include: { task: true },
    });
  }

  async delete(id: string, userId: string) {
    const existing = await this.prisma.timeEntry.findUnique({
      where: { id },
    });

    if (!existing || existing.userId !== userId) {
      throw new AppException(
        'La entrada de tiempo no existe o no te pertenece',
        'TIME_ENTRY_NOT_FOUND',
        404,
      );
    }

    return this.prisma.timeEntry.delete({ where: { id } });
  }
}

// ============================================
// TimerService — Temporizadores activos con Redis
// ============================================

@Injectable()
export class TimerService {
  private readonly logger = new Logger(TimerService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private timerKey(userId: string): string {
    return `timer:${userId}`;
  }

  async start(userId: string, taskId: string) {
    const existingTimer = await this.redis.get(this.timerKey(userId));

    if (existingTimer) {
      throw new AppException(
        'Ya tienes un temporizador activo. Detenlo antes de iniciar otro.',
        'TIMER_ALREADY_ACTIVE',
        409,
      );
    }

    const timerData = JSON.stringify({
      taskId,
      startTime: new Date().toISOString(),
    });

    await this.redis.set(this.timerKey(userId), timerData);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { project: { select: { organizationId: true } } },
    });

    this.eventEmitter.emit('timer.started', {
      ...domainEvent('timer.started', 'time_entry', taskId, task?.project.organizationId ?? '', userId),
      userId,
      taskId,
      startTime: new Date().toISOString(),
    });

    this.logger.log(
      `Temporizador iniciado para usuario ${userId} en tarea ${taskId}`,
    );

    return { taskId, startTime: new Date().toISOString(), active: true };
  }

  async stop(userId: string) {
    const timerData = await this.redis.get(this.timerKey(userId));

    if (!timerData) {
      throw new AppException(
        'No tienes un temporizador activo',
        'NO_ACTIVE_TIMER',
        404,
      );
    }

    const { taskId, startTime } = JSON.parse(timerData);
    const endTime = new Date();
    const duration = Math.floor(
      (endTime.getTime() - new Date(startTime).getTime()) / 1000,
    );

    const timeEntry = await this.prisma.timeEntry.create({
      data: {
        userId,
        taskId,
        startTime: new Date(startTime),
        endTime,
        duration,
        billable: false,
      },
      include: { task: { include: { project: { select: { organizationId: true } } } } },
    });

    await this.redis.del(this.timerKey(userId));

    this.eventEmitter.emit('timer.stopped', {
      ...domainEvent('timer.stopped', 'time_entry', timeEntry.id, timeEntry.task.project.organizationId, userId),
      userId,
      taskId,
      timeEntryId: timeEntry.id,
      duration,
    });

    this.logger.log(
      `Temporizador detenido para usuario ${userId}. Duracion: ${duration}s`,
    );

    return timeEntry;
  }

  async getActive(userId: string) {
    const timerData = await this.redis.get(this.timerKey(userId));

    if (!timerData) {
      return null;
    }

    const { taskId, startTime } = JSON.parse(timerData);
    const elapsed = Math.floor(
      (Date.now() - new Date(startTime).getTime()) / 1000,
    );

    return {
      taskId,
      startTime,
      elapsed,
      active: true,
    };
  }
}

// ============================================
// TimeReportService — Reportes y agregaciones
// ============================================

@Injectable()
export class TimeReportService {
  private readonly logger = new Logger(TimeReportService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getProjectReport(projectId: string, filters: TimeReportFilterDto) {
    const where: any = {
      task: { projectId },
    };

    if (filters.startDate || filters.endDate) {
      where.startTime = {};
      if (filters.startDate) {
        where.startTime.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        where.startTime.lte = new Date(filters.endDate);
      }
    }

    const timeEntries = await this.prisma.timeEntry.findMany({
      where,
      include: {
        task: true,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { startTime: 'desc' },
    });

    const totalDuration = timeEntries.reduce(
      (sum, entry) => sum + (entry.duration ?? 0),
      0,
    );
    const billableDuration = timeEntries
      .filter((entry) => entry.billable)
      .reduce((sum, entry) => sum + (entry.duration ?? 0), 0);

    const byUser = timeEntries.reduce(
      (acc, entry) => {
        const userId = entry.userId;
        if (!acc[userId]) {
          acc[userId] = { user: (entry as any).user, totalDuration: 0, entries: 0 };
        }
        acc[userId].totalDuration += entry.duration;
        acc[userId].entries += 1;
        return acc;
      },
      {} as Record<string, any>,
    );

    const byTask = timeEntries.reduce(
      (acc, entry) => {
        const taskId = entry.taskId;
        if (!acc[taskId]) {
          acc[taskId] = { task: entry.task, totalDuration: 0, entries: 0 };
        }
        acc[taskId].totalDuration += entry.duration;
        acc[taskId].entries += 1;
        return acc;
      },
      {} as Record<string, any>,
    );

    return {
      projectId,
      totalDuration,
      billableDuration,
      nonBillableDuration: totalDuration - billableDuration,
      totalEntries: timeEntries.length,
      byUser: Object.values(byUser),
      byTask: Object.values(byTask),
    };
  }

  async getUserReport(userId: string, filters: TimeReportFilterDto) {
    const where: any = { userId };

    if (filters.startDate || filters.endDate) {
      where.startTime = {};
      if (filters.startDate) {
        where.startTime.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        where.startTime.lte = new Date(filters.endDate);
      }
    }

    if (filters.projectId) {
      where.task = { projectId: filters.projectId };
    }

    const timeEntries = await this.prisma.timeEntry.findMany({
      where,
      include: { task: { include: { project: true } } },
      orderBy: { startTime: 'desc' },
    });

    const totalDuration = timeEntries.reduce(
      (sum, entry) => sum + (entry.duration ?? 0),
      0,
    );
    const billableDuration = timeEntries
      .filter((entry) => entry.billable)
      .reduce((sum, entry) => sum + (entry.duration ?? 0), 0);

    const byProject = timeEntries.reduce(
      (acc, entry) => {
        const project = (entry.task as any)?.project;
        if (!project) return acc;
        const projectId = project.id;
        if (!acc[projectId]) {
          acc[projectId] = {
            project: { id: project.id, name: project.name },
            totalDuration: 0,
            entries: 0,
          };
        }
        acc[projectId].totalDuration += entry.duration;
        acc[projectId].entries += 1;
        return acc;
      },
      {} as Record<string, any>,
    );

    return {
      userId,
      totalDuration,
      billableDuration,
      nonBillableDuration: totalDuration - billableDuration,
      totalEntries: timeEntries.length,
      byProject: Object.values(byProject),
    };
  }
}
