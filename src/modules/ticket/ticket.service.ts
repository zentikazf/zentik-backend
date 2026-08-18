import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Prisma,
  TicketStatus,
  TaskStatus,
  TicketCloseReason,
  TicketCriticality,
  SlaSource,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateAdminTicketDto } from './dto/create-admin-ticket.dto';
import { CloseTicketDto } from './dto/close-ticket.dto';
import { ListTicketsQueryDto, SlaOutcome } from './dto/list-tickets-query.dto';
import { CreateCategoryConfigDto, UpdateCategoryConfigDto } from './dto/create-category-config.dto';
import { UpsertSlaConfigDto } from './dto/upsert-sla-config.dto';
import { UpsertBusinessHoursDto } from './dto/upsert-business-hours.dto';
import { ReclassifyTicketDto } from './dto/reclassify-ticket.dto';
import { domainEvent } from '../../common/events/domain-event.helper';
import { calculateBusinessDeadline, parseBusinessDays } from '../sla/sla.util';
import { TicketEventsService } from './ticket-events.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService } from '../sync/outbox.service';
import {
  TaskHoursGuardService,
  HoursGateActorContext,
} from '../task/task-hours-guard.service';
import { TicketClassificationGuardService } from './ticket-classification-guard.service';
import { SlaResolverService } from '../sla/sla-resolver.service';

/**
 * Generates a sequential ticket number per org: YYYYMMDD-NNN
 */
