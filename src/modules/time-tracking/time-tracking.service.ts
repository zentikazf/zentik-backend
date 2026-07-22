import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TimeEntryStatus } from '@prisma/client';
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

  // ============================================
  // Sincronizacion con estimaciones de tarea (Fase B — TimeEntry como motor invisible)
  // ============================================

  /**
   * Upsert de TimeEntry DRAFT a partir de la estimacion de la tarea.
   * Idempotente: si ya existe DRAFT para (taskId, userId), actualiza la duracion.
   * Si no existe, crea uno nuevo. Llamado desde el listener task.estimated.
   */
  async upsertDraftFromTask(taskId: string, estimatedHours: number, userId: string) {
    const durationSeconds = Math.round(estimatedHours * 3600);

    const existing = await this.prisma.timeEntry.findFirst({
      where: { taskId, userId, status: TimeEntryStatus.DRAFT },
    });

    if (existing) {
      return this.prisma.timeEntry.update({
        where: { id: existing.id },
        data: { duration: durationSeconds },
      });
    }

    return this.prisma.timeEntry.create({
      data: {
        taskId,
        userId,
        duration: durationSeconds,
        startTime: new Date(),
        status: TimeEntryStatus.DRAFT,
        billable: true,
      },
    });
  }

  /**
   * Confirma el TimeEntry DRAFT al aprobar la tarea (modal OTP).
   * Marca status=CONFIRMED, setea endTime y dispara time_entry.confirmed
   * (que el HoursListener escucha para descontar al cliente).
   */
  async confirmFromApproval(taskId: string, finalDurationSeconds: number, userId: string) {
    const draft = await this.prisma.timeEntry.findFirst({
      where: { taskId, status: TimeEntryStatus.DRAFT },
      include: { task: { include: { project: { select: { organizationId: true, clientId: true } } } } },
    });

    let confirmed;
    if (draft) {
      confirmed = await this.prisma.timeEntry.update({
        where: { id: draft.id },
        data: {
          duration: finalDurationSeconds,
          status: TimeEntryStatus.CONFIRMED,
          endTime: new Date(),
        },
        include: { task: { include: { project: { select: { organizationId: true, clientId: true } } } } },
      });
    } else {
      // Caso raro: aprobacion sin DRAFT previo (tarea sin estimacion). Crear CONFIRMED directo.
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        include: { assignments: { select: { userId: true } }, project: { select: { organizationId: true, clientId: true } } },
      });
      if (!task) {
        throw new AppException('La tarea no existe', 'TASK_NOT_FOUND', 404);
      }
      const assigneeId = task.assignments[0]?.userId ?? userId;
      confirmed = await this.prisma.timeEntry.create({
        data: {
          taskId,
          userId: assigneeId,
          duration: finalDurationSeconds,
          startTime: new Date(),
          endTime: new Date(),
          status: TimeEntryStatus.CONFIRMED,
          billable: true,
        },
        include: { task: { include: { project: { select: { organizationId: true, clientId: true } } } } },
      });
    }

    this.eventEmitter.emit('time_entry.confirmed', {
      ...domainEvent('time_entry.confirmed', 'time_entry', confirmed.id, confirmed.task.project.organizationId, userId),
      timeEntryId: confirmed.id,
      taskId,
      duration: finalDurationSeconds,
      legacyMigration: false,
      version: confirmed.version, // H2: identifica este ciclo de confirm (clave de idempotencia del ledger)
    });

    this.logger.log(`TimeEntry ${confirmed.id} CONFIRMED para task ${taskId} con ${finalDurationSeconds}s`);
    return confirmed;
  }

  /**
   * Reverte un TimeEntry CONFIRMED (no legacy) a DRAFT al rechazar/reabrir la tarea.
   * Dispara time_entry.reverted para que HoursListener devuelva las horas al cliente.
   */
  async revertConfirmation(taskId: string, userId: string) {
    const confirmed = await this.prisma.timeEntry.findFirst({
      where: { taskId, status: TimeEntryStatus.CONFIRMED, legacyMigration: false },
      include: { task: { include: { project: { select: { organizationId: true } } } } },
    });

    if (!confirmed) return null;

    const reverted = await this.prisma.timeEntry.update({
      where: { id: confirmed.id },
      // H2: bump de version → el próximo confirm usa una entry_version distinta y NO choca el único
      //     parcial. Así rechazar y re-aprobar cobra de nuevo (legítimo), mientras que el MISMO
      //     confirm disparado dos veces (misma version) sí choca y se ignora (idempotente).
      data: { status: TimeEntryStatus.DRAFT, endTime: null, version: { increment: 1 } },
      include: { task: { include: { project: { select: { organizationId: true } } } } },
    });

    this.eventEmitter.emit('time_entry.reverted', {
      ...domainEvent('time_entry.reverted', 'time_entry', reverted.id, reverted.task.project.organizationId, userId),
      timeEntryId: reverted.id,
      taskId,
      duration: reverted.duration,
    });

    this.logger.log(`TimeEntry ${reverted.id} revertido a DRAFT para task ${taskId}`);
    return reverted;
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
    const elapsedSeconds = Math.floor(
      (endTime.getTime() - new Date(startTime).getTime()) / 1000,
    );

    // Si ya existe un DRAFT para (taskId, userId) → sumar duracion. Si no → crear nuevo DRAFT.
    const draft = await this.prisma.timeEntry.findFirst({
      where: { taskId, userId, status: TimeEntryStatus.DRAFT },
    });

    let timeEntry;
    if (draft) {
      timeEntry = await this.prisma.timeEntry.update({
        where: { id: draft.id },
        data: {
          duration: (draft.duration ?? 0) + elapsedSeconds,
          endTime,
        },
        include: { task: { include: { project: { select: { organizationId: true } } } } },
      });
    } else {
      timeEntry = await this.prisma.timeEntry.create({
        data: {
          userId,
          taskId,
          startTime: new Date(startTime),
          endTime,
          duration: elapsedSeconds,
          status: TimeEntryStatus.DRAFT,
          billable: true,
        },
        include: { task: { include: { project: { select: { organizationId: true } } } } },
      });
    }

    await this.redis.del(this.timerKey(userId));

    this.eventEmitter.emit('timer.stopped', {
      ...domainEvent('timer.stopped', 'time_entry', timeEntry.id, timeEntry.task.project.organizationId, userId),
      userId,
      taskId,
      timeEntryId: timeEntry.id,
      duration: elapsedSeconds,
    });

    this.logger.log(
      `Temporizador detenido para usuario ${userId}. Sumado ${elapsedSeconds}s al DRAFT (total: ${timeEntry.duration}s)`,
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
