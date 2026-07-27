import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TimeEntryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
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
        status: true,
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

    // 2-bis) H7 (GATE-5, defensa en profundidad): no cargar horas en tareas ya cerradas.
    // El cobro se consolida al aprobar (→DONE); cargar después crearía horas que nunca se
    // cobran (no hay quién dispare time_entry.confirmed). Para ajustar, reabrí la tarea.
    if (task.status === 'DONE') {
      throw new AppException(
        'La tarea ya fue aprobada y cerrada; no se pueden cargar más horas. Reabrí la tarea para ajustar.',
        'TASK_ALREADY_DONE',
        409,
      );
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
    //    duration = minutes*60 deja coherentes los reportes que suman segundos; status CONFIRMED nace
    //    SIN cobrar (el cobro lo dispara time_entry.confirmed en la aprobacion, que aca NO se emite).
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

    // H8c: no borrar una carga MANUAL cuyo cobro YA fue facturado (billedCycleId != null).
    // Sin esto, el time_entry.reverted de más abajo dispararía un REFUND que devuelve el cupo
    // mientras la factura (ciclo cerrado) ya cobró la plata → la misma divergencia invisible
    // que frena el guard de reapertura. Bloqueo ANTES del soft-delete. Paridad con
    // deleteHoursTransaction (TRANSACTION_BILLED) y con assertNotBilled. Candado hasta H9.
    if (existing.origin === 'MANUAL') {
      const billed = await this.prisma.hoursTransaction.count({
        where: {
          taskId: existing.taskId,
          timeEntryId: id,
          entryVersion: existing.version,
          type: { in: ['USAGE', 'LOAN'] },
          billedCycleId: { not: null },
          deletedAt: null,
        },
      });
      if (billed > 0) {
        throw new AppException(
          'Esta carga ya fue facturada. Para revertirla necesitás emitir una nota de crédito.',
          'TASK_HOURS_BILLED',
          409,
          { timeEntryId: id, taskId: existing.taskId },
        );
      }
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

    // H7: si la carga MANUAL borrada tenía cobro VIVO (aprobación previa), devolver ese cupo.
    // Sin esto el borrado dejaría usedHours consumido para siempre: el reverso de reapertura
    // (revertManualCharges) salta las soft-deleted, así que hay que soltarlo acá, en el borrado.
    // Reusa el evento keyed → onTimeEntryReverted refunda el cobro exacto (id, version). No bump
    // de version: la entrada queda borrada y confirmFromApproval ya no la re-cobra (deletedAt).
    if (existing.origin === 'MANUAL') {
      const liveCharge = await this.prisma.hoursTransaction.findFirst({
        where: {
          taskId: existing.taskId,
          timeEntryId: id,
          entryVersion: existing.version,
          type: { in: ['USAGE', 'LOAN'] },
          deletedAt: null,
        },
        select: { id: true },
      });
      if (liveCharge) {
        this.eventEmitter.emit('time_entry.reverted', {
          ...domainEvent('time_entry.reverted', 'time_entry', id, existing.task.project.organizationId, actor.id),
          timeEntryId: id,
          taskId: existing.taskId,
          duration: existing.duration,
          entryVersion: existing.version,
        });
        this.logger.log(`Carga MANUAL ${id} borrada con cobro vivo → cupo devuelto (v${existing.version})`);
      }
    }
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

  /**
   * H7 — Cobra las horas MANUALES reales al aprobar la tarea. Emite un
   * time_entry.confirmed por cada carga origin='MANUAL' viva (deletedAt=null,
   * minutes>0), con duration=minutes*60 y su version → el HoursListener descuenta
   * cupo por cada una. Idempotencia H2 por (timeEntryId, entryVersion): re-emitir
   * la misma carga a la misma version rebota con P2002 (sin doble cobro). NO crea
   * entradas sintéticas ni cobra la estimación. Devuelve el total cobrado (segundos).
   */
  async confirmFromApproval(taskId: string, userId: string): Promise<number> {
    // Defensa en profundidad: revierte cualquier CONFIRMED de APROBACIÓN colgado (carrier
    // legacy pre-H7). NO toca las cargas MANUAL (revertConfirmation las excluye) → preserva
    // la idempotencia por (timeEntryId, entryVersion) del cobro por-carga de H7.
    await this.revertConfirmation(taskId, userId);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { project: { select: { organizationId: true } } },
    });
    if (!task) {
      throw new AppException('La tarea no existe', 'TASK_NOT_FOUND', 404);
    }

    const manuals = await this.prisma.timeEntry.findMany({
      where: { taskId, origin: 'MANUAL', deletedAt: null, minutes: { gt: 0 } },
      select: { id: true, minutes: true, version: true, workedOn: true }, // H8a: + workedOn (fila ya en memoria, cero query extra)
    });

    // Escape H6 (0 h) o tarea sin cargas reales → nada que cobrar (no-op, coherente con approveTask).
    if (manuals.length === 0) {
      this.logger.log(`Aprobación task ${taskId}: sin cargas MANUAL vivas — no descuenta cupo`);
      return 0;
    }

    let totalSeconds = 0;
    for (const m of manuals) {
      const durationSeconds = (m.minutes ?? 0) * 60;
      totalSeconds += durationSeconds;
      this.eventEmitter.emit('time_entry.confirmed', {
        ...domainEvent('time_entry.confirmed', 'time_entry', m.id, task.project.organizationId, userId),
        timeEntryId: m.id,
        taskId,
        duration: durationSeconds,
        legacyMigration: false,
        version: m.version, // H2: clave de idempotencia (id, version) por carga
        workedOn: m.workedOn, // H8a: el emisor es el único que sabe qué TimeEntry originó este confirm
      });
    }

    this.logger.log(
      `Aprobación task ${taskId}: cobradas ${manuals.length} carga(s) MANUAL = ${totalSeconds}s (${(totalSeconds / 3600).toFixed(2)}h)`,
    );
    return totalSeconds;
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

  /**
   * H7 — Reverso de CUPO de las cargas MANUAL cobradas por una aprobación. Se usa al
   * RECHAZAR/REABRIR una tarea que ya cobró (el cobro nace al aprobar; reabrir una tarea
   * DONE es el caso real). Por cada carga MANUAL con cobro VIVO a su version actual (existe
   * una HoursTransaction USAGE/LOAN con timeEntryId+entryVersion), sube la version (habilita
   * re-cobro limpio al re-aprobar) y emite time_entry.reverted con la version VIEJA como
   * clave → onTimeEntryReverted reembolsa ESE cobro exacto. Idempotente: tras revertir, la
   * carga queda a v+1 sin cobro vivo → un 2º llamado es no-op.
   *
   * ALCANCE H7 = SOLO cupo (horas). El reverso del MONTO/plata (REFUND con priceAmount
   * negativo, nota de crédito, no re-facturar) es H9.
   */
  async revertManualCharges(taskId: string, userId: string): Promise<number> {
    const manuals = await this.prisma.timeEntry.findMany({
      where: { taskId, origin: 'MANUAL', deletedAt: null },
      select: {
        id: true,
        version: true,
        duration: true,
        task: { include: { project: { select: { organizationId: true } } } },
      },
    });

    let revertedCount = 0;
    for (const m of manuals) {
      // ¿Tiene cobro VIVO a su version actual? Si no, ya fue revertida o nunca cobró → skip.
      const liveCharge = await this.prisma.hoursTransaction.findFirst({
        where: {
          taskId,
          timeEntryId: m.id,
          entryVersion: m.version,
          type: { in: ['USAGE', 'LOAN'] },
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!liveCharge) continue;

      const oldVersion = m.version;
      await this.prisma.timeEntry.update({
        where: { id: m.id },
        // La carga MANUAL NO vuelve a DRAFT (no es un draft): solo bump de version para que un
        // re-approve cobre con clave nueva (id, v+1) sin chocar el único parcial de la vieja.
        data: { version: { increment: 1 } },
      });

      this.eventEmitter.emit('time_entry.reverted', {
        ...domainEvent('time_entry.reverted', 'time_entry', m.id, m.task.project.organizationId, userId),
        timeEntryId: m.id,
        taskId,
        duration: m.duration,
        entryVersion: oldVersion, // H7: keyea el refund al cobro EXACTO (id, version vieja)
      });
      revertedCount++;
    }

    if (revertedCount > 0) {
      this.logger.log(`Revertidas ${revertedCount} carga(s) MANUAL cobrada(s) para task ${taskId} (cupo devuelto)`);
    }
    return revertedCount;
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
