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
// CLOSED queda como key con array vacio para preservar el enum en lectura
// (tickets historicos pre-feature #10), pero ningun estado origen permite
// transicionar a CLOSED — el cierre fue deprecado, los tickets terminan en
// RESOLVED. Ver docs en spec tickets-eliminar-closed-pulir-listing/design.md.
const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN:        ['IN_PROGRESS'],
  IN_PROGRESS: ['IN_REVIEW', 'RESOLVED', 'OPEN'],
  IN_REVIEW:   ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED:    ['IN_PROGRESS'],
  CLOSED:      [],
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
            assignments: { select: { userId: true } },
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

    // El estado CLOSED fue deprecado (feature #10). Cualquier intento de
    // transicionar a CLOSED via PATCH falla con error explicito antes de
    // validar la state machine (que tambien lo bloquearia, pero con mensaje
    // generico de transicion invalida).
    if (wantsStatus && dto.status === 'CLOSED') {
      throw new AppException(
        'El estado CLOSED fue deprecado. Los tickets terminan en RESOLVED.',
        'TICKET_CLOSE_DEPRECATED',
        410,
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

    const updated = await this.prisma.$transaction(async (tx) => {
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
          await this.outbox.enqueueTx(tx, {
            eventType: 'STATUS_CHANGED',
            aggregateId: ticketId,
            organizationId: ticket.organizationId,
            payload: { ticketId },
          });
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
  // Cerrar ticket (endpoint dedicado)
  // ────────────────────────────────────────────────────────────

  async closeTicket(ticketId: string, dto: CloseTicketDto, userId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { task: { select: { id: true, status: true, projectId: true } } },
    });
    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    if (ticket.status === 'CLOSED') {
      throw new AppException(
        'El ticket ya esta cerrado',
        'ALREADY_CLOSED',
        400,
      );
    }

    this.validateStatusTransition(ticket.status, 'CLOSED');

    const previousStatus = ticket.status;

    // Capturar los flags ANTES de la tx para decidir emision de eventos SLA
    // (firstResponseAt y resolvedAt se setean dentro de la tx solo si eran null).
    const willSetFirstResponse = ticket.firstResponseAt === null;
    const willSetResolved = ticket.resolvedAt === null;

    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'CLOSED',
          closeReason: dto.reason as TicketCloseReason,
          closeNote: dto.note ?? null,
          closedAt: new Date(),
          closedByUserId: userId,
          // SLA auto-marks
          ...(willSetFirstResponse && { firstResponseAt: new Date() }),
          ...(willSetResolved && { resolvedAt: new Date() }),
        },
      });

      await this.events.writeEventTx(tx, {
        ticketId,
        type: 'CLOSED',
        fromValue: previousStatus,
        toValue: 'CLOSED',
        source: 'TICKET',
        userId,
        metadata: { reason: dto.reason, note: dto.note },
      });

      // Audit timeline para hitos SLA: FIRST_RESPONSE / RESOLVED.
      // Solo se emiten si el cierre fuerza la marca por primera vez.
      if (willSetFirstResponse) {
        await this.events.writeEventTx(tx, {
          ticketId,
          type: 'FIRST_RESPONSE',
          source: 'TICKET',
          userId,
        });
      }
      if (willSetResolved) {
        await this.events.writeEventTx(tx, {
          ticketId,
          type: 'RESOLVED',
          source: 'TICKET',
          userId,
        });
      }

      // Sync task → DONE (a menos que el ticket se cerró sin resolverse,
      // en cuyo caso preservamos el comportamiento legacy: cancelar la task)
      if (ticket.task) {
        const wasNeverResolved = ticket.resolvedAt === null && previousStatus !== 'RESOLVED';
        if (wasNeverResolved) {
          if (ticket.task.status !== 'CANCELLED') {
            await tx.task.update({
              where: { id: ticket.task.id },
              data: { status: 'CANCELLED' },
            });
            this.pendingEvents.push(() => {
              this.eventEmitter.emit('task.updated', {
                taskId: ticket.task!.id,
                status: 'CANCELLED',
                projectId: ticket.task!.projectId,
                reason: 'ticket_closed_unresolved',
                organizationId: ticket.organizationId,
              });
            });
          }
        } else {
          await this.syncTaskToStatus(tx, ticket.task.id, 'DONE', userId, ticket.organizationId);
        }
      }
    });

    this.flushPendingEvents();

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
        targetTicketStatus = 'IN_REVIEW';
        break;
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

    if (this.config.slaCascadeEnabled) {
      // ── PATH NUEVO: cascada contrato → proyecto → cliente → criticidad → "Estándar".
      // El motor de cálculo (horas hábiles + feriados) es el MISMO; cambia solo de
      // dónde salen los tiempos. Los deadlines se congelan igual que hoy.
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
    } else if (categoryConfig) {
      // ── PATH ACTUAL (default): SlaConfig por criticidad. NO se toca una línea.
      const slaConfig = await this.slaResolver.findLegacySlaConfig(
        orgId,
        categoryConfig.criticality,
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

    // Campos SLA v2 del ticket. Con el flag OFF el objeto queda VACÍO → el create es
    // byte-por-byte el de hoy (ni siquiera se envían las columnas nuevas).
    const slaCascadeData = this.config.slaCascadeEnabled
      ? {
          ...(slaPolicyId && { slaPolicyId }),
          ...(slaSource && { slaSource }),
          ...(ticketTypeId && { ticketTypeId }),
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
        await this.outbox.enqueueTx(tx, {
          eventType: 'TICKET_CREATED',
          aggregateId: created.id,
          organizationId: orgId,
          payload: {
            ticketId: created.id,
            clientId: dto.clientId,
            projectId: dto.projectId,
          },
        });
      }

      return created;
    });

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