export async function generateTicketNumber(
  tx: {
    ticket: {
      count: (args: any) => Promise<number>;
      findFirst: (args: any) => Promise<any>;
    };
  },
  organizationId: string,
): Promise<string> {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000);

  const countToday = await tx.ticket.count({
    where: {
      organizationId,
      createdAt: { gte: startOfDay, lt: endOfDay },
    },
  });

  for (let offset = 0; offset < 10; offset++) {
    const candidate = `${dateStr}-${String(countToday + 1 + offset).padStart(3, '0')}`;
    const exists = await tx.ticket.findFirst({
      where: { organizationId, ticketNumber: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;
  }

  throw new Error(
    `No se pudo generar un numero de ticket unico para la organizacion ${organizationId}`,
  );
}

/**
 * Escapa un valor para que pueda ir en una celda CSV.
 * Regla RFC 4180: si el valor contiene coma, comilla doble o newline,
 * lo envolvemos en comillas dobles y duplicamos las comillas internas.
 * Valores vacios o sin caracteres especiales se devuelven tal cual.
 */
function csvEscape(value: string): string {
  if (value === '' || value === null || value === undefined) return '';
  const needsQuoting = /[",\r\n]/.test(value);
  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

// ─── State machine: transiciones válidas del ticket ────────────────────
// Feature #43: 4 estados vivos — OPEN (Nuevo) / IN_PROGRESS (En curso) /
// RESOLVED (Resuelto) / CLOSED (Cancelado). CLOSED se reutiliza como
// «Cancelado» y su ÚNICA puerta de entrada es la acción dedicada
// closeTicket() (comentario obligatorio); el PATCH genérico lo rechaza.
// IN_REVIEW queda como TOMBSTONE: se retiró del ciclo (la revisión vive en
// la task del kanban — resolver el ticket manda la task a IN_REVIEW y la
// aprobación del PM la completa). Los históricos en IN_REVIEW conservan
// solo transiciones de salida para drenarse. Desde RESOLVED no se cancela
// (ya está entregado): se reabre a IN_PROGRESS primero. CLOSED → OPEN es
// la reapertura manual de una cancelación (vuelve al inicio del ciclo).
// Ver specs/ticket-lifecycle-estados-cierre-honesto/{requirements,design}.md.
const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN:        ['IN_PROGRESS', 'CLOSED'],
  IN_PROGRESS: ['RESOLVED', 'OPEN', 'CLOSED'],
  IN_REVIEW:   ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED:    ['IN_PROGRESS'],
  CLOSED:      ['OPEN'],
};

// ─── Reclasificación interna (feature #42 — Fase 2) ────────────────────
/** Un campo de clasificación que cambió, ya legible para el timeline. */
export interface ClassificationChange {
  field: 'ticketTypeId' | 'criticality' | 'categoryConfigId';
  label: string;
  from: string | null;
  to: string;
}

/**
 * Proyección devuelta por `reclassify`: solo la clasificación + los campos de SLA
 * que quedan CONGELADOS (van en la respuesta justamente para que el front pueda
 * verificar que no se movieron).
 *
 * `reportedTicketType` / `reportedCriticality` viajan por el mismo motivo: son la
 * declaración del cliente y tienen que verse IGUALES antes y después de
 * reclasificar (#42 Fase 2.1).
 */
const TICKET_CLASSIFICATION_SELECT = {
  id: true,
  ticketTypeId: true,
  criticality: true,
  categoryConfigId: true,
  responseDeadline: true,
  resolutionDeadline: true,
  slaPolicyId: true,
  slaSource: true,
  reportedCriticality: true,
  ticketType: { select: { id: true, name: true } },
  reportedTicketType: { select: { id: true, name: true } },
  categoryConfig: { select: { id: true, name: true, criticality: true } },
} satisfies Prisma.TicketSelect;

/**
 * Clasificación del ticket para el panel interno (#42 Fase 2.1).
 *
 * Única fuente del bloque que antes estaba COPIADO en los 4 puntos que alimentan
 * el panel (listado de la org, tickets del proyecto, detalle y respuesta del alta):
 * agregar un campo de clasificación en uno solo y olvidarse de los otros tres era
 * el bug esperando a pasar. Los escalares (`criticality`, `reportedCriticality`,
 * `slaSource`, `ticketTypeId`…) los trae el `include` sin declararlos.
 *
 * - `ticketType`: lo que el equipo tipificó.
 * - `reportedTicketType`: lo que declaró el cliente al crear (congelado).
 * - `slaPolicy`: qué política se aplicó y con qué plazos, junto con `slaSource`
 *   (en qué paso de la cascada se detuvo) → badge "por contrato" / "por criticidad".
 * - `categoryConfig`: categoría interna del equipo.
 */
const TICKET_CLASSIFICATION_INCLUDE = {
  ticketType: { select: { id: true, name: true } },
  reportedTicketType: { select: { id: true, name: true } },
  slaPolicy: {
    select: {
      id: true,
      name: true,
      criticality: true,
      firstResponseHours: true,
      resolutionHours: true,
    },
  },
  categoryConfig: { select: { id: true, name: true, criticality: true } },
} satisfies Prisma.TicketInclude;

// ─── Mapping: estado del ticket → estado del task en kanban ────────────
function mapTicketStatusToTaskStatus(
  ticketStatus: TicketStatus,
  hasAssignee: boolean,
): TaskStatus {
  switch (ticketStatus) {
    case 'OPEN':
      return hasAssignee ? 'TODO' : 'BACKLOG';
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'IN_REVIEW':
      return 'IN_REVIEW';
    case 'RESOLVED':
      // H6/AJ-2: resolver un ticket lleva la task a REVISIÓN, nunca directo a
      // completado. El gate de horas aplica antes de IN_REVIEW (resolver exige
      // horas o el escape); el cobro se consolida recién en la aprobación
      // (IN_REVIEW→DONE), no al resolver. Antes esto mapeaba a DONE.
      return 'IN_REVIEW';
    case 'CLOSED':
      return 'DONE';
  }
}

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly events: TicketEventsService,
    private readonly config: AppConfigService,
    private readonly outbox: OutboxService,
    private readonly hoursGuard: TaskHoursGuardService,
    // Feature #42 — Fase 1: solo se usa con `SLA_CASCADE_ENABLED=true`.
    private readonly slaResolver: SlaResolverService,
    // Feature #44: candado "no resolver sin tipificar" (updateTicket + sync).
    private readonly classificationGuard: TicketClassificationGuardService,
  ) {}

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────

  private validateStatusTransition(from: TicketStatus, to: TicketStatus) {
    if (from === to) return;
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new AppException(
        `Transicion invalida: ${from} → ${to}`,
        'INVALID_STATUS_TRANSITION',
        400,
        { from, to, allowed },
      );
    }
  }

  /**
   * Move task to the column matching the given mapped status (within same project).
   * No-op if task already on a column with that mappedStatus.
   * Also updates task.status and emits 'task.moved' with a sync flag to prevent loops.
   */
  private async syncTaskToStatus(
    tx: Prisma.TransactionClient,
    taskId: string,
    targetStatus: TaskStatus,
    userId: string,
    organizationId: string,
    actorPermissions?: string[],
  ) {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        status: true,
        projectId: true,
        boardColumnId: true,
        startDate: true,
        endDate: true,
        title: true,
        type: true,
        estimatedHours: true,
        createdAt: true,
      },
    });
    if (!task) return null;

    if (task.status === targetStatus) return task;

    // H6: gate de horas — sincronizar el ticket a IN_REVIEW/DONE exige horas reales
    // en la task. Gate DURO: el ticket no expone el escape (Soporte carga horas al
    // resolver, o el 0h legítimo lo cierra el asignado/PM desde el detalle de la
    // tarea). Corre dentro de la MISMA tx: si lanza, se revierte también el cambio
    // de estado del ticket (RF-3). Este es el path más evasivo (escribe status crudo
    // y el TicketController no tiene PermissionsGuard) → el gate en service es imprescindible.
    if (this.hoursGuard.isGatedStatus(targetStatus)) {
      await this.hoursGuard.assertHasWorkedHours(
        task.id,
        targetStatus as string,
        { id: userId, permissions: actorPermissions },
        tx,
        task.status,
      );
    }

    // H8c: paridad task↔ticket — bloquear reapertura vía sync de ticket (salir de DONE)
    // si la tarea tiene horas ya facturadas. Corre en la MISMA tx: si lanza, revierte
    // también el cambio de estado del ticket (RF-3). Cierra la ventana lateral del portal.
    if (task.status === 'DONE' && targetStatus !== 'DONE') {
      await this.hoursGuard.assertNotBilled(task.id, tx);
    }

    const targetColumn = await tx.boardColumn.findFirst({
      where: {
        mappedStatus: targetStatus,
        board: { projectId: task.projectId },
      },
      orderBy: { position: 'asc' },
    });

    const updateData: Prisma.TaskUpdateInput = { status: targetStatus };
    if (targetColumn) {
      updateData.boardColumn = { connect: { id: targetColumn.id } };
    }
    if (targetStatus === 'IN_PROGRESS' && !task.startDate) {
      updateData.startDate = new Date();
    }
    if (targetStatus === 'DONE' && !task.endDate) {
      updateData.endDate = new Date();
    }

    const updated = await tx.task.update({
      where: { id: task.id },
      data: updateData,
    });

    // Emit task.moved INSIDE the transaction-aware code path but AFTER tx commits
    // (we attach to the queue to be flushed by the caller)
    this.pendingEvents.push(() => {
      this.eventEmitter.emit('task.moved', {
        ...domainEvent('task.moved', 'task', task.id, organizationId, userId),
        task: updated,
        previousColumnId: task.boardColumnId,
        targetColumnId: targetColumn?.id ?? task.boardColumnId,
        previousStatus: task.status,
        newStatus: targetStatus,
        userId,
        // Loop guard: this move was triggered by the ticket sync, not by the user
        metadata: { fromTicketSync: true },
      });

      // Hours deduction / reverse for SUPPORT tasks
      if (targetStatus === 'DONE' && task.status !== 'DONE') {
        this.eventEmitter.emit('task.completed', {
          ...domainEvent('task.completed', 'task', task.id, organizationId, userId, { title: task.title, projectId: task.projectId }),
          taskId: task.id,
          taskTitle: task.title,
          completedById: userId,
          projectId: task.projectId,
          task: { ...updated, type: task.type, projectId: task.projectId, createdAt: task.createdAt, estimatedHours: task.estimatedHours },
        });
      }
      if (task.status === 'DONE' && targetStatus !== 'DONE') {
        this.eventEmitter.emit('task.reopened', {
          ...domainEvent('task.reopened', 'task', task.id, organizationId, userId, { title: task.title, projectId: task.projectId }),
          task: { ...updated, type: task.type, projectId: task.projectId },
        });
      }
    });

    return updated;
  }

  // Per-call queue to flush events after a transaction commits.
  // (instance-level OK because methods are awaited end-to-end)
  private pendingEvents: Array<() => void> = [];
  private flushPendingEvents() {
    const queue = this.pendingEvents;
    this.pendingEvents = [];
    for (const emit of queue) {
      try {
        emit();
      } catch (err) {
        this.logger.error('Error flushing pending event', err as Error);
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Listing / Stats
  // ────────────────────────────────────────────────────────────

  async getOpenTicketsCount(orgId: string) {
    const count = await this.prisma.ticket.count({
      where: { organizationId: orgId, status: 'OPEN' },
    });
    return { count };
  }

  async getTicketStats(orgId: string) {
    const grouped = await this.prisma.ticket.groupBy({
      by: ['status'],
      where: { organizationId: orgId },
      _count: { _all: true },
    });

    const base: Record<TicketStatus | 'TOTAL', number> = {
      OPEN: 0,
      IN_PROGRESS: 0,
      IN_REVIEW: 0,
      RESOLVED: 0,
      CLOSED: 0,
      TOTAL: 0,
    };

    for (const row of grouped) {
      base[row.status] = row._count._all;
      base.TOTAL += row._count._all;
    }

    return base;
  }

  /**
   * Builder del where Prisma para el listing de tickets de la organizacion.
   * Reutilizado por getOrgTickets (paginado) y exportCsv (sin paginar).
   *
   * Overshoot (feature #12): el filtro usa la columna generada de Postgres
   * overshoot_minutes (campo escalar overshootMinutes) directamente — Prisma
   * filtra/ordena/cuenta nativo y el COUNT es exacto. Reemplaza el post-filtro
   * en memoria (filterByOvershoot, eliminado). El bucket del frontend se traduce
   * a [gte, lt) en el DTO (overshootMinGte/overshootMaxLt).
   */
  private buildOrgTicketsWhere(orgId: string, query: ListTicketsQueryDto): Prisma.TicketWhereInput {
    const where: Prisma.TicketWhereInput = {
      organizationId: orgId,
      ...(query.status && { status: query.status as TicketStatus }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(query.projectId && { projectId: query.projectId }),
      ...(query.createdByUserId && { createdByUserId: query.createdByUserId }),
      ...(query.categoryConfigId && { categoryConfigId: query.categoryConfigId }),
      ...(query.assigneeId && {
        task: { assignments: { some: { userId: query.assigneeId } } },
      }),
      ...(query.search && {
        OR: [
          { title: { contains: query.search, mode: 'insensitive' as const } },
          { id: { contains: query.search, mode: 'insensitive' as const } },
          { ticketNumber: { contains: query.search, mode: 'insensitive' as const } },
        ],
      }),
      ...(query.criticality && query.criticality.length > 0 && {
        criticality: { in: query.criticality },
      }),
      ...(query.category && query.category.length > 0 && {
        category: { in: query.category },
      }),
      ...((query.resolvedFrom || query.resolvedTo) && {
        resolvedAt: {
          ...(query.resolvedFrom && { gte: new Date(query.resolvedFrom) }),
          ...(query.resolvedTo && { lte: new Date(query.resolvedTo) }),
        },
      }),
    };

    // slaOutcome → cláusulas sobre flags + deadlines.
    // Las reglas se alinean con classifySlaOutcome (sla.util.ts).
    //
    // Cada desenlace se arma como una cláusula AUTOCONTENIDA y se combinan con OR
    // dentro de un `AND`. Dos motivos:
    //  1. El panel deja marcar varios desenlaces a la vez (antes: 400).
    //  2. `COMPLIED` escribía en `where.OR`, que es el MISMO array que usa el
    //     buscador. Con búsqueda + COMPLIED las cláusulas se mezclaban en un solo
    //     OR: "titulo coincide O id coincide O tiene deadline" → el buscador
    //     quedaba anulado y aparecían tickets que no coincidían con el texto.
    //     Metiéndolo en `AND` los dos filtros vuelven a ser independientes.
    if (query.slaOutcome?.length) {
      const clauseFor = (outcome: SlaOutcome): Prisma.TicketWhereInput => {
        switch (outcome) {
          case 'COMPLIED':
            // Sin breaches Y al menos una deadline definida Y status RESOLVED.
            return {
              slaResponseBreached: false,
              slaResolutionBreached: false,
              status: 'RESOLVED',
              OR: [{ responseDeadline: { not: null } }, { resolutionDeadline: { not: null } }],
            };
          case 'BREACHED_RESPONSE':
            return { slaResponseBreached: true, slaResolutionBreached: false };
          case 'BREACHED_RESOLUTION':
            return { slaResponseBreached: false, slaResolutionBreached: true };
          case 'BREACHED_BOTH':
            return { slaResponseBreached: true, slaResolutionBreached: true };
          case 'NO_SLA':
            return { responseDeadline: null, resolutionDeadline: null };
          default:
            return {};
        }
      };
      const clauses = query.slaOutcome.map(clauseFor);
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        clauses.length === 1 ? clauses[0] : { OR: clauses },
      ];
    }

    // Overshoot (feature #12): filtro nativo sobre la columna generada
    // overshoot_minutes. Es un campo escalar (AND implicito) → no pisa where.OR
    // de slaOutcome/search ni where.status. NULL queda excluido por el gte.
    if (query.overshootMinGte != null) {
      where.overshootMinutes = {
        gte: query.overshootMinGte,
        ...(query.overshootMaxLt != null && { lt: query.overshootMaxLt }),
      };
    }

    return where;
  }

  /**
   * Helper para armar el orderBy del listing y export CSV segun los params
   * sortBy / sortOrder del DTO. Mantiene default historico (createdAt DESC + id DESC)
   * cuando no se especifica. Para resolvedAt usa nulls last asi tickets sin
   * resolver no bloquean el orden cuando se mezclan estados.
   */
  private buildOrderBy(
    sortBy: 'createdAt' | 'resolvedAt' | 'priority' | 'overshoot' | undefined,
    sortOrder: 'asc' | 'desc' | undefined,
  ): Prisma.TicketOrderByWithRelationInput[] {
    const direction: 'asc' | 'desc' = sortOrder ?? 'desc';
    if (!sortBy || sortBy === 'createdAt') {
      return [{ createdAt: direction }, { id: 'desc' }];
    }
    if (sortBy === 'resolvedAt') {
      // nulls last asi RESOLVED-with-date aparece primero. Tickets sin resolvedAt
      // (otros tabs) quedan al final.
      return [{ resolvedAt: { sort: direction, nulls: 'last' } }, { id: 'desc' }];
    }
    if (sortBy === 'priority') {
      return [{ priority: direction }, { createdAt: 'desc' }, { id: 'desc' }];
    }
    // overshoot (feature #12): orden nativo por la columna generada
    // overshoot_minutes. nulls:'last' deja los tickets sin overshoot (no resueltos
    // o sin deadline) al final. Antes era un proxy con resolutionDeadline.
    return [{ overshootMinutes: { sort: direction, nulls: 'last' } }, { id: 'desc' }];
  }

  /**
   * Exporta tickets de la organizacion a CSV (UTF-8).
   * Reusa el where builder de getOrgTickets — SIN paginacion para entregar
   * el set completo. El filtro de overshoot ya va dentro del where (columna
   * generada overshoot_minutes, feature #12); no se filtra en memoria.
   * 13 columnas en orden exacto (ver design.md feature #10 R24).
   *
   * Volumen objetivo: <500 tickets/mes/org. Carga en memoria OK.
   */
  async exportTicketsCsv(orgId: string, query: ListTicketsQueryDto): Promise<Buffer> {
    const where = this.buildOrgTicketsWhere(orgId, query);

    const rows = await this.prisma.ticket.findMany({
      where,
      select: {
        ticketNumber: true,
        title: true,
        category: true,
        criticality: true,
        status: true,
        createdAt: true,
        firstResponseAt: true,
        resolvedAt: true,
        resolutionDeadline: true,
        responseDeadline: true,
        closeReason: true,
        client: { select: { name: true } },
        project: { select: { name: true } },
      },
      orderBy: this.buildOrderBy(query.sortBy ?? 'resolvedAt', query.sortOrder),
    });

    const headers = [
      'ticketNumber',
      'title',
      'client',
      'project',
      'category',
      'criticality',
      'status',
      'createdAt',
      'firstResponseAt',
      'resolvedAt',
      'responseOvershoot',
      'resolutionOvershoot',
      'closeReason',
    ];

    const lines: string[] = [headers.join(',')];

    for (const t of rows) {
      const responseOvershoot = t.firstResponseAt && t.responseDeadline
        ? Math.max(0, Math.floor((t.firstResponseAt.getTime() - t.responseDeadline.getTime()) / 60000))
        : '';
      const resolutionOvershoot = t.resolvedAt && t.resolutionDeadline
        ? Math.max(0, Math.floor((t.resolvedAt.getTime() - t.resolutionDeadline.getTime()) / 60000))
        : '';

      const cols: Array<string | number> = [
        t.ticketNumber ?? '',
        t.title ?? '',
        t.client?.name ?? '',
        t.project?.name ?? '',
        t.category ?? '',
        t.criticality ?? '',
        t.status ?? '',
        t.createdAt ? t.createdAt.toISOString() : '',
        t.firstResponseAt ? t.firstResponseAt.toISOString() : '',
        t.resolvedAt ? t.resolvedAt.toISOString() : '',
        responseOvershoot,
        resolutionOvershoot,
        t.closeReason ?? '',
      ];

      lines.push(cols.map((v) => csvEscape(String(v))).join(','));
    }

    // CRLF entre filas para compatibilidad con Excel en Windows.
    const csv = lines.join('\r\n');
    // BOM UTF-8 (U+FEFF) para que Excel detecte el encoding correctamente
    // y muestre tildes / caracteres especiales (clientes "Soluciones S.A." etc).
    return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(csv, 'utf8')]);
  }

  async getOrgTickets(orgId: string, query: ListTicketsQueryDto) {
    const limit = Math.min(query.limit ?? 20, 50);
    const page = Math.max(query.page ?? 1, 1);
    const where = this.buildOrgTicketsWhere(orgId, query);

    // Paginacion offset (feature #12). El filtro de overshoot ya esta resuelto
    // en el where (columna generada overshoot_minutes) → el COUNT es exacto y
    // no hace falta el buffer ni el reslicing en memoria que usaba el cursor.
    const skip = (page - 1) * limit;
    const take = limit;

    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        skip,
        take,
        include: {
          client: { select: { id: true, name: true, email: true } },
          project: { select: { id: true, name: true, slug: true } },
          task: {
            select: {
              id: true,
              title: true,
              status: true,
              boardColumn: { select: { id: true, name: true, color: true, mappedStatus: true } },
              assignments: {
                include: { user: { select: { id: true, name: true, email: true, image: true } } },
              },
            },
          },
          channel: { select: { id: true, name: true, _count: { select: { messages: true } } } },
          ...TICKET_CLASSIFICATION_INCLUDE,
          createdByUser: { select: { id: true, name: true } },
        },
        orderBy: this.buildOrderBy(query.sortBy, query.sortOrder),
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
      },
    };
  }

  async getProjectTickets(projectId: string) {
    return this.prisma.ticket.findMany({
      where: { projectId },
      include: {
        client: { select: { id: true, name: true, email: true } },
        task: {
          select: {
            id: true,
            title: true,
            status: true,
            boardColumn: { select: { id: true, name: true, color: true, mappedStatus: true } },
            assignments: {
              include: { user: { select: { id: true, name: true, image: true } } },
            },
          },
        },
        channel: { select: { id: true, name: true, _count: { select: { messages: true } } } },
        ...TICKET_CLASSIFICATION_INCLUDE,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTicketDetail(ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        client: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true, slug: true } },
        task: {
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            boardColumn: { select: { id: true, name: true, color: true, mappedStatus: true } },
            assignments: {
              include: { user: { select: { id: true, name: true, email: true, image: true } } },
            },
          },
        },
        channel: {
          select: { id: true, name: true, _count: { select: { messages: true } } },
        },
        ...TICKET_CLASSIFICATION_INCLUDE,
        createdByUser: { select: { id: true, name: true } },
        closedByUser: { select: { id: true, name: true } },
      },
    });

    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    return ticket;
  }

  async getTicketEvents(ticketId: string) {
    const exists = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true } });
    if (!exists) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }
    return this.events.listByTicket(ticketId);
  }

  // ────────────────────────────────────────────────────────────
  // Update (status + asignación + sync con kanban)
  // ────────────────────────────────────────────────────────────

  async updateTicket(ticketId: string, dto: UpdateTicketDto, userId: string, actor?: HoursGateActorContext) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        task: {
          select: {
            id: true,
            status: true,
            projectId: true,
            // #52: `orderBy` explícito. El ticket es single-assignee y todo el
            // módulo lee `assignments[0]`, pero la task de un ticket ES una task
            // normal del kanban y ESA acepta varios asignados (PATCH /tasks con
            // `assigneeIds`). Sin orden, Postgres devuelve el heap como quiera y
            // "el responsable" del ticket podía cambiar entre dos lecturas de la
            // misma fila — con eso, la decisión de encolar de más abajo se volvía
            // no determinística.
            assignments: { select: { userId: true }, orderBy: { userId: 'asc' } },
          },
        },
      },
    });
    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    const wantsStatus = dto.status !== undefined && dto.status !== ticket.status;
    const wantsAssignee = dto.assigneeId !== undefined;
    const wantsNotes = dto.adminNotes !== undefined;

    // #43: CLOSED = «Cancelado» y su única puerta es la acción dedicada
    // «Cancelar ticket» (POST /tickets/:ticketId/close), que exige el
    // comentario obligatorio. El PATCH genérico no lo trae → 400 apuntando
    // a la acción. Candado en el service, no solo en la UI.
    if (wantsStatus && dto.status === 'CLOSED') {
      throw new AppException(
        'Para cancelar un ticket usá la acción "Cancelar ticket" (POST /tickets/:ticketId/close) — el comentario es obligatorio.',
        'TICKET_CANCEL_REQUIRES_ACTION',
        400,
      );
    }

    // #43: IN_REVIEW se retiró del ciclo de vida del ticket (la revisión vive
    // en la task del kanban). ALLOWED_TRANSITIONS ya no lo ofrece como destino;
    // este guard es defensa en profundidad para cualquier caller nuevo, con un
    // error explícito en vez del genérico de transición inválida.
    if (wantsStatus && dto.status === 'IN_REVIEW') {
      throw new AppException(
        'El estado "En revisión" fue retirado del ciclo de vida del ticket.',
        'TICKET_STATUS_RETIRED',
        400,
      );
    }

    if (wantsStatus) {
      this.validateStatusTransition(ticket.status, dto.status as TicketStatus);
    }

    const previousAssigneeId = ticket.task?.assignments[0]?.userId ?? null;
    const previousStatus = ticket.status;
    const newStatus = (dto.status as TicketStatus) ?? ticket.status;

    // Determine the effective assigneeId AFTER this update for kanban mapping
    let effectiveAssigneeId: string | null = previousAssigneeId;
    if (wantsAssignee) {
      effectiveAssigneeId = dto.assigneeId ?? null;
    }

    // #52 (R3.1): ¿cambió de verdad el responsable? `dto.assigneeId` llega como
    // `null` O como `''` y los DOS significan desasignar (así lo trata el bloque de
    // asignación de la tx, más abajo). Comparar el valor crudo contra
    // `previousAssigneeId` daría "cambió" para un `''` sobre un ticket que ya estaba
    // sin responsable, y encolaría una fila que el dispatcher solo puede skipear.
    // `effectiveAssigneeId` NO sirve para esto: conserva el `''` a propósito, porque
    // su único consumidor es el `!!effectiveAssigneeId` del mapeo de kanban.
    const nextAssigneeId = wantsAssignee
      ? dto.assigneeId === '' || dto.assigneeId === undefined
        ? null
        : dto.assigneeId
      : previousAssigneeId;
    // ⚠️ El `> 1` NO es defensivo, es un caso real. La task de un ticket es una
    // task normal del kanban y esa acepta VARIOS asignados (PATCH /tasks con
    // `assigneeIds`), mientras que el ticket es single-assignee: el bloque de
    // asignación de la tx hace `deleteMany` de TODOS y crea UNO. Con la task en
    // [U1, U2] y un PATCH que fija U2, comparar sólo `assignments[0]` podía dar
    // "no cambió" —si U2 salía primero— y no encolar, cuando en realidad U1 acaba
    // de perder el ticket y OSD se queda con él para siempre. Colapsar N
    // responsables a uno SIEMPRE es un cambio que OSD tiene que ver.
    const previousAssigneeCount = ticket.task?.assignments.length ?? 0;
    const assigneeChanged =
      wantsAssignee &&
      (previousAssigneeCount > 1 || nextAssigneeId !== previousAssigneeId);

    // #50 (D8/R4.3): bandera de scope EXTERNO a la tx. `enqueueTx` devuelve true
    // solo si realmente escribió fila (los gates de flag/whitelist de orgs viven
    // adentro del service). El aviso al dispatcher (`notifyEnqueued`) se dispara
    // POST-COMMIT, más abajo: adentro de la tx no serviría — si la tx revierte,
    // la fila desaparece con ella y no hay nada que drenar.
    let outboxEnqueued = false;

    const updated = await this.prisma.$transaction(async (tx) => {
      // #44 (D2.1): candado de tipificación. Ningún camino lleva a RESUELTO sin
      // que el equipo lo haya tipificado (ticketType + categoría interna). Corre
      // DENTRO de la tx y ANTES de estampar resolvedAt: si lanza, se revierte el
      // cambio de estado sin dejar rastro parcial. Mismo molde que el gate de horas.
      if (wantsStatus && this.classificationGuard.isGatedStatus(newStatus)) {
        await this.classificationGuard.assertIsClassified(ticket.id, tx);
      }

      // 1) Update ticket fields
      const data: Prisma.TicketUpdateInput = {};
      if (wantsStatus) {
        data.status = newStatus;
        // SLA auto-marks
        if (newStatus === 'IN_PROGRESS' && !ticket.firstResponseAt) {
          data.firstResponseAt = new Date();
        }
        if (newStatus === 'RESOLVED' && !ticket.resolvedAt) {
          data.resolvedAt = new Date();
        }
      }
      if (wantsNotes) {
        data.adminNotes = dto.adminNotes ?? null;
      }

      // #50 (R3.1): valor PREVIO de la nota, releído DENTRO de esta misma tx y
      // ANTES del update. El punto es NO comparar contra el `findUnique` del
      // arranque del método (que corre fuera de la tx y puede traer un valor ya
      // viejo si otro PATCH escribió en el medio): acá se lee el valor fresco,
      // justo antes de pisarlo, así el "no cambió nada → no encolar" se decide
      // contra lo que realmente hay en la fila.
      // #51 (R1/D1): y se lee con `SELECT ... FOR NO KEY UPDATE`, que es lo que
      // convierte esa relectura en un candado de verdad. Un `findUnique` es un
      // SELECT plano: en READ COMMITTED (el proyecto no pide `isolationLevel` en
      // ningún lado) no bloquea a nadie, así que dos PATCH REALMENTE concurrentes
      // sobre el mismo ticket leían los dos el mismo previo, los dos concluían
      // "cambió" y la misma nota interna llegaba duplicada a OSD (doble click en
      // "Guardar"). Con el lock explícito la segunda tx espera el commit de la
      // primera, después lee el valor YA NUEVO, compara y no encola.
      // Va con tagged template (bind param, nunca concatenación — regla del módulo).
      //
      // POR QUÉ `FOR NO KEY UPDATE` y no `FOR UPDATE`: lo único que hace falta acá
      // es exclusión mutua entre ESCRITORES del ticket (R1.4). `FOR NO KEY UPDATE`
      // ya la da —dos de estos conflictúan entre sí— y es exactamente el modo que
      // toma por su cuenta el `tx.ticket.update` de abajo, porque no toca columnas
      // de índice único referenciadas por FK. `FOR UPDATE` es estrictamente más
      // fuerte: además conflictúa con `FOR KEY SHARE`, o sea que bloquearía a
      // cualquier tx concurrente que inserte una fila hija con FK a este ticket
      // (hoy `ticket_events`, mañana lo que se agregue) mientras dure esta tx. Ese
      // bloqueo extra no compra nada para el dedup y sí agrega contención — al
      // revés de lo que decía el comentario original, tomar el lock acá NO es
      // gratis: lo adelanta al principio de la tx, así que la ventana en la que la
      // fila queda tomada es más larga que si esperáramos al `update`. Es a
      // propósito (dos PATCH del mismo ticket se serializan al entrar en vez de a
      // mitad de camino), pero es un costo real, no cero.
      //
      // #51 (Fix 12): gateado por la MISMA condición que decide encolar más abajo
      // (`wantsNotes && category === 'SUPPORT_REQUEST'`). El único consumidor de
      // `previousAdminNotes` es esa decisión, así que para un ticket fuera del
      // scope Onnix el lock era trabajo muerto: con el flag de la integración
      // apagado —o con la org fuera de la whitelist— el comportamiento a nivel DB
      // tiene que ser idéntico al de antes de #51, y el lock es la primera palanca
      // que se va a tirar si aparece contención. Cuando no aplica, esto queda en
      // `null` y la rama de encolado ni se evalúa.
      //
      // ORDEN DE LOCK: del lado ticket siempre es tickets → tasks (acá se toma el
      // ticket y recién al final `syncTaskToStatus` toca la task). OJO: existe un
      // ABBA PRE-EXISTENTE con `TaskService.updateTask`, que lockea tasks primero
      // (`tx.task.update`) y después el ticket vinculado (`tx.ticket.update`). #51
      // no lo agrava —ese camino ya cruzaba los dos recursos en orden inverso antes
      // de este lock— pero queda documentado: si algún día aparecen deadlocks entre
      // PATCH de ticket y PATCH de task, el orden a normalizar es el de allá.
      const previousAdminNotes =
        wantsNotes && ticket.category === 'SUPPORT_REQUEST'
          ? (
              await tx.$queryRaw<{ admin_notes: string | null }[]>`
                SELECT admin_notes FROM tickets WHERE id = ${ticketId} FOR NO KEY UPDATE`
            )[0]?.admin_notes ?? null
          : null;

      const result = Object.keys(data).length > 0
        ? await tx.ticket.update({
            where: { id: ticketId },
            data,
            include: {
              client: { select: { id: true, name: true } },
              project: { select: { id: true, name: true } },
              task: {
                select: {
                  id: true,
                  status: true,
                  boardColumn: { select: { id: true, name: true, mappedStatus: true } },
                },
              },
            },
          })
        : await tx.ticket.findUniqueOrThrow({
            where: { id: ticketId },
            include: {
              client: { select: { id: true, name: true } },
              project: { select: { id: true, name: true } },
              task: {
                select: {
                  id: true,
                  status: true,
                  boardColumn: { select: { id: true, name: true, mappedStatus: true } },
                },
              },
            },
          });

      // 2) Asignación: replace assignments del task asociado
      if (wantsAssignee && ticket.task) {
        if (dto.assigneeId === null || dto.assigneeId === undefined || dto.assigneeId === '') {
          // Des-asignar todos
          await tx.taskAssignment.deleteMany({ where: { taskId: ticket.task.id } });
        } else {
          // Validar que el usuario pertenezca a la org del ticket
          const member = await tx.organizationMember.findFirst({
            where: {
              organizationId: ticket.organizationId,
              userId: dto.assigneeId,
            },
            select: { id: true },
          });
          if (!member) {
            throw new AppException(
              'El usuario asignado no pertenece a la organizacion',
              'ASSIGNEE_NOT_IN_ORG',
              400,
              { assigneeId: dto.assigneeId },
            );
          }
          // Limpiar y asignar (single-assignee model para ticket — un responsable principal)
          await tx.taskAssignment.deleteMany({ where: { taskId: ticket.task.id } });
          await tx.taskAssignment.create({
            data: { taskId: ticket.task.id, userId: dto.assigneeId },
          });
          // Agregar asignado al canal del chat del ticket (idempotente)
          if (ticket.channelId) {
            await tx.channelMember.upsert({
              where: { channelId_userId: { channelId: ticket.channelId, userId: dto.assigneeId } },
              create: { channelId: ticket.channelId, userId: dto.assigneeId },
              update: {},
            });
          }
        }

        await this.events.writeEventTx(tx, {
          ticketId,
          type: dto.assigneeId ? 'ASSIGNED' : 'UNASSIGNED',
          fromValue: previousAssigneeId,
          toValue: dto.assigneeId ?? null,
          source: 'TICKET',
          userId,
        });

        // Outbox sync Onnix (#52 R3.1): el cambio de responsable viaja a OSD en la
        // MISMA tx (R10), reusando el punto de encolado que ya existe acá — el mismo
        // `wantsAssignee`/`previousAssigneeId` que gobierna la escritura de la
        // asignación — y el patrón `outboxEnqueued` + notify post-commit de #50.
        // Mismo gate por categoría que el resto del módulo: el scope de la
        // integración son los tickets de soporte, y un ASSIGNEE_CHANGED de un ticket
        // que no es SUPPORT_REQUEST nunca se encola, en línea con su TICKET_CREATED
        // que tampoco se encoló.
        if (assigneeChanged && ticket.category === 'SUPPORT_REQUEST') {
          const wrote = await this.outbox.enqueueTx(tx, {
            eventType: 'ASSIGNEE_CHANGED',
            aggregateId: ticketId,
            organizationId: ticket.organizationId,
            // ⚠️ R3.2: el asignado NO se snapshotea — el dispatcher lo RELEE al
            // drenar (last-write-wins, igual que STATUS_CHANGED; a diferencia de la
            // nota interna, acá solo importa el estado final). Lo único que viaja es
            // el ACTOR, que es lo único que el drenado no puede reconstruir y que
            // OSD guarda en su auditoría vía `reason`.
            payload: { ticketId, assignedByUserId: userId },
          });
          if (wrote) outboxEnqueued = true;
        }
      }

      // 3) Audit log de status change
      if (wantsStatus) {
        await this.events.writeEventTx(tx, {
          ticketId,
          type: 'STATUS_CHANGE',
          fromValue: previousStatus,
          toValue: newStatus,
          source: 'TICKET',
          userId,
        });

        // Outbox sync Onnix (feature #13): cambio de estado en la MISMA tx (R10).
        // Gate por categoría: solo los tickets de soporte se replican a Onnix
        // (scope de la integración). Un STATUS_CHANGED de un ticket que no es
        // SUPPORT_REQUEST nunca se encola, en línea con su TICKET_CREATED que
        // tampoco se encoló. `ticket.category` viene del findUnique con include
        // (objeto completo) al inicio de updateTicket.
        if (ticket.category === 'SUPPORT_REQUEST') {
          const wrote = await this.outbox.enqueueTx(tx, {
            eventType: 'STATUS_CHANGED',
            aggregateId: ticketId,
            organizationId: ticket.organizationId,
            payload: { ticketId },
          });
          if (wrote) outboxEnqueued = true;
        }

        // 3.b) Audit timeline para hitos SLA: FIRST_RESPONSE / RESOLVED.
        // Solo se emiten cuando este mismo update setea por primera vez la
        // fecha (data.firstResponseAt / data.resolvedAt) — NO sustituyen al
        // STATUS_CHANGE, son eventos del timeline SLA para reporteria.
        if (data.firstResponseAt) {
          await this.events.writeEventTx(tx, {
            ticketId,
            type: 'FIRST_RESPONSE',
            source: 'TICKET',
            userId,
          });
        }
        if (data.resolvedAt) {
          await this.events.writeEventTx(tx, {
            ticketId,
            type: 'RESOLVED',
            source: 'TICKET',
            userId,
          });
        }
      }

      // 3.c) Outbox sync Onnix (#50 R3): la nota interna viaja a OSD como
      // comentario con `is_internal: true` (el checkbox "Nota interna (solo
      // equipo)"). Mismo gate por categoría que el resto del módulo: el scope de
      // la integración son los tickets de soporte.
      if (wantsNotes && ticket.category === 'SUPPORT_REQUEST') {
        // El trim NO cambia lo que se persiste (`data.adminNotes` sigue siendo
        // `dto.adminNotes ?? null`): solo decide si vale la pena encolar y fija el
        // texto que viaja a OSD.
        const snapshot = (dto.adminNotes ?? '').trim();
        const wasEmptyOrSame =
          // R3.4: borrar/vaciar la nota NO genera comentario (OSD tampoco tiene
          // borrado de comentario, mandar vacío solo ensuciaría el hilo).
          snapshot === '' ||
          // R3.1: solo si CAMBIÓ respecto del previo leído en esta misma tx.
          // Re-guardar el mismo texto (el "Guardar" repetido de la UI) no debe
          // duplicar el comentario en OSD.
          snapshot === (previousAdminNotes ?? '').trim();

        if (!wasEmptyOrSame) {
          const wrote = await this.outbox.enqueueTx(tx, {
            eventType: 'COMMENT_ADDED',
            aggregateId: ticketId,
            organizationId: ticket.organizationId,
            // ⚠️ R3.2: el texto viaja como SNAPSHOT en el payload y el dispatcher
            // NO relee el ticket al drenar (a diferencia del chat, que sí relee su
            // Message). Motivo: dos guardados rápidos generan DOS filas; si ambas
            // releyeran el valor final, OSD recibiría el mismo texto dos veces y se
            // perdería la versión intermedia. Con snapshot, OSD guarda el historial
            // fiel de versiones. `authorUserId` es para el prefijo `[Nombre]` que
            // arma el dispatcher (R3.3): OSD atribuye todo al usuario de servicio.
            payload: { ticketId, adminNoteSnapshot: snapshot, authorUserId: userId },
          });
          if (wrote) outboxEnqueued = true;
        }
      }

      // 4) Sync kanban: si hay task asociada, mover según mapping
      if (ticket.task) {
        const targetTaskStatus = mapTicketStatusToTaskStatus(newStatus, !!effectiveAssigneeId);
        await this.syncTaskToStatus(
          tx,
          ticket.task.id,
          targetTaskStatus,
          userId,
          ticket.organizationId,
          actor?.permissions,
        );
      }

      return result;
    }, {
      // Configurable por entorno via PRISMA_TX_TIMEOUT_MS y PRISMA_TX_MAX_WAIT_MS.
      // Default 15s/10s (dev local con BD remota Railway). En prod basta con
      // 5s/2s — bajalo en el .env de produccion si querés ahorrar memoria.
      timeout: this.config.prismaTxTimeoutMs,
      maxWait: this.config.prismaTxMaxWaitMs,
    });

    // ── Emit domain events AFTER transaction commits ─────────
    this.flushPendingEvents();

    // #50 (D8/R4.1): drain-on-enqueue. Recién acá, con la tx COMMITEADA, las filas
    // existen y son visibles para el dispatcher. El aviso es best-effort puro: si
    // nadie lo escucha o el drain falla, el cron horario (R4.2) las levanta igual.
    if (outboxEnqueued) {
      this.outbox.notifyEnqueued();
    }

    if (wantsStatus) {
      this.eventEmitter.emit('ticket.updated', {
        ...domainEvent('ticket.updated', 'ticket', updated.id, ticket.organizationId, userId),
        ticketId: updated.id,
        title: updated.title,
        previousStatus,
        status: newStatus,
        projectId: updated.project?.id,
        clientId: updated.client?.id,
        organizationId: ticket.organizationId,
        // Loop guard for downstream listeners that also handle task.moved
        metadata: { fromTicketUpdate: true },
      });
    }

    if (wantsAssignee && dto.assigneeId !== previousAssigneeId) {
      this.eventEmitter.emit('ticket.assigned', {
        ...domainEvent('ticket.assigned', 'ticket', updated.id, ticket.organizationId, userId),
        ticketId: updated.id,
        taskId: ticket.task?.id,
        previousAssigneeId,
        newAssigneeId: dto.assigneeId ?? null,
        organizationId: ticket.organizationId,
      });
    }

    this.logger.log(
      `Ticket ${ticketId} actualizado por ${userId} — status=${newStatus} assignee=${effectiveAssigneeId ?? '∅'}`,
    );

    return this.getTicketDetail(ticketId);
  }

  // ────────────────────────────────────────────────────────────
  // Cancelar ticket (endpoint dedicado — #43 reutiliza CLOSED como «Cancelado»)
  // ────────────────────────────────────────────────────────────

  /**
   * Cancela un ticket (status CLOSED, label UI «Cancelado»). Feature #43 R1b:
   * única puerta de entrada al estado CLOSED, con comentario OBLIGATORIO
   * (candado acá, no solo en el DTO/UI). El endpoint y los campos conservan
   * su nombre histórico (`close*`) — cero migración, el schema sigue siendo
   * cierto. `closeNote` es INTERNO: nunca viaja por los endpoints del portal.
   *
   * Semántica SLA (R1b.6): cancelar NO estampa resolvedAt/firstResponseAt
   * (un cancelado sin resolver no cuenta como cumplido ni incumplido —
   * `classifySlaOutcome` lo deja fuera de COMPLIED y el cron nunca mira
   * CLOSED). El molde viejo (feature #10, muerto detrás del 410) estampaba
   * ambos; eso era el "cierre = resolución" que este feature elimina.
   */
  async closeTicket(ticketId: string, dto: CloseTicketDto, userId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { task: { select: { id: true, status: true, projectId: true } } },
    });
    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    // Candado del comentario en el SERVICE (R1b.1) — el DTO también lo exige,
    // pero cualquier caller interno futuro tiene que chocar con esto.
    if (!dto.note?.trim()) {
      throw new AppException(
        'El comentario de cancelación es obligatorio',
        'CANCEL_NOTE_REQUIRED',
        400,
      );
    }

    if (ticket.status === 'CLOSED') {
      throw new AppException(
        'El ticket ya esta cancelado',
        'ALREADY_CLOSED',
        400,
      );
    }

    // R1.1: desde RESOLVED no se cancela — ya está entregado. Mensaje claro
    // en vez del genérico de transición inválida.
    if (ticket.status === 'RESOLVED') {
      throw new AppException(
        'Un ticket resuelto no se puede cancelar: ya fue entregado. Reabrilo a "En curso" primero.',
        'TICKET_RESOLVED_NOT_CANCELLABLE',
        400,
      );
    }

    this.validateStatusTransition(ticket.status, 'CLOSED');

    const previousStatus = ticket.status;

    // #50 (D8/R4.3): igual que en updateTicket — la bandera vive FUERA de la tx y
    // el aviso al dispatcher se dispara post-commit.
    let outboxEnqueued = false;

    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'CLOSED',
          closeReason: dto.reason as TicketCloseReason,
          closeNote: dto.note,
          closedAt: new Date(),
          closedByUserId: userId,
          // ⚠️ SIN SLA auto-marks (R1b.6): cancelar no es resolver.
          // resolvedAt/firstResponseAt quedan como estaban.
        },
      });

      // Evento con fromValue real (R1b.2): la reapertura manual CLOSED → OPEN
      // y la auditoría lo leen. metadata.note es interna (timeline staff-only).
      await this.events.writeEventTx(tx, {
        ticketId,
        type: 'CLOSED',
        fromValue: previousStatus,
        toValue: 'CLOSED',
        source: 'TICKET',
        userId,
        metadata: { reason: dto.reason, note: dto.note },
      });

      // Outbox sync Onnix (paridad con updateTicket): el estado que ve el
      // cliente cambió → replicar a Onnix (slug 'cerrado' via STATUS_SLUG).
      // Mismo gate por categoría que el resto del módulo.
      if (ticket.category === 'SUPPORT_REQUEST') {
        const wrote = await this.outbox.enqueueTx(tx, {
          eventType: 'STATUS_CHANGED',
          aggregateId: ticketId,
          organizationId: ticket.organizationId,
          payload: { ticketId },
        });
        if (wrote) outboxEnqueued = true;
      }

      // R1b.4: cancelar el ticket lleva la task SIEMPRE a CANCELLED (el enum
      // TaskStatus lo tiene; verificado en schema.prisma:49). La rama vieja
      // "resuelto y cerrado → task DONE" es inalcanzable: desde RESOLVED no
      // se cancela (guard de arriba). Mismo mecanismo legacy: update directo
      // del status sin mover la boardColumn.
      if (ticket.task && ticket.task.status !== 'CANCELLED') {
        await tx.task.update({
          where: { id: ticket.task.id },
          data: { status: 'CANCELLED' },
        });
        this.pendingEvents.push(() => {
          this.eventEmitter.emit('task.updated', {
            taskId: ticket.task!.id,
            status: 'CANCELLED',
            projectId: ticket.task!.projectId,
            reason: 'ticket_cancelled',
            organizationId: ticket.organizationId,
          });
        });
      }
    });

    this.flushPendingEvents();

    // #50 (D8/R4.1): drain-on-enqueue post-commit. Ver comentario en updateTicket.
    if (outboxEnqueued) {
      this.outbox.notifyEnqueued();
    }

    this.eventEmitter.emit('ticket.closed', {
      ...domainEvent('ticket.closed', 'ticket', ticketId, ticket.organizationId, userId),
      ticketId,
      reason: dto.reason,
      previousStatus,
      organizationId: ticket.organizationId,
    });

    this.eventEmitter.emit('ticket.updated', {
      ...domainEvent('ticket.updated', 'ticket', ticketId, ticket.organizationId, userId),
      ticketId,
      previousStatus,
      status: 'CLOSED',
      organizationId: ticket.organizationId,
      metadata: { fromTicketUpdate: true, closed: true },
    });

    this.logger.log(`Ticket ${ticketId} cerrado por ${userId} — motivo=${dto.reason}`);

    return this.getTicketDetail(ticketId);
  }

  // ────────────────────────────────────────────────────────────
  // Sync inverso (llamado por TicketSyncListener desde kanban events)
  // ────────────────────────────────────────────────────────────

  /**
   * Sincronizar el ticket cuando una task asociada cambia de estado en kanban.
   * Loop guard: si el caller marca metadata.fromTicketSync, no re-sincronizar.
   * Devuelve el ticket actualizado o null si la task no está asociada a un ticket.
   */
  async syncTicketFromTaskMove(
    taskId: string,
    newTaskStatus: TaskStatus,
    userId: string,
    options: { skipIfFromTicketSync?: boolean; organizationId?: string } = {},
  ) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { taskId },
      select: {
        id: true,
        status: true,
        organizationId: true,
        firstResponseAt: true,
        resolvedAt: true,
      },
    });
    if (!ticket) return null; // task no es de un ticket → no hacer nada

    // Mapping inverso task → ticket
    let targetTicketStatus: TicketStatus | null = null;
    switch (newTaskStatus) {
      case 'BACKLOG':
      case 'TODO':
        targetTicketStatus = 'OPEN';
        break;
      case 'IN_PROGRESS':
        targetTicketStatus = 'IN_PROGRESS';
        break;
      case 'IN_REVIEW':
        // #43: task IN_REVIEW ya NO empuja el ticket a IN_REVIEW (estado
        // retirado). En el modelo nuevo, task IN_REVIEW = "el dev entregó" y
        // el ticket YA está en RESOLVED (fue resolver el ticket lo que mandó
        // la task a revisión). Una tarjeta arrastrada a mano a la columna
        // Revisión es asunto del kanban, no del ticket → no-op.
        this.logger.debug(
          `Task ${taskId} → IN_REVIEW: no-op sobre el status del ticket (#43)`,
        );
        return null;
      case 'DONE':
        // El kanban yendo a DONE solo lleva a RESOLVED, NUNCA a CLOSED
        targetTicketStatus = 'RESOLVED';
        break;
      case 'CANCELLED':
        // No auto-sincronizar cancelaciones — requiere acción explícita
        return null;
    }

    if (!targetTicketStatus || targetTicketStatus === ticket.status) {
      return null;
    }

    // Verificar transición válida; si no es válida, registrar warning y abortar
    const allowed = ALLOWED_TRANSITIONS[ticket.status];
    if (!allowed.includes(targetTicketStatus)) {
      this.logger.warn(
        `Sync ignorado: ${ticket.status} → ${targetTicketStatus} no permitido (taskId=${taskId})`,
      );
      return null;
    }

    // #44 (D2.3): última línea de defensa del gate de tipificación. Este path lo
    // dispara el listener de `task.approval.approved`, que traga cualquier throw
    // río abajo (ticket-sync.listener.ts) → si lanzáramos, quedaría divergencia
    // silenciosa task-DONE / ticket-abierto. Por eso NO lanza: loguea y devuelve
    // null (el pre-vuelo síncrono de approveTask ya frenó el caso normal; llegar
    // acá sin tipificar significa que ese pre-vuelo falló o hay un caller nuevo).
    // Va ANTES de abrir la tx para poder cortar el método entero y no emitir el
    // evento `ticket.updated` de un cambio que no ocurrió.
    if (targetTicketStatus === 'RESOLVED' && !(await this.classificationGuard.isClassified(ticket.id))) {
      this.logger.error(
        `Sync a RESOLVED abortado: ticket ${ticket.id} sin tipificar (taskId=${taskId}, newTaskStatus=${newTaskStatus})`,
      );
      return null;
    }

    const data: Prisma.TicketUpdateInput = { status: targetTicketStatus };
    if (targetTicketStatus === 'IN_PROGRESS' && !ticket.firstResponseAt) {
      data.firstResponseAt = new Date();
    }
    if (targetTicketStatus === 'RESOLVED' && !ticket.resolvedAt) {
      data.resolvedAt = new Date();
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.ticket.update({
        where: { id: ticket.id },
        data,
      });
      await this.events.writeEventTx(tx, {
        ticketId: ticket.id,
        type: 'KANBAN_MOVE',
        fromValue: ticket.status,
        toValue: targetTicketStatus,
        source: 'KANBAN',
        userId,
        metadata: { taskId, newTaskStatus },
      });

      // Audit timeline para hitos SLA: FIRST_RESPONSE / RESOLVED.
      // El sync desde kanban tambien puede marcar por primera vez los hitos.
      // source = KANBAN porque la transicion vino del board.
      if (data.firstResponseAt) {
        await this.events.writeEventTx(tx, {
          ticketId: ticket.id,
          type: 'FIRST_RESPONSE',
          source: 'KANBAN',
          userId,
          metadata: { taskId },
        });
      }
      if (data.resolvedAt) {
        await this.events.writeEventTx(tx, {
          ticketId: ticket.id,
          type: 'RESOLVED',
          source: 'KANBAN',
          userId,
          metadata: { taskId },
        });
      }
      return result;
    });

    this.eventEmitter.emit('ticket.updated', {
      ...domainEvent('ticket.updated', 'ticket', ticket.id, ticket.organizationId, userId),
      ticketId: ticket.id,
      previousStatus: ticket.status,
      status: targetTicketStatus,
      organizationId: ticket.organizationId,
      // Loop guard: este update vino de kanban, NO re-sincronizar
      metadata: { fromKanbanSync: true },
    });

    this.logger.log(
      `Ticket ${ticket.id} sync desde kanban: ${ticket.status} → ${targetTicketStatus}`,
    );

    return updated;
  }

  // ────────────────────────────────────────────────────────────
  // Crear ticket (admin)
  // ────────────────────────────────────────────────────────────

  async createTicket(orgId: string, dto: CreateAdminTicketDto, createdByUserId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: dto.clientId, organizationId: orgId },
    });
    if (!client) {
      throw new AppException('Cliente no encontrado', 'CLIENT_NOT_FOUND', 404);
    }

    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, organizationId: orgId, clientId: dto.clientId },
      select: {
        id: true,
        name: true,
        organizationId: true,
        createdById: true,
        responsibleId: true,
        members: { select: { userId: true } },
      },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado o no pertenece al cliente', 'PROJECT_NOT_FOUND', 404);
    }

    let categoryConfig: any = null;
    let criticality: string | null = null;
    let responseDeadline: Date | null = null;
    let resolutionDeadline: Date | null = null;
    // SLA v2 (feature #42 — Fase 1): SOLO se llenan con `SLA_CASCADE_ENABLED=true`.
    let slaPolicyId: string | null = null;
    let slaSource: SlaSource | null = null;
    let ticketTypeId: string | null = null;

    if (dto.categoryConfigId) {
      categoryConfig = await this.prisma.ticketCategoryConfig.findFirst({
        where: { id: dto.categoryConfigId, organizationId: orgId, isActive: true },
      });
    }

    if (categoryConfig) {
      criticality = categoryConfig.criticality;
    }

    // #48 T10 (R8.2): la criticidad que eligió el EQUIPO gana sobre la derivada de
    // la categoría SLA. Hasta esta feature el DTO no aceptaba `criticality`, así
    // que nadie la manda todavía y el comportamiento previo queda intacto: sin el
    // campo, la fuente sigue siendo `categoryConfig`.
    if (dto.criticality) {
      criticality = dto.criticality;
    }

    // #48 T10: el tipo de solicitud es CLASIFICACIÓN, no salida del motor de SLA.
    // Por eso se valida y se resuelve SIEMPRE, FUERA del gate de
    // `slaCascadeEnabled`. El portal ya se había corregido por exactamente esto
    // (ver `portal.service.ts`, alta desde el portal); el alta por admin quedó
    // atrás: con el flag apagado se descartaba en silencio lo que el equipo eligió
    // y el ticket nacía sin tipo → condenado al 409 del candado de tipificación
    // al resolverlo (#44).
    if (dto.ticketTypeId) {
      // Scoping multi-tenant: un tipo de otra org no se persiste ni se resuelve.
      const type = await this.prisma.ticketType.findFirst({
        where: { id: dto.ticketTypeId, organizationId: orgId, isActive: true },
        select: { id: true },
      });
      if (!type) {
        throw new AppException('Tipo de solicitud no encontrado', 'TICKET_TYPE_NOT_FOUND', 404);
      }
      ticketTypeId = type.id;
    }

    if (this.config.slaCascadeEnabled) {
      // ── PATH NUEVO: cascada contrato → proyecto → cliente → criticidad → "Estándar".
      // El motor de cálculo (horas hábiles + feriados) es el MISMO; cambia solo de
      // dónde salen los tiempos. Los deadlines se congelan igual que hoy.
      const resolved = await this.slaResolver.resolveAndCalculateDeadlines({
        organizationId: orgId,
        clientId: dto.clientId,
        projectId: dto.projectId,
        ticketTypeId,
        // `categoryConfig` es `any` (path viejo); el valor ya es un TicketCriticality
        // válido porque viene de la columna del enum. Cast puntual documentado.
        criticality: criticality as TicketCriticality | null,
      });

      slaPolicyId = resolved.policy?.id ?? null;
      slaSource = resolved.source;
      responseDeadline = resolved.responseDeadline;
      resolutionDeadline = resolved.resolutionDeadline;
    } else if (criticality) {
      // ── PATH ACTUAL (default): SlaConfig por criticidad.
      //
      // ⚠️ El gate es `criticality`, NO `categoryConfig` (#48 T10; espejo del
      // hallazgo C1 que ya se corrigió en el portal). Desde que el admin puede
      // mandar `criticality` suelta, un alta con criticidad y SIN "Categoría SLA"
      // entraba al `else` viejo, no calculaba deadlines y los guardaba vacíos —
      // en silencio y PARA SIEMPRE, porque los deadlines se congelan al crear.
      // Sería el mismo bug de "payload nuevo + flag apagado" de #42.
      //
      // `categoryConfigId` nunca fue una dependencia real de este path: la query
      // busca por `organizationId_criticality`. Era solo el vehículo por el que
      // llegaba la criticidad.
      const slaConfig = await this.slaResolver.findLegacySlaConfig(
        orgId,
        criticality as TicketCriticality,
      );

      if (slaConfig) {
        const [businessHours, holidayRows] = await Promise.all([
          this.prisma.businessHoursConfig.findUnique({ where: { organizationId: orgId } }),
          this.prisma.holiday.findMany({ where: { organizationId: orgId }, select: { date: true } }),
        ]);

        const bhConfig = businessHours
          ? { start: businessHours.businessHoursStart, end: businessHours.businessHoursEnd, days: parseBusinessDays(businessHours.businessDays), timezone: businessHours.timezone }
          : undefined;

        const holidays = holidayRows.map((h) => h.date);
        const now = new Date();
        responseDeadline = calculateBusinessDeadline(now, slaConfig.responseTimeMinutes, bhConfig, holidays);
        resolutionDeadline = calculateBusinessDeadline(now, slaConfig.resolutionTimeMinutes, bhConfig, holidays);
      }
    }

    // Salida del MOTOR de SLA. Con el flag OFF queda VACÍO → no se escriben las
    // columnas que produce la cascada.
    // ⚠️ `ticketTypeId` NO está acá (#48 T10): es clasificación, se persiste
    // siempre — ver el bloque de arriba y el mismo criterio en `portal.service.ts`.
    const slaCascadeData = this.config.slaCascadeEnabled
      ? {
          ...(slaPolicyId && { slaPolicyId }),
          ...(slaSource && { slaSource }),
        }
      : {};

    const categoryLabel = dto.category === 'SUPPORT_REQUEST' ? 'Soporte' : 'Desarrollo';
    const channelName = `[${categoryLabel}] ${dto.title}`;
    const taskTitle = `[Ticket] ${dto.title}`;

    const memberIds = project.members.map((m) => m.userId);
    if (client.userId && !memberIds.includes(client.userId)) {
      memberIds.push(client.userId);
    }
    if (project.responsibleId && !memberIds.includes(project.responsibleId)) {
      memberIds.push(project.responsibleId);
    }
    const poAndPm = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: orgId,
        role: { name: { in: ['Product Owner', 'Project Manager'] } },
      },
      select: { userId: true },
    });
    for (const member of poAndPm) {
      if (!memberIds.includes(member.userId)) {
        memberIds.push(member.userId);
      }
    }

    // #50 (D8/R4.3): bandera fuera de la tx; el aviso al dispatcher va post-commit.
    let outboxEnqueued = false;

    const ticket = await this.prisma.$transaction(async (tx) => {
      // Ticket relacionado (feature #11): si viene relatedTicketId, validar que
      // exista y pertenezca al MISMO cliente; si no, 400. Dentro de la tx para
      // consistencia con la creación.
      if (dto.relatedTicketId) {
        const related = await tx.ticket.findFirst({
          where: { id: dto.relatedTicketId, clientId: dto.clientId },
          select: { id: true },
        });
        if (!related) {
          throw new AppException('Ticket relacionado inválido', 'INVALID_RELATED_TICKET', 400);
        }
      }

      const maxPosition = await tx.task.aggregate({
        where: { projectId: dto.projectId },
        _max: { position: true },
      });

      const backlogColumn = await tx.boardColumn.findFirst({
        where: {
          mappedStatus: 'BACKLOG',
          board: { projectId: dto.projectId },
        },
        orderBy: { position: 'asc' },
      });

      const task = await tx.task.create({
        data: {
          projectId: dto.projectId,
          title: taskTitle,
          description: dto.description,
          priority: (dto.priority as any) ?? 'MEDIUM',
          status: 'BACKLOG',
          type: 'SUPPORT',
          position: (maxPosition._max.position ?? -1) + 1,
          createdById: createdByUserId,
          clientVisible: true,
          ...(backlogColumn && { boardColumnId: backlogColumn.id }),
        },
      });

      const channel = await tx.channel.create({
        data: {
          name: channelName,
          type: 'TICKET',
          organizationId: orgId,
          createdById: createdByUserId,
          members: {
            create: memberIds.map((id) => ({ userId: id })),
          },
        },
      });

      const ticketNumber = await generateTicketNumber(tx, orgId);

      const created = await tx.ticket.create({
        data: {
          organizationId: orgId,
          projectId: dto.projectId,
          clientId: dto.clientId,
          title: dto.title,
          description: dto.description,
          category: dto.category as any,
          priority: (dto.priority as any) ?? 'MEDIUM',
          taskId: task.id,
          channelId: channel.id,
          createdByUserId,
          ticketNumber,
          ...(categoryConfig && { categoryConfigId: categoryConfig.id }),
          ...(criticality && { criticality: criticality as any }),
          ...(responseDeadline && { responseDeadline }),
          ...(resolutionDeadline && { resolutionDeadline }),
          ...(dto.relatedTicketId && { relatedTicketId: dto.relatedTicketId }),
          // El tipo es CLASIFICACIÓN, no salida del motor de SLA: se persiste
          // también con `SLA_CASCADE_ENABLED` apagado (#48 T10), igual que en el
          // portal. `slaPolicyId`/`slaSource` sí van gateados (`slaCascadeData`).
          ...(ticketTypeId && { ticketTypeId }),
          // #42 Fase 2.1: el alta por ADMIN no escribe `reportedTicketTypeId` ni
          // `reportedCriticality` — quedan en null a propósito. Esas columnas son
          // la declaración del CLIENTE (solo el portal la produce); llenarlas acá
          // con lo que cargó el equipo las volvería inútiles para distinguir
          // "lo que reportó el cliente" de "lo que determinó el equipo".
          ...slaCascadeData,
        },
        include: {
          project: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } },
          task: { select: { id: true, title: true, status: true } },
          channel: { select: { id: true, name: true } },
          ...TICKET_CLASSIFICATION_INCLUDE,
        },
      });

      // Audit: ticket creado
      await this.events.writeEventTx(tx, {
        ticketId: created.id,
        type: 'STATUS_CHANGE',
        fromValue: null,
        toValue: 'OPEN',
        source: 'TICKET',
        userId: createdByUserId,
        metadata: { event: 'created' },
      });

      // Outbox sync Onnix (feature #13): encolar en la MISMA tx (R1, R8).
      // Gate por categoría: el scope de la integración Onnix es SOLO tickets de
      // soporte. El admin puede crear cualquier categoría (SUPPORT_REQUEST /
      // NEW_DEVELOPMENT / NEW_PROJECT), por eso acá SÍ se gatea: solo se encola
      // si es SUPPORT_REQUEST. Los demás tipos no se replican a Onnix.
      if (dto.category === 'SUPPORT_REQUEST') {
        const wrote = await this.outbox.enqueueTx(tx, {
          eventType: 'TICKET_CREATED',
          aggregateId: created.id,
          organizationId: orgId,
          payload: {
            ticketId: created.id,
            clientId: dto.clientId,
            projectId: dto.projectId,
          },
        });
        if (wrote) outboxEnqueued = true;
      }

      return created;
    });

    // #50 (D8/R4.1): drain-on-enqueue post-commit. Ver comentario en updateTicket.
    if (outboxEnqueued) {
      this.outbox.notifyEnqueued();
    }

    this.logger.log(`Ticket created by admin: ${ticket.id} for client: ${dto.clientId}`);

    this.eventEmitter.emit('ticket.created', {
      ...domainEvent('ticket.created', 'ticket', ticket.id, orgId, createdByUserId),
      ticketId: ticket.id,
      title: dto.title,
      category: dto.category,
      projectId: dto.projectId,
      clientName: client.name,
      organizationId: orgId,
    });

    return ticket;
  }

  // ────────────────────────────────────────────────────────────
  // Tipificación interna (feature #42 — Fase 2)
  // ────────────────────────────────────────────────────────────

  /**
   * Reclasifica un ticket: tipo de solicitud, criticidad y/o categoría interna.
   *
   * El cliente reporta con SU vocabulario; el equipo tipifica con el propio. Todo
   * ocurre en UNA `$transaction`: el cambio, el `TicketEvent` de tipo `RECLASSIFIED`
   * (con from/to legibles y el motivo en `metadata`) y el evento de dominio.
   *
   * ⚠️ POR DISEÑO **NO se tocan** `responseDeadline`, `resolutionDeadline`,
   * `slaPolicyId` ni `slaSource`: los deadlines quedan **CONGELADOS** con lo que se
   * resolvió al crear el ticket (misma regla que OSD). Recalcularlos permitiría
   * "arreglar" un SLA vencido reclasificando, y rompería el histórico de
   * cumplimiento. Si algún día se decide recalcular, es una decisión de negocio
   * nueva — no un detalle de implementación de esta función.
   *
   * @param orgId scoping multi-tenant: el ticket y los valores nuevos deben ser de
   *   esta organización.
   */
  async reclassify(orgId: string, ticketId: string, dto: ReclassifyTicketDto, userId: string) {
    // Defensa además del DTO: el motivo con solo espacios no es un motivo.
    const reason = dto.reason?.trim();
    if (!reason) {
      throw new AppException(
        'El motivo de la reclasificación es obligatorio',
        'RECLASSIFY_REASON_REQUIRED',
        400,
      );
    }

    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, organizationId: orgId },
      select: {
        id: true,
        ticketTypeId: true,
        criticality: true,
        categoryConfigId: true,
        ticketType: { select: { name: true } },
        categoryConfig: { select: { name: true } },
      },
    });
    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    // Los valores nuevos tienen que existir, estar activos y ser de la MISMA org.
    let newType: { id: string; name: string } | null = null;
    if (dto.ticketTypeId) {
      newType = await this.prisma.ticketType.findFirst({
        where: { id: dto.ticketTypeId, organizationId: orgId, isActive: true },
        select: { id: true, name: true },
      });
      if (!newType) {
        throw new AppException('Tipo de solicitud no encontrado', 'TICKET_TYPE_NOT_FOUND', 404);
      }
    }

    let newCategory: { id: string; name: string } | null = null;
    if (dto.categoryConfigId) {
      newCategory = await this.prisma.ticketCategoryConfig.findFirst({
        where: { id: dto.categoryConfigId, organizationId: orgId, isActive: true },
        select: { id: true, name: true },
      });
      if (!newCategory) {
        throw new AppException('Categoría de ticket no encontrada', 'TICKET_CATEGORY_NOT_FOUND', 404);
      }
    }

    // Cast puntual documentado: el DTO espeja el enum de Prisma (mismos valores),
    // pero TS no considera asignable un string-enum a la unión que genera Prisma.
    const newCriticality = (dto.criticality as TicketCriticality | undefined) ?? null;

    const changes: ClassificationChange[] = [];
    if (newType && newType.id !== ticket.ticketTypeId) {
      changes.push({
        field: 'ticketTypeId',
        label: 'Tipo',
        from: ticket.ticketType?.name ?? null,
        to: newType.name,
      });
    }
    if (newCriticality && newCriticality !== ticket.criticality) {
      const labels = await this.getCriticalityLabels(orgId);
      changes.push({
        field: 'criticality',
        label: 'Criticidad',
        from: ticket.criticality ? labels.get(ticket.criticality) ?? ticket.criticality : null,
        to: labels.get(newCriticality) ?? newCriticality,
      });
    }
    if (newCategory && newCategory.id !== ticket.categoryConfigId) {
      changes.push({
        field: 'categoryConfigId',
        label: 'Categoría',
        from: ticket.categoryConfig?.name ?? null,
        to: newCategory.name,
      });
    }

    if (changes.length === 0) {
      // Se mandaron los mismos valores que ya tenía: no se escribe evento para no
      // ensuciar el timeline con ruido, y el ticket se devuelve tal cual está.
      return this.getTicketClassification(ticketId);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.ticket.update({
        where: { id: ticketId },
        data: {
          ...(newType && { ticketTypeId: newType.id }),
          ...(newCriticality && { criticality: newCriticality }),
          ...(newCategory && { categoryConfigId: newCategory.id }),
          // ⚠️ Deliberadamente ausentes: responseDeadline / resolutionDeadline /
          // slaPolicyId / slaSource. Ver el comentario del método.
          // ⚠️ Y TAMPOCO reportedTicketTypeId / reportedCriticality (#42 Fase 2.1):
          // son la declaración del cliente, se escriben UNA vez al crear desde el
          // portal. Reclasificar es justamente el caso en que el equipo dice algo
          // DISTINTO de lo que reportó el cliente; pisarlas borraría la única
          // evidencia directa de esa diferencia.
        },
        select: TICKET_CLASSIFICATION_SELECT,
      });

      await this.events.writeEventTx(tx, {
        ticketId,
        type: 'RECLASSIFIED',
        fromValue: changes.map((c) => `${c.label}: ${c.from ?? '—'}`).join(' · '),
        toValue: changes.map((c) => `${c.label}: ${c.to}`).join(' · '),
        source: 'TICKET',
        userId,
        metadata: { reason, changes },
      });

      // Evento de dominio dentro de la transacción (checklist del blueprint).
      this.eventEmitter.emit('ticket.reclassified', {
        ...domainEvent('ticket.reclassified', 'ticket', ticketId, orgId, userId),
        ticketId,
        organizationId: orgId,
        changes,
        reason,
        userId,
      });

      return result;
    });

    this.logger.log(
      `Ticket ${ticketId} reclasificado por ${userId} org=${orgId}: ` +
        `${changes.map((c) => c.field).join(', ')}`,
    );
    return updated;
  }

  /** `criticality` → `displayName` configurado por la org (vacío = no configurado). */
  private async getCriticalityLabels(orgId: string): Promise<Map<TicketCriticality, string>> {
    const configs = await this.prisma.ticketCriticalityConfig.findMany({
      where: { organizationId: orgId },
      select: { criticality: true, displayName: true },
    });
    return new Map(configs.map((c) => [c.criticality, c.displayName]));
  }

  private getTicketClassification(ticketId: string) {
    return this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: TICKET_CLASSIFICATION_SELECT,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Categories / SLA / Business Hours / Holidays — sin cambios
  // ────────────────────────────────────────────────────────────

  async getCategories(orgId: string) {
    return this.prisma.ticketCategoryConfig.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getActiveCategories(orgId: string) {
    return this.prisma.ticketCategoryConfig.findMany({
      where: { organizationId: orgId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(orgId: string, dto: CreateCategoryConfigDto) {
    return this.prisma.ticketCategoryConfig.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        description: dto.description,
        criticality: dto.criticality as any,
      },
    });
  }

  async updateCategory(orgId: string, categoryId: string, dto: UpdateCategoryConfigDto) {
    const existing = await this.prisma.ticketCategoryConfig.findFirst({
      where: { id: categoryId, organizationId: orgId },
    });
    if (!existing) {
      throw new AppException('Categoría no encontrada', 'CATEGORY_NOT_FOUND', 404);
    }

    return this.prisma.ticketCategoryConfig.update({
      where: { id: categoryId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.criticality !== undefined && { criticality: dto.criticality as any }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async deleteCategory(orgId: string, categoryId: string) {
    const existing = await this.prisma.ticketCategoryConfig.findFirst({
      where: { id: categoryId, organizationId: orgId },
    });
    if (!existing) {
      throw new AppException('Categoría no encontrada', 'CATEGORY_NOT_FOUND', 404);
    }
    return this.prisma.ticketCategoryConfig.update({
      where: { id: categoryId },
      data: { isActive: false },
    });
  }

  async getSlaConfigs(orgId: string) {
    return this.prisma.slaConfig.findMany({
      where: { organizationId: orgId },
      orderBy: { criticality: 'asc' },
    });
  }

  async upsertSlaConfigs(orgId: string, dto: UpsertSlaConfigDto) {
    return this.prisma.$transaction(
      dto.configs.map((config) =>
        this.prisma.slaConfig.upsert({
          where: { organizationId_criticality: { organizationId: orgId, criticality: config.criticality as any } },
          create: {
            organizationId: orgId,
            criticality: config.criticality as any,
            responseTimeMinutes: config.responseTimeMinutes,
            resolutionTimeMinutes: config.resolutionTimeMinutes,
          },
          update: {
            responseTimeMinutes: config.responseTimeMinutes,
            resolutionTimeMinutes: config.resolutionTimeMinutes,
          },
        }),
      ),
    );
  }

  async getBusinessHours(orgId: string) {
    const config = await this.prisma.businessHoursConfig.findUnique({
      where: { organizationId: orgId },
    });
    return config || {
      businessHoursStart: '08:30',
      businessHoursEnd: '17:30',
      businessDays: '1,2,3,4,5',
      timezone: 'America/Asuncion',
    };
  }

  async upsertBusinessHours(orgId: string, dto: UpsertBusinessHoursDto) {
    return this.prisma.businessHoursConfig.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        businessHoursStart: dto.businessHoursStart,
        businessHoursEnd: dto.businessHoursEnd,
        businessDays: dto.businessDays,
        timezone: dto.timezone || 'America/Asuncion',
      },
      update: {
        businessHoursStart: dto.businessHoursStart,
        businessHoursEnd: dto.businessHoursEnd,
        businessDays: dto.businessDays,
        ...(dto.timezone && { timezone: dto.timezone }),
      },
    });
  }

  async getHolidays(orgId: string) {
    return this.prisma.holiday.findMany({
      where: { organizationId: orgId },
      orderBy: { date: 'asc' },
    });
  }

  async createHoliday(orgId: string, dto: { name: string; date: string; recurring?: boolean }) {
    return this.prisma.holiday.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        date: new Date(dto.date),
        recurring: dto.recurring ?? false,
      },
    });
  }

  async deleteHoliday(orgId: string, holidayId: string) {
    const holiday = await this.prisma.holiday.findFirst({
      where: { id: holidayId, organizationId: orgId },
    });
    if (!holiday) {
      throw new AppException('El feriado no existe', 'HOLIDAY_NOT_FOUND', 404);
    }
    await this.prisma.holiday.delete({ where: { id: holidayId } });
  }
}
