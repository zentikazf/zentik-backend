import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';

/**
 * H6 — Gate "no cerrar sin horas".
 *
 * Choke point ÚNICO (service-layer) que impide pasar una tarea a IN_REVIEW/DONE
 * (o nacer ahí) sin al menos un TimeEntry con trabajo real. Lo invocan los 6
 * caminos que mueven el estado (updateTask, board move, ticket sync, create/
 * subtask, bulkUpdate, approveTask), porque el path del ticket evade
 * PermissionsGuard y un gate por-endpoint dejaría agujeros.
 *
 * Reglas LEY del dueño:
 *  - La ESTIMACIÓN nunca cuenta como horas reales (es columna de Task, no TimeEntry).
 *  - Es puro guard de lectura + throw ANTES de escribir status: NO confirma, NO
 *    descuenta cupo, NO emite time_entry.confirmed (eso es H7).
 *  - Escape "cerrar sin horas": lo puede usar el ASIGNADO o quien tenga
 *    manage:projects, con MOTIVO obligatorio (AJ-1). Sin permiso nuevo, sin migración.
 *  - El escape queda AUDITADO síncrono/transaccional (AuditLog + system-comment +
 *    domainEvent) — nunca fire-and-forget (el listener de audit traga errores).
 */

/** Contexto del actor que necesita el gate más allá del id (que viaja aparte). */
export interface HoursGateActor {
  id: string;
  name?: string | null;
  email?: string | null;
  permissions?: string[];
}

/** Igual que HoursGateActor pero sin `id` — los services ya reciben `userId` aparte. */
export type HoursGateActorContext = Omit<HoursGateActor, 'id'>;

/** Cliente prisma o transacción — el gate corre tanto suelto como dentro de una tx. */
type PrismaLike = Prisma.TransactionClient | PrismaService;

const GATED_STATUSES: readonly string[] = ['IN_REVIEW', 'DONE'];
const MANAGE_PROJECTS = 'manage:projects';
const WILDCARD = '*:*';

