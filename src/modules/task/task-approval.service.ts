import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TimeEntryStatus } from '@prisma/client';
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
   * Devuelve los datos para el modal OTP antes de aprobar:
   * - originalEstimate (lo que se estimo, inmutable)
   * - currentDraftHours (lo que esta cargado actualmente, en horas con 1 decimal)
   * - hasDraft (true si hay TimeEntry DRAFT preexistente)
   */
  async getApprovalPreview(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        estimatedHours: true,
        originalEstimate: true,
      },
    });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    const draft = await this.prisma.timeEntry.findFirst({
      where: { taskId, status: TimeEntryStatus.DRAFT },
      select: { id: true, duration: true },
    });

    const draftSeconds = draft?.duration ?? 0;
    return {
      task: { id: task.id, title: task.title },
      originalEstimate: task.originalEstimate ?? task.estimatedHours ?? 0,
      currentDraftHours: Math.round((draftSeconds / 3600) * 10) / 10, // 1 decimal
      hasDraft: !!draft,
    };
  }

  /**
   * Aprueba la tarea moviendola a DONE y confirma el TimeEntry DRAFT con las horas
   * confirmadas en el modal OTP. Si no se pasa confirmedHours, se usa la duracion
   * actual del DRAFT (o estimatedHours como fallback).
   */
  async approveTask(
    taskId: string,
    userId: string,
    confirmedHours?: number,
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

    // Resolver duracion final a confirmar:
    // 1. Si el cliente paso confirmedHours en el modal OTP → usar eso.
    // 2. Si no, usar la duracion del DRAFT actual.
    // 3. Si no hay DRAFT, usar estimatedHours como fallback.
    let finalDurationSeconds: number;
    if (confirmedHours !== undefined && confirmedHours !== null) {
      finalDurationSeconds = Math.round(confirmedHours * 3600);
    } else {
      const draft = await this.prisma.timeEntry.findFirst({
        where: { taskId, status: TimeEntryStatus.DRAFT },
        select: { duration: true },
      });
      finalDurationSeconds = draft?.duration ?? Math.round((task.estimatedHours ?? 0) * 3600);
    }

    let escaped = false;
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

    // Confirmar el TimeEntry DRAFT (dispara time_entry.confirmed → HoursListener descuenta
    // cliente). SOLO si NO fue escape: cerrar-sin-horas es 0 h reales → no confirma ni
    // descuenta cupo (CA-22). El resto del flujo H7 (confirmFromApproval) queda intacto.
    if (!escaped) {
      await this.timeEntryService.confirmFromApproval(taskId, finalDurationSeconds, userId);
    }

    this.eventEmitter.emit('task.approval.approved', {
      ...domainEvent('task.approval.approved', 'task', task.id, task.project.organizationId, userId, { taskTitle: task.title, projectId: task.projectId, projectName: task.project.name }),
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      projectName: task.project.name,
      approvedById: userId,
      assigneeIds: task.assignments.map((a: { userId: string }) => a.userId),
      confirmedDurationSeconds: escaped ? 0 : finalDurationSeconds,
      closedWithoutHours: escaped,
    });

    this.logger.log(
      escaped
        ? `Task ${taskId} aprobada SIN horas (cerrada sin horas por ${userId})`
        : `Task ${taskId} aprobada con ${finalDurationSeconds}s confirmados (${(finalDurationSeconds / 3600).toFixed(2)}h)`,
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

    // Si la tarea tenia TimeEntry CONFIRMED (puede pasar si rechazo viene tras una aprobacion previa) → revertir
    await this.timeEntryService.revertConfirmation(taskId, userId);

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
