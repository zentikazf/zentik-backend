import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException, TaskNotFoundException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';
import { TimeEntryService } from '../time-tracking/time-tracking.service';
import {
  TaskHoursGuardService,
  HoursGateActorContext,
} from './task-hours-guard.service';

@Injectable()
export class TaskApprovalService {
  private readonly logger = new Logger(TaskApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly timeEntryService: TimeEntryService,
    private readonly hoursGuard: TaskHoursGuardService,
  ) {}

  /**
   * H7 — Datos para el modal de aprobación. La fuente de verdad son las cargas
   * MANUALES vivas (origin='MANUAL', deletedAt=null, minutes>0):
   * - realHours / realMinutes: suma real cargada (lo que se va a cobrar).
   * - entries: desglose read-only (una fila por carga: minutos · fecha · usuario).
   * - hasManualHours: hay al menos una carga real.
   * - originalEstimate: SOLO referencia informativa (varianza), NUNCA el monto.
   * - closedWithoutHours (AJ-3): si la tarea llegó a IN_REVIEW por el escape H6
   *   (cerrada sin horas), el motivo/actor leídos del AuditLog ya persistido.
   */
  async getApprovalPreview(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        projectId: true,
        estimatedHours: true,
        originalEstimate: true,
      },
    });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    // NÚCLEO H7: horas reales = suma de las cargas MANUAL vivas (no la estimación).
    const manuals = await this.prisma.timeEntry.findMany({
      where: { taskId, origin: 'MANUAL', deletedAt: null, minutes: { gt: 0 } },
      select: {
        id: true,
        minutes: true,
        workedOn: true,
        user: { select: { id: true, name: true } },
      },
      orderBy: { workedOn: 'asc' },
    });
    const realMinutes = manuals.reduce((sum, e) => sum + (e.minutes ?? 0), 0);
    const realHours = Math.round((realMinutes / 60) * 10) / 10; // 1 decimal

    // AJ-3: cierre-sin-horas ya auditado por H6 (task-hours-guard.service.ts). Solo lo leemos.
    const closedLog = await this.prisma.auditLog.findFirst({
      where: { resource: 'task', resourceId: taskId, action: 'task.closed_without_hours' },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true, email: true } } },
    });

    return {
      task: { id: task.id, title: task.title, projectId: task.projectId },
      originalEstimate: task.originalEstimate ?? task.estimatedHours ?? 0,
      realHours,
      realMinutes,
      hasManualHours: manuals.length > 0,
      entries: manuals.map((e) => ({
        minutes: e.minutes ?? 0,
        workedOn: e.workedOn,
        userId: e.user?.id ?? null,
        userName: e.user?.name ?? null,
      })),
      // AJ-3 SOLO si no hay horas reales: si se cargaron horas después del cierre-sin-horas
      // (reabrir → cargar → volver a IN_REVIEW), el aviso quedó obsoleto y se aprueba con las
      // horas reales, no 0 h. Evita mostrar dato contradictorio (banner + desglose a la vez).
      closedWithoutHours:
        closedLog && manuals.length === 0
          ? {
              by: closedLog.user?.name ?? closedLog.user?.email ?? 'un usuario',
              reason: (closedLog.newData as any)?.reason ?? null,
              at: closedLog.createdAt,
            }
          : null,
    };
  }

  /**
   * H7 — Aprueba la tarea (→DONE) y cobra las horas MANUALES reales cargadas.
   * confirmFromApproval barre las cargas origin='MANUAL' vivas y descuenta cupo con
   * ESE total (sin entradas sintéticas ni estimación). Si es escape H6
   * (closeWithoutHours) no cobra nada (0 h). El modal ya NO manda confirmedHours.
   */
  async approveTask(
    taskId: string,
    userId: string,
    opts?: {
      closeWithoutHours?: boolean;
      closeWithoutHoursReason?: string;
      actor?: HoursGateActorContext;
    },
  ) {
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

    // H7: el monto a cobrar NO viene del modal ni de la estimación — sale de las
    // cargas MANUAL reales (confirmFromApproval las suma). El total efectivamente
    // cobrado se captura abajo para el evento task.approval.approved.
    let escaped = false;
    let confirmedSeconds = 0;
    const updated = await this.prisma.$transaction(async (tx) => {
      // H6: gate de horas — no aprobar (→DONE) sin horas reales, salvo escape auditado
      // (asignado o manage:projects + motivo). Defensa en profundidad: la task pudo
      // llegar a IN_REVIEW por un camino previo a H6 o que lo evadió.
      const gate = await this.hoursGuard.enforce({
        task: {
          id: taskId,
          status: task.status,
          title: task.title,
          organizationId: task.project.organizationId,
        },
        targetStatus: 'DONE',
        actor: { id: userId, ...opts?.actor },
        closeWithoutHours: opts?.closeWithoutHours,
        closeWithoutHoursReason: opts?.closeWithoutHoursReason,
        tx,
      });
      escaped = gate.escaped;

      const result = await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'DONE',
          endDate: task.endDate ?? new Date(),
          ...(deployColumn && { boardColumnId: deployColumn.id }),
        },
      });
      return result;
    });

    // H7: cobrar las horas MANUALES reales (un time_entry.confirmed por carga viva →
    // HoursListener descuenta cupo con el total real). SOLO si NO fue escape:
    // cerrar-sin-horas es 0 h → no cobra (CA-6/CA-22). confirmFromApproval devuelve el
    // total en segundos efectivamente cobrado.
    if (!escaped) {
      confirmedSeconds = await this.timeEntryService.confirmFromApproval(taskId, userId);
    }

    this.eventEmitter.emit('task.approval.approved', {
      ...domainEvent('task.approval.approved', 'task', task.id, task.project.organizationId, userId, { taskTitle: task.title, projectId: task.projectId, projectName: task.project.name }),
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      projectName: task.project.name,
      approvedById: userId,
      assigneeIds: task.assignments.map((a: { userId: string }) => a.userId),
      confirmedDurationSeconds: confirmedSeconds,
      closedWithoutHours: escaped,
    });

    this.logger.log(
      escaped
        ? `Task ${taskId} aprobada SIN horas (cerrada sin horas por ${userId})`
        : `Task ${taskId} aprobada con ${confirmedSeconds}s reales cobrados (${(confirmedSeconds / 3600).toFixed(2)}h)`,
    );

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

    // Si la tarea tenía cobro vivo (puede pasar si el rechazo viene tras una aprobación
    // previa que la devolvió a IN_REVIEW): revertir el carrier legacy Y las cargas MANUAL
    // cobradas en H7. Ambas son no-op si no hay cobro vivo (rechazo normal, aún sin cobrar).
    await this.timeEntryService.revertConfirmation(taskId, userId);
    await this.timeEntryService.revertManualCharges(taskId, userId);

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