@Injectable()
export class TaskHoursGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** true si el status destino está sujeto al gate de horas (IN_REVIEW | DONE). */
  isGatedStatus(status?: string | null): boolean {
    return !!status && GATED_STATUSES.includes(status);
  }

  /** true si el actor tiene autoridad de proyecto (o wildcard). */
  hasManageProjects(permissions?: string[]): boolean {
    return !!permissions?.some((p) => p === MANAGE_PROJECTS || p === WILDCARD);
  }

  /**
   * ¿Puede el actor "cerrar sin horas"? (AJ-1) asignado a la tarea OR manage:projects.
   * El chequeo de asignado es DB (TaskAssignment); el de permiso es sobre el token.
   */
  async canCloseWithoutHours(
    taskId: string,
    actor: HoursGateActor,
    tx: PrismaLike = this.prisma,
  ): Promise<boolean> {
    if (this.hasManageProjects(actor.permissions)) return true;
    const assigned = await tx.taskAssignment.count({
      where: { taskId, userId: actor.id },
    });
    return assigned > 0;
  }

  /**
   * ¿La tarea tiene ≥1 TimeEntry con trabajo real? Condición conservadora:
   * excluye la estimación (no vive en TimeEntry), SEED y el DRAFT-semilla, y las
   * soft-deleted. Acepta la carga manual H4 y el timer legacy real.
   */
  async hasRealHours(taskId: string, tx: PrismaLike = this.prisma): Promise<boolean> {
    const real = await tx.timeEntry.count({
      where: {
        taskId,
        deletedAt: null, // soft-delete no cuenta
        OR: [
          { minutes: { gt: 0 } }, // carga manual H4 (única vía viva post-H5)
          { origin: 'TIMER', duration: { gt: 0 } }, // timer legacy real
          { origin: null, duration: { gt: 0 } }, // legacy sin origin, con tiempo real
        ],
      },
    });
    return real > 0;
  }

  /**
   * Lanza WORK_HOURS_REQUIRED (409) si la tarea no tiene horas reales. Gate DURO
   * (sin escape): lo usan board move, ticket sync y bulkUpdate. El `details`
   * incluye `canCloseWithoutHours` para que el front sepa si ofrecer el escape
   * (que se ejerce por otro camino: detalle/aprobación).
   */
  async assertHasWorkedHours(
    taskId: string,
    targetStatus: string,
    actor: HoursGateActor,
    tx: PrismaLike = this.prisma,
    currentStatus?: string | null,
  ): Promise<void> {
    if (await this.hasRealHours(taskId, tx)) return;

    const canClose = await this.canCloseWithoutHours(taskId, actor, tx);
    throw new AppException(
      'La tarea no tiene horas reales cargadas. Cargá las horas trabajadas o, si el trabajo fue 0 h, usá "cerrar sin horas".',
      'WORK_HOURS_REQUIRED',
      409,
      {
        taskId,
        currentStatus: currentStatus ?? null,
        targetStatus,
        action: 'LOG_HOURS_OR_CLOSE_WITHOUT',
        logHoursEndpoint: `POST /tasks/${taskId}/time-entries`,
        canCloseWithoutHours: canClose,
      },
    );
  }

  /**
   * H8c — Guard "no revertir facturado". Hermano de assertHasWorkedHours: count de
   * lectura + throw ANTES de escribir el estado. Bloquea reabrir/rechazar una tarea
   * cuyas horas YA se facturaron (billedCycleId != null) — el revert devolvería el cupo
   * (vía REFUND en onTimeEntryReverted) mientras la factura, inmutable en un ciclo
   * cerrado, ya cobró la plata → divergencia invisible. La llave (nota de crédito) es H9;
   * acá va solo el candado. Puro guard de lectura: no escribe, no toca cupo ni plata.
   *
   * Cuenta USAGE/LOAN (los BILLABLE_TYPES); NO cuenta REFUND ni INTERNAL. Excluye las
   * soft-deleted. Lo invocan los 4 caminos que sacan de DONE (updateTask, board move,
   * ticket sync, rejectTask), en paridad con el choke-point de H6.
   */
  async hasBilledHours(taskId: string, tx: PrismaLike = this.prisma): Promise<boolean> {
    const billed = await tx.hoursTransaction.count({
      where: {
        taskId,
        billedCycleId: { not: null },
        type: { in: ['USAGE', 'LOAN'] },
        deletedAt: null,
      },
    });
    return billed > 0;
  }

  /** Lanza TASK_HOURS_BILLED (409) si la tarea tiene ≥1 hora ya facturada. */
  async assertNotBilled(taskId: string, tx: PrismaLike = this.prisma): Promise<void> {
    if (await this.hasBilledHours(taskId, tx)) {
      throw new AppException(
        'Esta tarea ya fue facturada. Para revertirla necesitás emitir una nota de crédito.',
        'TASK_HOURS_BILLED',
        409,
        { taskId },
      );
    }
  }

  /**
   * Gate CON escape para los caminos que sí lo exponen (updateTask, create/
   * subtask, approveTask). Si `closeWithoutHours`:
   *   - valida permiso (asignado || manage:projects) → si no, 403
   *   - valida motivo no vacío → si no, 400
   *   - AUDITA (síncrono en tx) y deja pasar (retorna { escaped:true })
   * Si no, aplica el gate duro (assertHasWorkedHours).
   *
   * DEBE llamarse dentro de la transacción que escribe el status (el audit es
   * transaccional con el cambio de estado).
   */
  async enforce(input: {
    task: { id: string; status: string; title: string; organizationId: string };
    targetStatus: string;
    actor: HoursGateActor;
    closeWithoutHours?: boolean;
    closeWithoutHoursReason?: string;
    tx: Prisma.TransactionClient;
  }): Promise<{ escaped: boolean }> {
    const { task, targetStatus, actor, closeWithoutHours, closeWithoutHoursReason, tx } = input;

    if (closeWithoutHours) {
      const canClose = await this.canCloseWithoutHours(task.id, actor, tx);
      if (!canClose) {
        throw new AppException(
          'No tenés permiso para cerrar la tarea sin horas. Cargá las horas o pedile a un responsable del proyecto (o al asignado) que la cierre.',
          'FORBIDDEN_CLOSE_WITHOUT_HOURS',
          403,
          { taskId: task.id },
        );
      }
      const reason = closeWithoutHoursReason?.trim();
      if (!reason) {
        throw new AppException(
          'Indicá el motivo para cerrar la tarea sin horas.',
          'CLOSE_WITHOUT_HOURS_REASON_REQUIRED',
          400,
          { taskId: task.id },
        );
      }
      await this.auditCloseWithoutHours(tx, task, targetStatus, reason, actor);
      return { escaped: true };
    }

    await this.assertHasWorkedHours(task.id, targetStatus, actor, tx, task.status);
    return { escaped: false };
  }

  /**
   * Auditoría del escape en 3 capas, SÍNCRONA/transaccional (RF-11/RF-12). El
   * AuditListener es fire-and-forget y traga errores → compliance no puede
   * perderse: se escribe con el mismo `tx` del cambio de estado. El domainEvent
   * (#3) queda solo para el feed en vivo (best-effort). El aviso al PM se muestra
   * en H7 (AJ-3): acá solo dejamos el dato listo.
   */
  private async auditCloseWithoutHours(
    tx: Prisma.TransactionClient,
    task: { id: string; status: string; title: string; organizationId: string },
    targetStatus: string,
    reason: string,
    actor: HoursGateActor,
  ): Promise<void> {
    // 1) AuditLog síncrono (organizationId OBLIGATORIO o el listener lo descartaría)
    await tx.auditLog.create({
      data: {
        organizationId: task.organizationId,
        userId: actor.id,
        action: 'task.closed_without_hours',
        resource: 'task',
        resourceId: task.id,
        newData: {
          reason,
          previousStatus: task.status,
          newStatus: targetStatus,
          taskTitle: task.title,
          confirmedZeroHours: true,
        },
      },
    });

    // 2) System comment en el timeline de la tarea (mismo patrón que rejectTask)
    await tx.comment.create({
      data: {
        taskId: task.id,
        userId: actor.id,
        isSystem: true,
        content: `Tarea cerrada sin horas por ${actor.name ?? actor.email ?? 'un usuario'}: ${reason}`,
      },
    });

    // 3) domainEvent para el activity feed (best-effort, redundante con el AuditLog)
    this.eventEmitter.emit(
      'task.closed_without_hours',
      domainEvent('task.closed_without_hours', 'task', task.id, task.organizationId, actor.id, {
        reason,
        previousStatus: task.status,
        newStatus: targetStatus,
        confirmedZeroHours: true,
      }),
    );
  }
}
