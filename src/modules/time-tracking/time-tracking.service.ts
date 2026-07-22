import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TimeEntryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';
import { CreateManualTimeEntryDto } from './dto/create-manual-time-entry.dto';
import { UpdateTimeEntryDto } from './dto/update-time-entry.dto';
import { TimeReportFilterDto } from './dto/time-report-filter.dto';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';

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

    // H4 (T14): evento bien formado — payload dentro del arg `data`, entity='task' → cae en /tasks/:id/activity.
    this.eventEmitter.emit(
      'time_entry.created',
      domainEvent(
        'time_entry.created',
        'task',
        dto.taskId,
        organizationId,
        userId,
        { timeEntryId: timeEntry.id, taskId: dto.taskId, duration },
      ),
    );

    this.logger.log(
      `Entrada de tiempo creada: ${timeEntry.id} por usuario ${userId}`,
    );

    return timeEntry;
  }

  async findByUser(
    userId: string,
    filters?: { startDate?: string; endDate?: string; projectId?: string },
  ) {
    const where: any = { userId, deletedAt: null }; // H4: excluir soft-deleted

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
    return this.prisma.timeEntry.findFirst({
      where: { id, deletedAt: null }, // H4: excluir soft-deleted
      include: { task: true },
    });
  }

  // ============================================
  // H4 — Carga manual: la hora nace de una DECLARACIÓN HUMANA con fecha (workedOn)
  // ============================================

  async createManual(
    actor: AuthenticatedUser,
    taskId: string,
    dto: CreateManualTimeEntryDto,
  ) {
    // 1) Cargar la tarea con lo necesario para autorizar + validar + heredar billable.
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        billable: true,
        createdAt: true,
        assignments: { select: { userId: true } },
        project: { select: { organizationId: true, clientId: true } },
      },
    });
    if (!task) {
      throw new AppException('La tarea no existe', 'TASK_NOT_FOUND', 404);
    }

    // 2) Org-scoping (defense in depth: cierra de paso el hueco multi-tenant del create legacy).
    //    Solo si conocemos las orgs del actor; nunca revela cross-org (404, no 403).
    if (
      actor.organizationIds?.length &&
      !actor.organizationIds.includes(task.project.organizationId)
    ) {
      throw new AppException('La tarea no existe', 'TASK_NOT_FOUND', 404);
    }

    // 3) A quién se imputan las horas + permisos.
    const canManage = this.canManageTimeEntries(actor);
    const targetUserId = dto.userId ?? actor.id;
    if (dto.userId && dto.userId !== actor.id && !canManage) {
      throw new AppException(
        'No podés cargar horas en nombre de otra persona',
        'FORBIDDEN',
        403,
      );
    }
    const isAssigned = task.assignments.some((a) => a.userId === actor.id);
    if (!isAssigned && !canManage) {
      throw new AppException(
        'No estás asignado a esta tarea',
        'FORBIDDEN',
        403,
      );
    }

    // 4) Validaciones de workedOn (no futuro, no antes de la tarea, no mes ya facturado).
    this.assertWorkedOnValid(dto.workedOn, task.createdAt);
    await this.assertWorkedOnNotBilled(task.project.clientId, dto.workedOn);
    const workedOn = this.parseWorkedOn(dto.workedOn);

    // 5) Una entrada por (tarea, usuario, día) viva (chequeo de app; el índice único parcial es el backstop).
    const existingDay = await this.prisma.timeEntry.findFirst({
      where: { taskId, userId: targetUserId, workedOn, deletedAt: null },
      select: { id: true },
    });
    if (existingDay) {
      throw new AppException(
        'Ya cargaste horas para esta tarea en esa fecha. Editá la entrada existente.',
        'TIME_ENTRY_DAY_EXISTS',
        409,
      );
    }

    // 6) Crear. billable SE HEREDA de la task; startTime (NOT NULL legacy) = workedOn (ancla neutra);
    //    duration = minutes*60 deja coherentes los reportes que suman segundos; status CONFIRMED mantiene
    //    la entrada fuera del picker DRAFT del timer SIN cobrar (el cobro lo dispara time_entry.confirmed, que NO se emite).
    const minutes = dto.minutes;
    let entry;
    try {
      entry = await this.prisma.timeEntry.create({
        data: {
          taskId,
          userId: targetUserId,
          createdById: actor.id,
          minutes,
          workedOn,
          origin: 'MANUAL',
          description: dto.note ?? null,
          billable: task.billable,
          startTime: workedOn,
          duration: minutes * 60,
          status: TimeEntryStatus.CONFIRMED,
        },
        include: { user: { select: { id: true, name: true, image: true } } },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new AppException(
          'Ya cargaste horas para esta tarea en esa fecha. Editá la entrada existente.',
          'TIME_ENTRY_DAY_EXISTS',
          409,
        );
      }
      throw e;
    }

    // 7) Traza: evento bien formado (payload en `data`, entity='task' → GET /tasks/:id/activity).
    this.eventEmitter.emit(
      'time_entry.created',
      domainEvent(
        'time_entry.created',
        'task',
        taskId,
        task.project.organizationId,
        actor.id,
        {
          timeEntryId: entry.id,
          minutes,
          workedOn: dto.workedOn,
          forUserId: targetUserId,
          origin: 'MANUAL',
        },
      ),
    );

    this.logger.log(
      `Carga manual ${entry.id}: ${minutes}min en task ${taskId} (workedOn ${dto.workedOn}) por ${actor.id} → user ${targetUserId}`,
    );
    return entry;
  }

  async update(id: string, actor: AuthenticatedUser, dto: UpdateTimeEntryDto) {
    const existing = await this.prisma.timeEntry.findFirst({
      where: { id, deletedAt: null }, // soft-deleted = no existe
      include: {
        task: {
          include: {
            project: { select: { organizationId: true, clientId: true } },
          },
        },
      },
    });

    const isOwner = existing?.userId === actor.id;
    const canManage = this.canManageTimeEntries(actor);
    if (!existing || (!isOwner && !canManage)) {
      // 404 (no 403) preserva el shape actual y no filtra existencia de entradas ajenas.
      throw new AppException(
        'La entrada de tiempo no existe o no te pertenece',
        'TIME_ENTRY_NOT_FOUND',
        404,
      );
    }

    const isManualCorrection =
      dto.minutes !== undefined ||
      dto.workedOn !== undefined ||
      dto.note !== undefined;

    const data: any = {};

    if (isManualCorrection) {
      if (dto.workedOn !== undefined) {
        this.assertWorkedOnValid(dto.workedOn, existing.task.createdAt);
        await this.assertWorkedOnNotBilled(
          existing.task.project.clientId,
          dto.workedOn,
        );
        data.workedOn = this.parseWorkedOn(dto.workedOn);
      }
      if (dto.minutes !== undefined && dto.minutes !== existing.minutes) {
        // Snapshot del valor anterior (badge O(1)); tolera corregir una entry legacy (minutes NULL → duration/60).
        data.previousMinutes =
          existing.minutes ??
          (existing.duration != null
            ? Math.round(existing.duration / 60)
            : null);
        data.minutes = dto.minutes;
        data.duration = dto.minutes * 60; // sombra legacy coherente (R30)
      }
      if (dto.note !== undefined) {
        data.description = dto.note;
        data.correctionNote = dto.note;
      }
      data.correctedById = actor.id;
      data.correctedAt = new Date();
    } else {
      // Vía legacy (timer): startTime/endTime/duration — se conserva el comportamiento previo.
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.billable !== undefined) data.billable = dto.billable;
      if (dto.startTime) data.startTime = new Date(dto.startTime);
      if (dto.endTime) data.endTime = new Date(dto.endTime);
      if (dto.duration !== undefined) data.duration = dto.duration;
      if (dto.startTime && dto.endTime && dto.duration === undefined) {
        data.duration = Math.floor(
          (new Date(dto.endTime).getTime() -
            new Date(dto.startTime).getTime()) /
            1000,
        );
      }
    }

    let updated;
    try {
      updated = await this.prisma.timeEntry.update({
        where: { id },
        data,
        include: { user: { select: { id: true, name: true, image: true } } },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new AppException(
          'Ya existe una carga para esa tarea en esa fecha',
          'TIME_ENTRY_DAY_EXISTS',
          409,
        );
      }
      throw e;
    }

    if (isManualCorrection) {
      this.eventEmitter.emit(
        'time_entry.corrected',
        domainEvent(
          'time_entry.corrected',
          'task',
          existing.taskId,
          existing.task.project.organizationId,
          actor.id,
          {
            timeEntryId: id,
            minutes: updated.minutes,
            correctedFor: existing.userId,
          },
          { minutes: existing.minutes, workedOn: existing.workedOn },
        ),
      );
    }
    return updated;
  }

  async delete(id: string, actor: AuthenticatedUser, reason?: string) {
    const existing = await this.prisma.timeEntry.findFirst({
      where: { id, deletedAt: null }, // ya borrada = 404 (idempotente)
      include: {
        task: {
          include: { project: { select: { organizationId: true } } },
        },
      },
    });

    const isOwner = existing?.userId === actor.id;
    const canManage = this.canManageTimeEntries(actor);
    if (!existing || (!isOwner && !canManage)) {
      throw new AppException(
        'La entrada de tiempo no existe o no te pertenece',
        'TIME_ENTRY_NOT_FOUND',
        404,
      );
    }

    // Soft delete: UPDATE, no DELETE. Libera el slot del único parcial (deleted_at IS NULL).
    const deleted = await this.prisma.timeEntry.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedById: actor.id,
        deleteReason: reason ?? null,
      },
    });

    this.eventEmitter.emit(
      'time_entry.deleted',
      domainEvent(
        'time_entry.deleted',
        'task',
        existing.taskId,
        existing.task.project.organizationId,
        actor.id,
        { timeEntryId: id, deletedFor: existing.userId, reason: reason ?? null },
        { minutes: existing.minutes, workedOn: existing.workedOn },
      ),
    );
    return deleted;
  }

  // ── H4: helpers de autorización y validación de workedOn ──

  private canManageTimeEntries(actor: AuthenticatedUser): boolean {
    return !!actor.permissions?.some(
      (p) => p === 'manage:time-entries' || p === '*:*',
    );
  }

  private parseWorkedOn(input: string): Date {
    // 'YYYY-MM-DD' (o ISO) → Date date-only a medianoche UTC. Se guarda en @db.Date (PG ignora la hora).
    return new Date(`${input.slice(0, 10)}T00:00:00.000Z`);
  }

  private dayInAsuncion(d: Date): string {
    // 'YYYY-MM-DD' del instante `d` en America/Asuncion (es-PY), no en UTC crudo.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Asuncion',
    }).format(d);
  }

  private assertWorkedOnValid(workedOnInput: string, taskCreatedAt: Date) {
    const workedOnDay = workedOnInput.slice(0, 10); // 'YYYY-MM-DD'
    const todayDay = this.dayInAsuncion(new Date()); // hoy en Asunción
    // Comparación lexicográfica de fechas ISO 'YYYY-MM-DD' = comparación cronológica.
    if (workedOnDay > todayDay) {
      throw new AppException(
        'No podés cargar horas en una fecha futura',
        'WORKED_ON_IN_FUTURE',
        400,
      );
    }
    const taskDay = this.dayInAsuncion(taskCreatedAt);
    if (workedOnDay < taskDay) {
      throw new AppException(
        'No podés cargar horas antes de que existiera la tarea',
        'WORKED_ON_BEFORE_TASK',
        400,
      );
    }
  }

  private async assertWorkedOnNotBilled(
    clientId: string | null,
    workedOnInput: string,
  ) {
    if (!clientId) return; // proyecto sin cliente → no aplica el candado de facturación
    // Mediodía UTC del día trabajado: queda lejos de los bordes medianoche/fin-de-mes de Asunción
    // con que ClientBillingCycle guarda periodStart/periodEnd (evita el drift de zona horaria).
    const checkInstant = new Date(`${workedOnInput.slice(0, 10)}T12:00:00.000Z`);
    const billed = await this.prisma.clientBillingCycle.findFirst({
      where: {
        clientId,
        status: { not: 'CANCELLED' }, // DRAFT|SENT|PAID = mes cerrado/facturado; CANCELLED = reabierto
        periodStart: { lte: checkInstant },
        periodEnd: { gte: checkInstant },
      },
      select: { id: true },
    });
    if (billed) {
      throw new AppException(
        'Ese mes ya fue facturado; no se puede cargar horas en un período cerrado',
        'WORKED_ON_MONTH_BILLED',
        409,
      );
    }
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
      where: { taskId, userId, status: TimeEntryStatus.DRAFT, deletedAt: null },
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
    // Defensa en profundidad (invariante "a lo sumo un cobro de aprobación por tarea"): si quedó
    // colgado un CONFIRMED de aprobación (p. ej. una reapertura por un camino que no reembolsó),
    // revertirlo ANTES de confirmar evita apilar un segundo cobro. En el flujo normal (sin CONFIRMED
    // previo) es un no-op. No toca las cargas manuales — revertConfirmation ya las excluye.
    await this.revertConfirmation(taskId, userId);

    const draft = await this.prisma.timeEntry.findFirst({
      where: { taskId, status: TimeEntryStatus.DRAFT, deletedAt: null },
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
      // Solo entradas de APROBACIÓN. Las cargas manuales H4 son CONFIRMED pero NUNCA cobraron
      // (no emiten time_entry.confirmed), así que jamás deben revertirse ni reembolsarse.
      // (OR explícito porque en SQL `origin <> 'MANUAL'` excluye los NULL de las entradas de aprobación.)
      where: {
        taskId,
        status: TimeEntryStatus.CONFIRMED,
        legacyMigration: false,
        deletedAt: null,
        OR: [{ origin: null }, { origin: { not: 'MANUAL' } }],
      },
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
      where: { taskId, userId, status: TimeEntryStatus.DRAFT, deletedAt: null },
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
      deletedAt: null, // H4: excluir soft-deleted del reporte
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
    const where: any = { userId, deletedAt: null }; // H4: excluir soft-deleted del reporte

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
