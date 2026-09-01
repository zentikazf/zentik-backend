import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Request, Response } from 'express';
import { Prisma, SlaSource, TicketCriticality } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { AppException } from '../../common/filters/app-exception';
import { CreateSuggestionDto } from './dto/create-suggestion.dto';
import { UpdateSuggestionDto } from './dto/update-suggestion.dto';
// #61 — única fuente de verdad de «qué factura puede ver el cliente» (no se reescribe inline).
import { isPortalVisibleInvoice, PORTAL_VISIBLE_INVOICE_WHERE } from './invoice-visibility.util';
import { domainEvent } from '../../common/events/domain-event.helper';
import { CreateTicketDto } from '../ticket/dto/create-ticket.dto';
import { AuditService } from '../audit/audit.service';
import { calculateBusinessDeadline, parseBusinessDays } from '../sla/sla.util';
import { generateTicketNumber } from '../ticket/ticket.service';
import { FileService } from '../file/file.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { OutboxService } from '../sync/outbox.service';
import { ClientBillingPdfService } from '../client-billing/client-billing-pdf.service';
import { SlaResolverService } from '../sla/sla-resolver.service';
import {
  CriticalityConfigService,
  parseCriticality,
} from '../sla/criticality-config.service';
import { TicketTypeAvailabilityService } from '../sla/ticket-type-availability.service';

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly auditService: AuditService,
    private readonly fileService: FileService,
    private readonly storage: StorageService,
    private readonly outbox: OutboxService,
    private readonly pdfService: ClientBillingPdfService,
    private readonly config: AppConfigService,
    // Feature #42 — Fase 1: solo se usa con `SLA_CASCADE_ENABLED=true`.
    private readonly slaResolver: SlaResolverService,
    // Feature #42 — Fase 2: validación server-side de lo que elige el cliente
    // (criticidad visible + tipo disponible). Independiente del feature flag.
    private readonly criticalityConfig: CriticalityConfigService,
    private readonly ticketTypeAvailability: TicketTypeAvailabilityService,
  ) {}

  private async getClientByUserId(userId: string) {
    // Check if owner
    const clientAsOwner = await this.prisma.client.findFirst({
      where: { userId },
    });
    if (clientAsOwner) return clientAsOwner;

    // Check if sub-user
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { clientId: true },
    });
    if (user?.clientId) {
      const client = await this.prisma.client.findUnique({
        where: { id: user.clientId },
      });
      if (client) return client;
    }

    throw new AppException('No se encontró un perfil de cliente', 'CLIENT_NOT_FOUND', 403);
  }

  async getProjects(userId: string) {
    const client = await this.getClientByUserId(userId);

    const projects = await this.prisma.project.findMany({
      where: { clientId: client.id, lifecycleStatus: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        status: true,
        startDate: true,
        endDate: true,
        createdAt: true,
        _count: {
          select: {
            suggestions: true,
          },
        },
        tasks: {
          where: { clientVisible: true, status: { not: 'CANCELLED' } },
          select: { status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return projects.map((p) => {
      const visibleTasks = p.tasks.length;
      const completedTasks = p.tasks.filter((t) => t.status === 'DONE').length;
      const progress = visibleTasks > 0 ? Math.round((completedTasks / visibleTasks) * 100) : 0;

      return {
        id: p.id,
        name: p.name,
        status: p.status,
        startDate: p.startDate,
        endDate: p.endDate,
        createdAt: p.createdAt,
        suggestionsCount: p._count.suggestions,
        visibleTasks,
        completedTasks,
        progress,
      };
    });
  }

  async getProjectDetail(userId: string, projectId: string) {
    const client = await this.getClientByUserId(userId);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        startDate: true,
        endDate: true,
        alcanceStatus: true,
        alcanceFileId: true,
        alcanceFile: {
          select: {
            id: true,
            originalName: true,
            mimeType: true,
            size: true,
            createdAt: true,
          },
        },
        sprints: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            name: true,
            status: true,
            startDate: true,
            endDate: true,
          },
          orderBy: { startDate: 'asc' },
        },
      },
    });

    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    const tasks = await this.prisma.task.findMany({
      where: { projectId, clientVisible: true, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        dueDate: true,
        updatedAt: true,
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    const totalVisible = tasks.length;
    const completedTasks = tasks.filter((t) => t.status === 'DONE').length;
    const progress = totalVisible > 0 ? Math.round((completedTasks / totalVisible) * 100) : 0;

    return {
      ...project,
      tasks,
      totalVisible,
      completedTasks,
      progress,
    };
  }

  async getGlobalSuggestions(userId: string) {
    const client = await this.getClientByUserId(userId);

    return this.prisma.suggestion.findMany({
      where: { clientId: client.id },
      include: { 
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true, status: true } }
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSuggestions(userId: string, projectId: string) {
    const client = await this.getClientByUserId(userId);

    // Validate project belongs to client
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    return this.prisma.suggestion.findMany({
      where: { projectId, clientId: client.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSuggestion(userId: string, projectId: string, dto: CreateSuggestionDto) {
    const client = await this.getClientByUserId(userId);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    const suggestion = await this.prisma.suggestion.create({
      data: {
        projectId,
        clientId: client.id,
        title: dto.title,
        description: dto.description,
        priority: dto.priority,
      },
    });

    this.logger.log(`Suggestion created: ${suggestion.id} by client: ${client.id}`);

    this.eventEmitter.emit('suggestion.created', {
      ...domainEvent('suggestion.created', 'suggestion', suggestion.id, project.organizationId, userId),
      suggestionId: suggestion.id,
      title: suggestion.title,
      projectId,
      clientName: client.name,
    });

    return suggestion;
  }

  // ── Project Request (Portal) ────────────────────────────

  async requestProject(userId: string, dto: { name: string; description?: string }) {
    const client = await this.getClientByUserId(userId);

    if (!client.organizationId) {
      throw new AppException('El cliente no tiene organización asociada', 'CLIENT_NO_ORG', 400);
    }

    const slug = dto.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const project = await this.prisma.project.create({
      data: {
        organizationId: client.organizationId,
        name: dto.name,
        description: dto.description || null,
        slug: `${slug}-${Date.now()}`,
        status: 'DISCOVERY',
        clientId: client.id,
        pendingClientReview: true,
        createdById: userId,
      },
    });

    this.logger.log(`Project requested by client ${client.id}: ${project.id}`);

    this.eventEmitter.emit('project.requested', {
      ...domainEvent('project.requested', 'project', project.id, client.organizationId, userId, { name: dto.name }),
      projectId: project.id,
      clientName: client.name,
    });

    return project;
  }

  // ── Admin methods ──────────────────────────────────────

  async getProjectSuggestions(projectId: string) {
    return this.prisma.suggestion.findMany({
      where: { projectId },
      include: {
        client: { select: { id: true, name: true, email: true } },
        task: { select: { id: true, title: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateSuggestion(projectId: string, suggestionId: string, dto: UpdateSuggestionDto) {
    const suggestion = await this.prisma.suggestion.findFirst({
      where: { id: suggestionId, projectId },
    });
    if (!suggestion) {
      throw new AppException('Sugerencia no encontrada', 'SUGGESTION_NOT_FOUND', 404);
    }

    return this.prisma.suggestion.update({
      where: { id: suggestionId },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.adminNotes !== undefined && { adminNotes: dto.adminNotes }),
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
      },
    });
  }

  // ── Ticket methods (Portal) ────────────────────────────

  async getTickets(
    userId: string,
    filters?: {
      projectId?: string;
      createdByUserId?: string;
    },
  ) {
    const client = await this.getClientByUserId(userId);

    // Un cliente individual tiene POCOS tickets (volumen bajo): el portal trae
    // TODO el set del cliente y filtra/pagina/cuenta 100% client-side (feature
    // #12, opcion B del review). NO se pagina server-side — un paginador
    // numerado offset desincronizaba los filtros de status/search/proyecto que
    // el portal aplica en el cliente. Shape { data, meta: { total } } para que
    // el frontend lea el total del set completo del cliente.
    const where: Prisma.TicketWhereInput = {
      clientId: client.id,
      ...(filters?.projectId && { projectId: filters.projectId }),
      ...(filters?.createdByUserId && { createdByUserId: filters.createdByUserId }),
    };

    // ⚠️ `select` explícito, igual que getTicketDetail: el `include` devolvía todos
    // los escalares — `adminNotes` (notas internas del staff) incluido — para CADA
    // ticket del listado. Este endpoint responde al cliente.
    const data = await this.prisma.ticket.findMany({
      where,
      select: {
        id: true,
        ticketNumber: true,
        title: true,
        description: true,
        category: true,
        status: true,
        priority: true,
        criticality: true,
        createdAt: true,
        project: { select: { id: true, name: true } },
        task: { select: { id: true, status: true } },
        createdByUser: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      data,
      meta: {
        total: data.length,
      },
    };
  }

  /**
   * Detalle del ticket para el CLIENTE.
   *
   * Qué ve (#42 Fase 2.1): el tipo con el que el equipo lo tipificó (`ticketType`),
   * su criticidad, y su propia declaración (`reportedTicketType` + el escalar
   * `reportedCriticality`) — así el portal puede mostrar "reportaste X · el equipo
   * lo clasificó como Y" sin inventar datos.
   *
   * Qué NO ve, a propósito:
   * - `categoryConfig`: la categoría es clasificación INTERNA del equipo.
   * - `slaPolicy`: los plazos comprometidos son información contractual y hoy no
   *   existe un ajuste por organización que habilite mostrarla en el portal. Se
   *   expone recién cuando ese ajuste exista (decisión de negocio, no de código).
   */
  async getTicketDetail(userId: string, ticketId: string) {
    const client = await this.getClientByUserId(userId);

    // ⚠️ `select` EXPLÍCITO, nunca `include` a secas. El `include` sin `select` en el
    // nivel superior devolvía TODOS los escalares del ticket — `adminNotes` incluido,
    // que el portal renderizaba como "Respuesta del equipo" mientras la UI del staff
    // prometía "no son visibles para el cliente". Este endpoint responde al CLIENTE:
    // cada campo que se agrega acá tiene que poder leerlo el cliente.
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, clientId: client.id },
      select: {
        id: true,
        ticketNumber: true,
        title: true,
        description: true,
        category: true,
        status: true,
        priority: true,
        criticality: true,
        ticketTypeId: true,
        responseDeadline: true,
        resolutionDeadline: true,
        createdAt: true,
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true, status: true } },
        channel: { select: { id: true, name: true } },
        createdByUser: { select: { id: true, name: true } },
        ticketType: { select: { id: true, name: true } },
        reportedTicketType: { select: { id: true, name: true } },
      },
    });

    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    return ticket;
  }

  async createTicket(userId: string, projectId: string, dto: CreateTicketDto) {
    const client = await this.getClientByUserId(userId);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
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
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    // Resolve dynamic category → categoryConfigId + SLA
    let categoryConfigId: string | undefined;
    let criticality: string | undefined;
    let responseDeadline: Date | undefined;
    let resolutionDeadline: Date | undefined;
    // SLA v2 (feature #42 — Fase 1): SOLO se llenan con `SLA_CASCADE_ENABLED=true`.
    let slaPolicyId: string | undefined;
    let slaSource: SlaSource | undefined;
    // Contrato viejo: `category` ahora es opcional (el form de Fase 2 no la manda).
    const rawCategory = dto.category ?? '';

    if (rawCategory.startsWith('dynamic:')) {
      const configId = rawCategory.slice('dynamic:'.length);
      const categoryConfig = await this.prisma.ticketCategoryConfig.findFirst({
        where: { id: configId, organizationId: project.organizationId, isActive: true },
      });
      if (categoryConfig) {
        categoryConfigId = categoryConfig.id;
        criticality = categoryConfig.criticality;
      }
    }

    // ── Fase 2: tipo + criticidad elegidos por el cliente ────────────────────
    // Validación SERVER-SIDE, nunca confiando en el front (checklist de seguridad
    // del blueprint): el form puede estar cacheado, manipulado o desactualizado.
    let ticketTypeId: string | null = null;
    if (dto.ticketTypeId) {
      const available = await this.ticketTypeAvailability.isTypeAvailable(
        project.organizationId,
        projectId,
        dto.ticketTypeId,
      );
      if (!available) {
        throw new AppException(
          'El tipo de solicitud no está disponible para este proyecto',
          'TICKET_TYPE_NOT_AVAILABLE',
          400,
        );
      }
      ticketTypeId = dto.ticketTypeId;
    }

    if (dto.criticality) {
      const visibles = await this.criticalityConfig.getClientVisible(project.organizationId);
      if (!visibles.some((v) => v.criticality === dto.criticality)) {
        throw new AppException(
          'La criticidad elegida no está habilitada para clientes',
          'CRITICALITY_NOT_CLIENT_VISIBLE',
          400,
        );
      }
      criticality = dto.criticality;
    } else if (!criticality) {
      // Sin criticidad elegida (form viejo sin `dynamic:`, o modo 2B donde ninguna
      // es visible): entra la criticidad por defecto de la organización.
      criticality = await this.criticalityConfig.getDefault(project.organizationId);
    }

    if (this.config.slaCascadeEnabled) {
      // ── PATH NUEVO: cascada. Con el form de Fase 2 el cliente elige el tipo, así
      // que el paso 1 (contrato proyecto+tipo) POR FIN aplica desde el portal; sin
      // tipo (contrato viejo) la cascada sigue arrancando en el paso 2.
      const resolved = await this.slaResolver.resolveAndCalculateDeadlines({
        organizationId: project.organizationId,
        clientId: client.id,
        projectId,
        ticketTypeId,
        // Cast puntual: `criticality` sale de la columna del enum (viene tipada
        // como string por el path viejo).
        criticality: (criticality as TicketCriticality | undefined) ?? null,
      });
      slaPolicyId = resolved.policy?.id ?? undefined;
      slaSource = resolved.source;
      responseDeadline = resolved.responseDeadline ?? undefined;
      resolutionDeadline = resolved.resolutionDeadline ?? undefined;
    } else if (criticality) {
      // ── PATH ACTUAL (default): SlaConfig por criticidad.
      //
      // ⚠️ NO agregar `categoryConfigId &&` a esta condición (#42, hallazgo C1 del
      // review). El form nuevo del portal dejo de mandar `category`, y por lo tanto
      // `categoryConfigId` queda undefined: con el gate viejo, un ticket creado con
      // el flag APAGADO no entraba ni a la cascada ni aca, y se guardaba SIN
      // deadlines — en silencio y para siempre (los deadlines se congelan al crear).
      // Era una regresion del 100% sobre el canal de mayor volumen, y ademas dejaba
      // el rollback del ADR sin efecto: apagar el flag no restauraba nada.
      //
      // `categoryConfigId` nunca fue una dependencia real de este path: la query de
      // abajo busca por `organizationId_criticality`, no usa la categoria. Era solo
      // el vehiculo historico por el que llegaba la criticidad. Hoy `criticality`
      // SIEMPRE queda resuelta (elegida y validada contra clientVisible, o el
      // default de la organizacion), asi que gatear por ella alcanza y sobra.
      // Con fallback + log: sin fila para esta criticidad el ticket quedaba sin
      // deadlines en silencio (hallazgo C1' del review — ver findLegacySlaConfig).
      const slaConfig = await this.slaResolver.findLegacySlaConfig(
        project.organizationId,
        criticality as TicketCriticality,
      );
      if (slaConfig) {
        const [bhConfig, holidayRows] = await Promise.all([
          this.prisma.businessHoursConfig.findUnique({ where: { organizationId: project.organizationId } }),
          this.prisma.holiday.findMany({ where: { organizationId: project.organizationId }, select: { date: true } }),
        ]);
        const bh = bhConfig ? {
          start: bhConfig.businessHoursStart,
          end: bhConfig.businessHoursEnd,
          days: parseBusinessDays(bhConfig.businessDays),
          timezone: bhConfig.timezone,
        } : undefined;
        const holidays = holidayRows.map((h) => h.date);
        const now = new Date();
        responseDeadline = calculateBusinessDeadline(now, slaConfig.responseTimeMinutes, bh, holidays);
        resolutionDeadline = calculateBusinessDeadline(now, slaConfig.resolutionTimeMinutes, bh, holidays);
      }
    }

    // Con el flag OFF el objeto queda VACÍO → el create es exactamente el de hoy.
    const slaCascadeData = this.config.slaCascadeEnabled
      ? {
          ...(slaPolicyId && { slaPolicyId }),
          ...(slaSource && { slaSource }),
        }
      : {};

    // Sin `category` (form de Fase 2) el ticket del portal es de Soporte, igual que
    // el `category: 'SUPPORT_REQUEST'` que se persiste más abajo. Solo las categorías
    // de desarrollo cambian la etiqueta del canal (paridad con el comportamiento actual).
    const categoryLabel =
      rawCategory === 'NEW_DEVELOPMENT' || rawCategory === 'NEW_PROJECT' ? 'Desarrollo' : 'Soporte';
    const channelName = `[${categoryLabel}] ${dto.title}`;
    const taskTitle = `[Ticket] ${dto.title}`;

    // Collect all org member user IDs for the channel
    const orgMemberIds = project.members.map((m) => m.userId);
    // Add client user if not already present
    if (userId && !orgMemberIds.includes(userId)) {
      orgMemberIds.push(userId);
    }
    // Add project responsible if exists
    if (project.responsibleId && !orgMemberIds.includes(project.responsibleId)) {
      orgMemberIds.push(project.responsibleId);
    }
    // Add Product Owners and Project Managers from the organization
    const poAndPm = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: project.organizationId,
        role: { name: { in: ['Product Owner', 'Project Manager'] } },
      },
      select: { userId: true },
    });
    for (const member of poAndPm) {
      if (!orgMemberIds.includes(member.userId)) {
        orgMemberIds.push(member.userId);
      }
    }

    // #50 (D8/R4.3): bandera de scope EXTERNO a la tx. `enqueueTx` devuelve true
    // solo si escribió fila (los gates de flag/whitelist de orgs viven adentro).
    // El aviso al dispatcher (`notifyEnqueued`) va POST-COMMIT: adentro de la tx no
    // serviría — si revierte, la fila desaparece con ella y no hay nada que drenar.
    let outboxEnqueued = false;

    const ticket = await this.prisma.$transaction(async (tx) => {
      // Ticket relacionado (feature #11): si viene relatedTicketId, validar que
      // exista y pertenezca al MISMO cliente del user; si no, 400. Dentro de la tx
      // para consistencia con la creación.
      if (dto.relatedTicketId) {
        const related = await tx.ticket.findFirst({
          where: { id: dto.relatedTicketId, clientId: client.id },
          select: { id: true },
        });
        if (!related) {
          throw new AppException('Ticket relacionado inválido', 'INVALID_RELATED_TICKET', 400);
        }
      }

      // 1. Create the task in the project kanban
      const maxPosition = await tx.task.aggregate({
        where: { projectId },
        _max: { position: true },
      });

      // Find the BACKLOG column ("Nuevo") so the task appears en la columna inicial
      const backlogColumn = await tx.boardColumn.findFirst({
        where: {
          mappedStatus: 'BACKLOG',
          board: { projectId },
        },
        orderBy: { position: 'asc' },
      });

      const task = await tx.task.create({
        data: {
          projectId,
          title: taskTitle,
          description: dto.description,
          priority: (dto.priority as any) ?? 'MEDIUM',
          status: 'BACKLOG',
          type: 'SUPPORT',
          position: (maxPosition._max.position ?? -1) + 1,
          createdById: project.createdById,
          clientVisible: true,
          ...(backlogColumn && { boardColumnId: backlogColumn.id }),
        },
      });

      // 2. Create the TICKET channel with all members
      const channel = await tx.channel.create({
        data: {
          name: channelName,
          type: 'TICKET',
          organizationId: project.organizationId,
          createdById: project.createdById,
          members: {
            create: orgMemberIds.map((id) => ({ userId: id })),
          },
        },
      });

      // 3. Create the ticket linking task and channel
      const ticketNumber = await generateTicketNumber(tx, project.organizationId);

      const created = await tx.ticket.create({
        data: {
          organizationId: project.organizationId,
          projectId,
          clientId: client.id,
          title: dto.title,
          description: dto.description,
          category: 'SUPPORT_REQUEST' as any,
          priority: (dto.priority as any) ?? 'MEDIUM',
          taskId: task.id,
          channelId: channel.id,
          createdByUserId: userId,
          ticketNumber,
          ...(categoryConfigId && { categoryConfigId }),
          ...(criticality && { criticality: criticality as any }),
          ...(responseDeadline && { responseDeadline }),
          ...(resolutionDeadline && { resolutionDeadline }),
          ...(dto.relatedTicketId && { relatedTicketId: dto.relatedTicketId }),
          // El tipo es CLASIFICACIÓN, no salida del motor de SLA: se persiste
          // también con `SLA_CASCADE_ENABLED` apagado (si no, se perdería lo que
          // el cliente eligió en el form). `slaPolicyId`/`slaSource` sí van gateados.
          ...(ticketTypeId && { ticketTypeId }),
          // ── #42 Fase 2.1: DECLARACIÓN DEL CLIENTE, congelada ────────────────
          // Espejo de `ticketTypeId` / `criticality` en el instante del alta desde
          // el PORTAL. Se escriben UNA sola vez, acá, y NO se modifican NUNCA
          // (ver `reclassify` en ticket.service.ts): cuando el equipo reclasifica,
          // `ticketTypeId`/`criticality` pasan a ser lo que el equipo determinó y
          // estas dos siguen respondiendo "¿qué reportó el cliente?" sin tener que
          // reconstruirlo leyendo el timeline de eventos.
          // Quedan en null en el alta por admin (no hay declaración de cliente) y
          // en todo lo histórico anterior a esta fase.
          ...(ticketTypeId && { reportedTicketTypeId: ticketTypeId }),
          // Cast puntual: `criticality` es `string` por el path viejo (`dynamic:`),
          // pero siempre sale del enum (categoría, elección validada o default).
          ...(criticality && { reportedCriticality: criticality as TicketCriticality }),
          ...slaCascadeData,
        },
        include: {
          project: { select: { id: true, name: true } },
          task: { select: { id: true, title: true, status: true } },
          channel: { select: { id: true, name: true } },
        },
      });

      // Outbox sync Onnix (feature #13): encolar en la MISMA tx (R1, R9).
      // Sin gate por categoría: el portal SIEMPRE crea tickets SUPPORT_REQUEST
      // (ver `category: 'SUPPORT_REQUEST'` arriba en el create), que es justo el
      // scope de la integración Onnix → todos los tickets del portal se encolan.
      // El gate por categoría solo aplica al admin (ticket.service.createTicket),
      // que sí puede crear otras categorías.
      const wrote = await this.outbox.enqueueTx(tx, {
        eventType: 'TICKET_CREATED',
        aggregateId: created.id,
        organizationId: project.organizationId,
        payload: { ticketId: created.id, clientId: client.id, projectId },
      });
      if (wrote) outboxEnqueued = true;

      return created;
    });

    // #50 (D8/R4.1): drain-on-enqueue. Recién acá, con la tx COMMITEADA, la fila
    // existe y es visible para el dispatcher. Best-effort puro: si nadie escucha o
    // el drain falla, el cron horario (R4.2) la levanta igual.
    if (outboxEnqueued) {
      this.outbox.notifyEnqueued();
    }

    this.logger.log(`Ticket created: ${ticket.id} by client: ${client.id} for project: ${projectId}`);

    await this.auditService.create({
      organizationId: project.organizationId,
      userId,
      action: 'ticket.created',
      resource: 'ticket',
      resourceId: ticket.id,
      newData: {
        title: dto.title,
        category: dto.category ?? null,
        ticketTypeId,
        criticality: criticality ?? null,
        projectId,
        clientName: client.name,
      },
    });

    this.eventEmitter.emit('ticket.created', {
      ...domainEvent('ticket.created', 'ticket', ticket.id, project.organizationId, userId),
      ticketId: ticket.id,
      title: dto.title,
      category: dto.category ?? null,
      projectId,
      clientName: client.name,
    });

    return ticket;
  }

  // ── Criticidad + tipo (feature #42 — Fase 2) ───────────────

  /**
   * Criticidades que el cliente puede elegir, con su etiqueta de cara al cliente.
   *
   * Devolver `[]` es un estado VÁLIDO: el front no renderiza el selector y el
   * ticket entra con la criticidad por defecto de la organización (modo 2B, se
   * activa desmarcando checkboxes — sin deploy).
   */
  async getCriticalities(userId: string) {
    const client = await this.getClientByUserId(userId);
    return this.criticalityConfig.getClientVisible(client.organizationId);
  }

  /**
   * Tipos de solicitud ofrecibles en un proyecto del cliente.
   * `fallback: true` = el proyecto no tiene contratos → modo permisivo.
   */
  async getProjectTicketTypes(userId: string, projectId: string, criticality?: string) {
    const client = await this.getClientByUserId(userId);

    // El proyecto tiene que ser DEL cliente logueado (mismo scoping que el resto
    // del portal): uno de otro cliente se trata como inexistente.
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
      select: { id: true, organizationId: true },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    // Lectura del CLIENTE: filtra por `clientVisible` (#48 R2.2, call site 1).
    return this.ticketTypeAvailability.getAvailableTypes(project.organizationId, project.id, {
      criticality: parseCriticality(criticality),
      audience: 'CLIENT',
    });
  }

  // ─── #62 — Los tres estados de facturación del portal ───────────────────────────────
  //
  // El KPI único "Total facturable" filtraba `billedCycleId === null`, y el estampado ocurre
  // al EMITIR (`closeCycle`), donde el ciclo nace en `DRAFT`. Consecuencia: generar un
  // BORRADOR —que el cliente ni siquiera ve— le hacía desaparecer las horas del pendiente.
  // Veía bajar su total sin que existiera ninguna factura para él y sin que nadie hubiera
  // cobrado nada.
  //
  // ⚠️ EL ESTAMPADO NO SE MUEVE. La tentación es sellar `billedCycleId` recién al enviar; es
  // la solución equivocada. Estampar al emitir es lo que CONGELA EL CONJUNTO, que es la
  // garantía que el propio diálogo de cierre le promete al usuario ("este período queda
  // congelado: los movimientos incluidos pasan a ser de solo lectura"). Si se estampara al
  // enviar, entre generar y enviar el conjunto podría cambiar solo y la factura enviada
  // dejaría de ser la que se revisó.
  //
  // El arreglo es de LECTURA: el portal deja de mirar sólo "¿tiene ciclo?" y pasa a mirar EN
  // QUÉ ESTADO está el ciclo al que apunta:
  //
  //   null | DRAFT     → PENDIENTE  (trabajo que todavía no se facturó)   ← el fix
  //   SENT             → FACTURADO  (ya está en una factura enviada)
  //   PAID             → COBRADO    (facturas pagadas)
  //   CANCELLED / otro → PENDIENTE  (fail-safe; ver `stateOf`)
  async getMyHours(userId: string) {
    const client = await this.getClientByUserId(userId);
    const available = Math.max(client.contractedHours - client.usedHours - client.loanedHours, 0);

    // Solo descuentos consumidos (USAGE/LOAN), nunca borrados, nunca PURCHASE/REFUND.
    // El cliente solo ve lo que se le descontó, no movimientos administrativos.
    // Un solo objeto para las dos consultas de movimientos: si el criterio de "qué es un
    // descuento del cliente" cambia, la lista que se pinta y los totales no pueden divergir.
    const consumedByClient = {
      clientId: client.id,
      type: { in: ['USAGE', 'LOAN'] },
      deletedAt: null,
    } satisfies Prisma.HoursTransactionWhereInput;

    const [recentTransactions, sumsByCycle, creditedByCycle, cycles] = await Promise.all([
      // (1) La VENTANA QUE SE PINTA: los últimos 100 movimientos. No alcanza para los totales
      //     —ver (2)—, pero es lo que la pantalla lista.
      this.prisma.hoursTransaction.findMany({
        where: consumedByClient,
        // ⚠️ `select` EXPLÍCITO, nunca `include` a secas — misma regla que `getTicketDetail`
        // (ver el comentario de ese método arriba). Este endpoint responde al CLIENTE: cada campo
        // que se agregue acá tiene que poder leerlo el cliente.
        //
        // #55 escondió la jerga interna de la PANTALLA pero no del PAYLOAD: con `include` sin
        // `select` de nivel superior, /portal/hours mandaba al navegador del cliente TODOS los
        // escalares del ledger — `timeEntryId`, `entryVersion`, `reversesTransactionId`,
        // `deletedById`, `deleteReason`, `clientId` — visibles con DevTools > Network. Ninguno lo
        // usa el portal y ninguno es información del cliente: son plomería interna del ledger.
        //
        // La lista de abajo es EXACTAMENTE lo que consume `app/(portal)/portal/hours/page.tsx`
        // (interface `HoursTransaction` + JSX) más lo que este mismo método necesita para los
        // buckets (`priceAmount`, `billedCycleId`). Enumerar es donde es fácil dropear un campo
        // vivo, así que si mañana el portal necesita uno nuevo hay que AGREGARLO acá — el
        // síntoma de olvidarse es una columna en '—', no un error.
        select: {
          id: true,
          type: true,
          hours: true,
          note: true, // alimenta el concepto del cliente cuando no hay tarea (ver `safeConceptOf`)
          createdAt: true,
          workedOn: true, // agrupa el mes (workedOn con fallback a createdAt, `monthKeyOf`)
          priceAmount: true,
          priceRate: true,
          priceCurrency: true,
          // #62: sigue viajando (no se rompe ningún consumidor) pero YA NO decide el badge de la
          // fila: eso lo dice `billingState`, que sale de mirar el ESTADO del ciclo. Un movimiento
          // estampado en un BORRADOR tiene `billedCycleId` y NO está facturado.
          billedCycleId: true,
          rebilledFromTransactionId: true, // empareja original y copia re-facturable
          task: {
            select: {
              id: true,
              title: true,
              type: true,
              project: { select: { id: true, name: true } },
            },
          },
          // #55 — FUENTE DE VERDAD de "a este movimiento se le emitió una nota de crédito".
          //
          // Es la línea de la NC (`CreditNoteLine.creditedTransactionId`, @unique en el schema), NO la
          // existencia de la fila espejo re-facturable. La fila espejo sólo nace cuando el staff deja
          // activado "devolver horas al pool" (es un switch del diálogo) y además se puede borrar, así
          // que deducir el acreditado desde ella daba dos falsos negativos: el portal seguía mostrando
          // el cargo firme al precio completo mientras /portal/invoices ya le mostraba al cliente la NC
          // en negativo — las dos pantallas contradiciéndose sobre la misma plata.
          //
          // `description` es el concepto CONGELADO al emitir la NC (`task.title ?? note` de ese
          // momento): sobrevive al borrado en duro de la tarea (onDelete SetNull) y es texto seguro
          // para el cliente, a diferencia del `note` de la fila espejo, que es jerga interna
          // ("Re-facturable por NC-…").
          creditedByLine: {
            select: {
              description: true,
              creditNote: { select: { number: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),

      // (2) LOS TRES BUCKETS, sobre TODO el historial. No se calculan sobre `recentTransactions`
      //     a propósito: esa lista tiene `take: 100`, y lo COBRADO es justamente lo VIEJO — lo
      //     primero que se cae de una ventana de 100 filas ordenada por `createdAt desc`. Con el
      //     KPI único el recorte casi no se notaba (lo pendiente suele ser lo reciente); con tres
      //     buckets, "Cobrado" saldría arbitrariamente corto para cualquier cliente con historia.
      //     Es un AGREGADO —una fila por ciclo, no una por movimiento—, así que no crece con el
      //     volumen del ledger.
      this.prisma.hoursTransaction.groupBy({
        by: ['billedCycleId'],
        where: { ...consumedByClient, priceAmount: { not: null } },
        _sum: { priceAmount: true, hours: true },
      }),

      // (2-bis) #65 A3 — CUÁNTO DE CADA CICLO YA SE ACREDITÓ.
      //
      // El bug que cierra: el cliente veía el mismo trabajo sumado dos veces en su propia
      // pantalla de facturación. Al emitir una nota de crédito, la fila ORIGINAL conserva su
      // `billedCycleId` (la factura es un snapshot inmutable, client-billing.service.ts:1470)
      // así que sigue cayendo en Facturado/Cobrado; y la fila ESPEJO nace con `billedCycleId`
      // null, así que cae en Pendiente. El `totalAmount` negativo de la NC no se restaba en
      // ningún lado. Resultado: 2× el importe y 2× las horas por un trabajo que se hizo una vez.
      //
      // Mismo eje y misma forma que (2) para que entre en el mismo loop de clasificación.
      // El predicado es `creditedByLine`, la relación 1:1 con `CreditNoteLine`
      // (schema.prisma:1620), que es la ÚNICA fuente de verdad de "esta fila fue acreditada":
      // deducirlo desde la existencia de la espejo da dos falsos negativos (la espejo es
      // opcional y además borrable), que fue el hallazgo de #55.
      //
      // Por qué RESTAR y no excluir del `where` de (2): excluyéndolas, la plata acreditada
      // desaparecería sin dejar rastro y el detalle de la factura dejaría de cuadrar con el PDF
      // que el cliente ya tiene. Restando, el importe acreditado se expone aparte
      // (`creditedAmount`) y la card puede explicar su propio número.
      //
      // El `@unique` de `creditedTransactionId` (schema.prisma:1777) garantiza que el LEFT JOIN
      // no abanique filas: el `_sum` no se puede inflar. Y la fila espejo no entra por accidente
      // — nace sin `CreditNoteLine` propia.
      this.prisma.hoursTransaction.groupBy({
        by: ['billedCycleId'],
        where: { ...consumedByClient, priceAmount: { not: null }, creditedByLine: { isNot: null } },
        _sum: { priceAmount: true, hours: true },
      }),

      // (3) Los ciclos del cliente, para saber EN QUÉ ESTADO cayó cada estampado. Va en el mismo
      //     `Promise.all` que las otras dos —no depende del resultado de ninguna—, así que las
      //     tres salen en un solo viaje y no hay un round-trip por movimiento.
      //
      //     ⚠️ #55: `select` mínimo. De acá sale lo que se le muestra al cliente, así que NO se
      //     piden `notes` (notas internas del staff), `cancelReason`, `cancelledById`,
      //     `closedById`, `variablesBilling` ni `organizationId`. `status`/`sentAt` se usan sólo
      //     para CLASIFICAR y para la regla de visibilidad; no viajan crudos en el payload.
      this.prisma.clientBillingCycle.findMany({
        where: { clientId: client.id },
        select: {
          id: true,
          invoiceNumber: true,
          kind: true,
          periodStart: true,
          periodEnd: true,
          cutoffDate: true,
          currency: true,
          status: true,
          sentAt: true,
          paidAt: true,
          // #63 — El modo de IVA ESTAMPADO EN ESTE CICLO, que es lo único que puede etiquetar una
          // factura ya emitida. NO se piden `taxRate`/`netAmount`/`taxAmount`: la etiqueta sale del
          // MODO y nada más; el portal no muestra ningún desglose de IVA y esos tres no los necesita
          // (misma regla de `select` mínimo que el resto de este bloque).
          taxMode: true,
        },
      }),
    ]);

    const cycleById = new Map(cycles.map((c) => [c.id, c]));
    const cycleOf = (billedCycleId: string | null) =>
      billedCycleId ? cycleById.get(billedCycleId) : undefined;

    /**
     * El estado de facturación de un movimiento = el ESTADO DEL CICLO al que apunta.
     *
     * Todo lo que no sea `SENT`/`PAID` cae en PENDIENTE, y eso es deliberado:
     *  - `DRAFT` → el fix de #62: un borrador todavía no le movió nada al cliente.
     *  - sin ciclo → nunca se facturó.
     *  - `CANCELLED` → no debería llegar (`reopenCycle` libera el `billedCycleId` de todos los
     *    movimientos al anular, así que vuelven solos a pendiente), pero si un día llega por
     *    deriva de datos, "todavía no te lo facturamos" es la lectura correcta y la segura.
     *  - un estado futuro que nadie enseñó a clasificar → pendiente antes que cobrado.
     *
     * #65 A1.4: `WRITTEN_OFF` (cerrada sin cobro) se clasifica EXPLÍCITAMENTE como INVOICED, y
     * no por el fail-safe de abajo. Si cayera en PENDING, cerrar una factura le movería plata al
     * cliente desde "Facturado" de vuelta a "Pendiente de facturar": le estaríamos diciendo que
     * un trabajo ya facturado volvió a estar sin facturar, por una decisión interna nuestra.
     * INVOICED es lo literalmente cierto (se facturó y no se cobró) y además es el bucket donde
     * la factura ya estaba viniendo de SENT — o sea que el cierre no le cambia nada al cliente,
     * que es exactamente lo correcto. Tampoco va a PAID: no entró plata, y ése es el punto
     * entero de que este estado exista.
     */
    const stateOf = (cycle: { status: string } | undefined): 'PENDING' | 'INVOICED' | 'PAID' => {
      if (cycle?.status === 'SENT' || cycle?.status === 'WRITTEN_OFF') return 'INVOICED';
      if (cycle?.status === 'PAID') return 'PAID';
      return 'PENDING';
    };

    // Los montos se suman con Decimal y salen como string: nada de `parseFloat` acumulado ni
    // aritmética de plata en el navegador (misma regla que el resto de facturación).
    const totals = {
      PENDING: new Prisma.Decimal(0),
      INVOICED: new Prisma.Decimal(0),
      PAID: new Prisma.Decimal(0),
    };
    const invoicesByState: Record<
      'INVOICED' | 'PAID',
      Array<{
        id: string;
        invoiceNumber: string;
        kind: string;
        periodStart: Date;
        periodEnd: Date;
        cutoffDate: Date | null;
        currency: string;
        date: Date | null;
        hours: number;
        amount: string;
        taxMode: string | null; // #63: el estampado de ESTA factura (null = se emitió sin IVA)
        // #65 A3: cuánto de esta factura ya se acreditó. Los campos `amount` y `hours` de
        // arriba vienen NETOS de esto; estos dos dicen de cuánto fue el descuento.
        creditedAmount: string;
        creditedHours: number;
      }>
    > = { INVOICED: [], PAID: [] };

    // Las facturas que componen cada card sólo se listan si el cliente TIENE pantalla de
    // facturación. Sin el flag, /portal/billing lo rebota a /portal: enlazarlo ahí sería mandarlo
    // a una puerta cerrada, y de paso mostrarle números de factura que su organización decidió no
    // mostrarle. Los MONTOS sí salen igual — son sus horas y su plata, y el KPI de hoy ya los
    // muestra sin gate. Mismo criterio de defensa en profundidad que `getMyVariables`.
    const canSeeInvoices = client.portalBillingEnabled === true;

    // #65 A3: lo acreditado por ciclo, indexado igual que los buckets para restarlo en el loop.
    // La clave `null` (movimientos sin facturar) también existe y es legítima: un movimiento sin
    // `billedCycleId` no puede estar acreditado —una NC sólo se emite sobre líneas facturadas—,
    // así que en la práctica ese balde queda en cero, pero el índice no lo asume.
    const creditedOf = new Map(
      creditedByCycle.map((g) => [
        g.billedCycleId,
        {
          // `new Prisma.Decimal(...)` y no el valor crudo: el driver puede entregar el agregado
          // como string, y `.minus()` de abajo necesita un Decimal de verdad. El constructor
          // acepta las dos formas, así que normalizar acá es la defensa barata.
          amount: new Prisma.Decimal(g._sum.priceAmount ?? 0),
          hours: g._sum.hours ?? 0,
        },
      ]),
    );

    for (const group of sumsByCycle) {
      const cycle = cycleOf(group.billedCycleId);
      const state = stateOf(cycle);
      const credited = creditedOf.get(group.billedCycleId) ?? {
        amount: new Prisma.Decimal(0),
        hours: 0,
      };

      // Bruto de la factura y lo que de eso ya se acreditó. El neto es lo que el cliente debe (o
      // pagó) DE VERDAD por estas horas; el bruto se sigue exponiendo para que la card pueda
      // mostrar el descuento en vez de un número que aparece achicado sin explicación.
      const grossAmount = new Prisma.Decimal(group._sum.priceAmount ?? 0);
      const grossHours = group._sum.hours ?? 0;
      const amount = grossAmount.minus(credited.amount);
      totals[state] = totals[state].plus(amount);

      // ⚠️ La regla de "qué factura puede ver el cliente" NO se reescribe acá: se importa de
      // `invoice-visibility.util` (#61), que es su única fuente de verdad. Hoy es redundante
      // —sólo se listan ciclos `SENT`/`PAID`, que siempre son visibles—, y esa redundancia es el
      // punto: si mañana un bucket incluye otro estado, la regla ya está aplicada acá y nadie
      // tiene que acordarse de venir a agregarla.
      if (state === 'PENDING' || !cycle || !canSeeInvoices) continue;
      if (!isPortalVisibleInvoice(cycle)) continue;

      invoicesByState[state].push({
        id: cycle.id,
        invoiceNumber: cycle.invoiceNumber,
        kind: cycle.kind,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        cutoffDate: cycle.cutoffDate,
        currency: cycle.currency,
        // La fecha que le importa al cliente en cada card: cuándo la pagó / cuándo se la enviamos.
        date: cycle.paidAt ?? cycle.sentAt,
        // Horas e importe DE ESTA FACTURA que salen de estos movimientos, no el total del
        // documento: es lo que hace que las filas SUMEN la card que las contiene. Difieren del
        // total de la factura sólo cuando ésta además cobra Variables (#23), que no son horas y
        // tienen su propia pantalla; el gran total se ve al abrir la factura.
        // #65 A3: netos de lo acreditado, para que la fila SUME la card que la contiene — si el
        // total se netea y el desglose no, la card no cuadra con su propio detalle.
        hours: grossHours - credited.hours,
        amount: amount.toString(),
        // …y el crédito aparte, para que la UI pueda decir POR QUÉ el número es más chico que la
        // factura que el cliente tiene en la mano. Sin esto el importe simplemente aparece
        // achicado y el cliente no puede conciliar contra su PDF.
        creditedAmount: credited.amount.toString(),
        creditedHours: credited.hours,
        // #63 — Sale del CICLO, no del cliente. Un cliente que cambió de modo tiene facturas viejas
        // con otro (o sin ninguno), y leer el del cliente les pondría una etiqueta que nunca tuvieron.
        taxMode: cycle.taxMode,
      });
    }

    // Más reciente primero, igual que /portal/invoices.
    for (const list of Object.values(invoicesByState)) {
      list.sort((a, b) => b.periodStart.getTime() - a.periodStart.getTime());
    }

    // #55 — se APLANA la relación a dos campos y se descarta el objeto crudo: el portal no expone
    // entidades del dominio de facturación interna, sólo el número de la NC (que el cliente ya ve en
    // /portal/invoices) y el concepto congelado. En un cliente sin ninguna NC ambos son null y el
    // payload queda idéntico al de antes salvo por esos dos campos.
    //
    // El `note` de una FILA ESPEJO (`rebilledFromTransactionId != null`) se manda en null: el
    // backend la crea con "Re-facturable por NC-…", que es vocabulario del staff. El portal ya
    // no lo pinta (`safeConceptOf` descarta el `note` de esas filas), pero seguía viajando en el
    // JSON y se leía con DevTools > Network — que es justo lo que #55 vino a esconder. Es la
    // MISMA regla, aplicada en el único lugar donde no se puede esquivar. No se toca el `note` de
    // ninguna otra fila: ahí es el concepto que el cliente ve cuando el movimiento no tiene tarea.
    //
    // #62 — `billingState` es el estado REAL de la fila y reemplaza a `if (billedCycleId)` como
    // criterio del badge: con el estampado al emitir, tener ciclo NO significa estar facturado.
    const transactions = recentTransactions.map(({ creditedByLine, ...t }) => ({
      ...t,
      note: t.rebilledFromTransactionId ? null : t.note,
      creditNoteNumber: creditedByLine?.creditNote.number ?? null,
      creditedDescription: creditedByLine?.description ?? null,
      billingState: stateOf(cycleOf(t.billedCycleId)),
    }));

    return {
      contractedHours: client.contractedHours,
      usedHours: client.usedHours,
      loanedHours: client.loanedHours,
      availableHours: available,
      percentUsed: client.contractedHours > 0
        ? parseFloat(((client.usedHours / client.contractedHours) * 100).toFixed(1))
        : 0,
      currency: client.currency,
      developmentHourlyRate: client.developmentHourlyRate,
      supportHourlyRate: client.supportHourlyRate,
      // ⚠️ SE CONSERVA, con el mismo nombre, el mismo tipo (number) y el mismo SIGNIFICADO que
      // siempre tuvo: "lo que falta facturar". Lo único que cambia es que ahora está BIEN
      // calculado — un borrador ya no lo baja y no se recorta a los últimos 100 movimientos.
      // Ningún consumidor existente se rompe: los tres buckets se SUMAN al payload, no lo
      // reemplazan.
      totalAmount: totals.PENDING.toNumber(),
      billing: {
        // #63 — DOS ORÍGENES DISTINTOS DEL MODO, a propósito, y es el punto de toda la sección:
        //
        //   Pendiente  → `client.taxMode`  (no hay documento todavía: el IVA que va a llevar es el que
        //                                   el cliente tiene configurado HOY)
        //   cada factura → `cycle.taxMode` (el que quedó ESTAMPADO al emitirla)
        //
        // Si Pendiente saliera del ciclo no habría de dónde sacarlo, y si las facturas salieran del
        // cliente, un cambio de configuración les reescribiría la etiqueta a todas las viejas.
        //
        // ⚠️ NINGÚN NÚMERO DE ESTE PAYLOAD CAMBIA con #63. Pendiente sigue siendo NETO (sale de
        // `priceAmount`, que nunca lleva IVA) y las otras dos siguen saliendo de `totalAmount`. Lo que
        // se agrega es una ETIQUETA que avisa que a Pendiente todavía le falta el IVA: mostrar un IVA
        // estimado obligaría a recalcular en tres lugares un número que cambia solo si se toca la tasa
        // antes de facturar. La etiqueta no miente, no estima y no toca nada.
        pending: { amount: totals.PENDING.toString(), taxMode: client.taxMode },
        invoiced: { amount: totals.INVOICED.toString(), invoices: invoicesByState.INVOICED },
        paid: { amount: totals.PAID.toString(), invoices: invoicesByState.PAID },
      },
      transactions,
    };
  }

  // ── H8f: Facturas de horas emitidas al cliente (portal) ─────────────────

  // GATE-1 (dueño, 2026-07-27): el cliente ve SENT + PAID + CANCELLED marcadas "Anulada";
  // NUNCA DRAFT (borradores internos del staff). Ordenadas por período desc.
  // #61: y ese CANCELLED es CONDICIONAL — sólo si `sentAt != null`. Un borrador descartado no
  // llegó nunca al cliente, así que no aparece. Ver `invoice-visibility.util`.
  // H9b: además de las FAC, trae las NC del cliente (de facturas que el cliente ve) y devuelve un
  // shape MERGE { invoices, creditNotes }. Las NC llevan monto NEGATIVO (efecto neto) + docType.
  async getMyInvoices(userId: string) {
    const client = await this.getClientByUserId(userId);

    const [invoices, creditNotes] = await Promise.all([
      this.prisma.clientBillingCycle.findMany({
        where: {
          clientId: client.id,
          // #61 — La regla NO se escribe inline: sale de `invoice-visibility.util`, que es su única
          // fuente de verdad (la comparte con el detalle de las cards de #62).
          //
          // Antes era `status: { in: [SENT, PAID, CANCELLED] }` a secas, y ese CANCELLED
          // incondicional era el bug: existe UNA sola anulación (`reopenCycle`) que sirve para
          // borradores y para facturas enviadas, y deja `CANCELLED` en los dos casos. Resultado:
          // descartar un BORRADOR —que el cliente nunca recibió, nunca vio, y que ni siquiera le
          // movió un número— le hacía aparecer en el portal una factura "Anulada" que jamás
          // existió para él. Una enviada-y-anulada sí tiene que verla: esa la recibió.
          ...PORTAL_VISIBLE_INVOICE_WHERE,
        },
        orderBy: { periodStart: 'desc' },
        select: {
          id: true,
          invoiceNumber: true,
          kind: true,
          periodStart: true,
          periodEnd: true,
          cutoffDate: true,
          totalHours: true,
          totalAmount: true,
          currency: true,
          status: true,
          cancelReason: true,
          cancelledAt: true,
          // #63: el modo ESTAMPADO en cada factura → su etiqueta en el listado. Sale del ciclo,
          //   nunca del cliente: acá conviven facturas de distintas épocas y distintos modos.
          taxMode: true,
        },
      }),
      this.prisma.creditNote.findMany({
        // #65 A1.4: WRITTEN_OFF va en la lista. Sin él, cerrar una factura sin cobro le borra
        // del portal las notas de crédito que el cliente ya tenía — y son justamente el motivo
        // por el que esa factura se cerró.
        where: { clientId: client.id, appliesTo: { status: { in: ['SENT', 'PAID', 'WRITTEN_OFF'] } } },
        orderBy: { issuedAt: 'desc' },
        select: {
          id: true,
          number: true,
          totalAmount: true,
          totalHours: true,
          currency: true,
          issuedAt: true,
          appliesTo: { select: { invoiceNumber: true } },
          taxMode: true, // #63: heredado de la factura acreditada
        },
      }),
    ]);

    return {
      invoices: invoices.map((i) => ({ docType: 'INVOICE' as const, ...i })),
      creditNotes: creditNotes.map((n) => ({
        docType: 'CREDIT_NOTE' as const,
        id: n.id,
        number: n.number,
        appliesToInvoiceNumber: n.appliesTo.invoiceNumber,
        totalAmount: n.totalAmount, // ya negativo
        totalHours: n.totalHours,
        currency: n.currency,
        issuedAt: n.issuedAt,
        taxMode: n.taxMode, // #63
      })),
    };
  }

  // ── #23: Variables de facturación (portal) — SOLO comerciales, scopeado por cliente ─────
  //
  // El portal NUNCA llama a Botmaker ni ve el crudo/balance madre: lee solo `client_billing_statements`
  // del cliente del user (scope por user.clientId) y devuelve un DTO ALLOWLIST { label, commercialValue }.
  // Gated por portalBillingEnabled (defensa en profundidad además del gate de la página).
  async getMyVariables(userId: string) {
    const client = await this.getClientByUserId(userId);
    if (!client.portalBillingEnabled) return { statements: [] };

    const statements = await this.prisma.clientBillingStatement.findMany({
      where: { clientId: client.id },
      orderBy: { period: 'desc' },
      select: { period: true, items: true, note: true, updatedAt: true },
    });

    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    return {
      statements: statements
        .map((s) => {
          const raw = Array.isArray(s.items)
            ? (s.items as unknown as Array<{ label?: string; commercialValue?: number; enabled?: boolean }>)
            : [];
          // ALLOWLIST: SOLO label + commercialValue. Nunca rawValue, source, ni datos de la cuenta Botmaker.
          // #23 ojito: las variables deshabilitadas (enabled=false) NO se muestran al cliente.
          const items = raw
            .filter((i) => i.enabled !== false && Number(i.commercialValue) > 0)
            .map((i) => ({ label: String(i.label ?? ''), commercialValue: Number(i.commercialValue) }));
          return {
            period: s.period,
            note: s.note,
            currency: 'USD' as const, // las variables se guardan en USD
            items,
            total: round2(items.reduce((sum, l) => sum + l.commercialValue, 0)),
            updatedAt: s.updatedAt,
          };
        })
        .filter((s) => s.items.length > 0),
    };
  }

  // #23: detalle de UNA factura del cliente para el portal (Consumo + Fee + Tiempo facturado, TODO en Gs
  // como se facturó). El consumo/fee salen del estampado `variables_billing` (líneas ya convertidas a Gs);
  // el tiempo son las horas de soporte del ciclo. Scopeado por user.clientId + solo SENT/PAID (nunca DRAFT).
  async getMyInvoiceDetail(userId: string, cycleId: string) {
    const client = await this.getClientByUserId(userId);
    const cycle = await this.prisma.clientBillingCycle.findFirst({
      // #63: la factura ahora tiene PÁGINA PROPIA (`/portal/billing/<id>`), así que el detalle
      //   pasa a la MISMA regla de visibilidad que el listado (`invoice-visibility.util`, #61) en
      //   vez de `SENT`/`PAID` a secas. Antes, una anulada se listaba pero su detalle daba 404 y
      //   el acordeón mostraba "No se pudo cargar el detalle": ahora abre y muestra su banda
      //   ANULADA con el motivo, que es lo que el cliente necesita ver. Un DRAFT sigue sin existir.
      where: { id: cycleId, clientId: client.id, ...PORTAL_VISIBLE_INVOICE_WHERE },
      select: {
        id: true,
        invoiceNumber: true,
        kind: true,
        periodStart: true,
        periodEnd: true,
        cutoffDate: true,
        status: true,
        totalHours: true,
        totalAmount: true,
        currency: true,
        sentAt: true,
        paidAt: true,
        cancelReason: true,
        cancelledAt: true,
        variablesBilling: true,
        // #63: el IVA ESTAMPADO en ESTA factura. Acá sí van los montos (a diferencia de
        //   `getMyHours`, que sólo necesita el modo para etiquetar): esta pantalla ES la factura y
        //   tiene que desglosar lo que el cliente pagó. Nada se recalcula — todo sale del ciclo.
        taxRate: true,
        taxMode: true,
        netAmount: true,
        taxAmount: true,
      },
    });
    if (!cycle) {
      throw new AppException('Factura no encontrada', 'INVOICE_NOT_FOUND', 404);
    }

    // Variables estampadas: líneas { label, convertedPyg } (Gs). Se separa el Fee del resto del Consumo.
    const raw = cycle.variablesBilling as { lines?: Array<{ label?: string; convertedPyg?: string }> } | null;
    const stampLines = Array.isArray(raw?.lines) ? raw!.lines! : [];
    const isFee = (label: string) => label.trim().toUpperCase() === 'FEE';
    const toLine = (l: { label?: string; convertedPyg?: string }) => ({
      label: String(l.label ?? ''),
      amount: String(l.convertedPyg ?? '0'), // Gs
    });
    const consumo = stampLines.filter((l) => !isFee(String(l.label ?? ''))).map(toLine);
    const fee = stampLines.filter((l) => isFee(String(l.label ?? ''))).map(toLine);
    const sumGs = (arr: { amount: string }[]) =>
      arr.reduce((s, x) => s.plus(x.amount || '0'), new Prisma.Decimal(0)).toString();

    // Tiempo facturado: horas de soporte estampadas en este ciclo (Gs).
    const txs = await this.prisma.hoursTransaction.findMany({
      where: { billedCycleId: cycleId },
      select: { hours: true, note: true, priceAmount: true, workedOn: true, task: { select: { title: true } } },
      orderBy: { workedOn: 'asc' },
    });
    const tiempo = txs.map((t) => ({
      concepto: t.task?.title ?? t.note ?? '—',
      hours: t.hours,
      amount: t.priceAmount != null ? t.priceAmount.toString() : '0', // Gs
    }));
    const subtotalTiempo = txs
      .reduce((s, t) => s.plus(t.priceAmount ?? 0), new Prisma.Decimal(0))
      .toString();
    const totalHoras = txs.reduce((s, t) => s + t.hours, 0);

    // #63: las NC emitidas sobre ESTA factura. Antes vivían en el listado (`getMyInvoices`) y la
    //   página de la factura no las tenía; con página propia, el documento tiene que mostrar
    //   completo lo que se le cobró Y lo que se le devolvió, sin volver a la lista.
    const creditNotes = await this.prisma.creditNote.findMany({
      where: { appliesToCycleId: cycle.id, clientId: client.id },
      orderBy: { issuedAt: 'desc' },
      // `select` mínimo (#55): el `reason` es texto del staff y NO se le manda al cliente.
      select: { id: true, number: true, totalAmount: true, totalHours: true, issuedAt: true, taxMode: true },
    });

    return {
      id: cycle.id,
      invoiceNumber: cycle.invoiceNumber,
      kind: cycle.kind,
      periodStart: cycle.periodStart,
      periodEnd: cycle.periodEnd,
      cutoffDate: cycle.cutoffDate,
      status: cycle.status,
      sentAt: cycle.sentAt,
      paidAt: cycle.paidAt,
      // Una anulada se abre y muestra su motivo (antes daba 404). `cancelReason` lo escribe el
      // staff sabiendo que es el motivo del documento; es lo mismo que ya muestra el listado.
      cancelReason: cycle.cancelReason,
      cancelledAt: cycle.cancelledAt,
      currency: cycle.currency, // Gs (PYG)
      consumo,
      fee,
      subtotalConsumo: sumGs(consumo),
      subtotalFee: sumGs(fee),
      tiempo,
      subtotalTiempo,
      totalHoras,
      total: cycle.totalAmount.toString(), // gran total facturado (Soporte + Variables + IVA), Gs
      // #65 A1.2 — el SALDO, con la misma definición que el lado staff: `total + Σ NC` (las NC ya
      //   son negativas, así que se SUMA). Sale gratis: las notas de crédito de esta factura ya
      //   están traídas unas líneas más arriba, no hace falta ninguna query nueva.
      //
      //   Sin esto la página se contradice con su PROPIO PDF: el botón "Descargar PDF" está a
      //   ochenta líneas del total, y ese PDF ya imprime "SALDO 0" — el cliente vería un documento
      //   diciendo una cosa y la pantalla que se lo dio, otra. El documento contradictorio es el
      //   que después le reenvía a su contador.
      creditedTotal: creditNotes
        .reduce((acc, n) => acc.plus(n.totalAmount), new Prisma.Decimal(0))
        .toString(),
      balance: creditNotes
        .reduce((acc, n) => acc.plus(n.totalAmount), new Prisma.Decimal(cycle.totalAmount))
        .toString(),
      creditNoteCount: creditNotes.length,
      // #63: desglose estampado. Los cuatro en null = factura emitida sin IVA → la página no
      //   dibuja ninguna línea de impuesto y queda como antes de #63.
      taxRate: cycle.taxRate?.toString() ?? null,
      taxMode: cycle.taxMode,
      netAmount: cycle.netAmount?.toString() ?? null,
      taxAmount: cycle.taxAmount?.toString() ?? null,
      creditNotes: creditNotes.map((n) => ({
        id: n.id,
        number: n.number,
        totalAmount: n.totalAmount.toString(), // ya NEGATIVO
        totalHours: n.totalHours,
        issuedAt: n.issuedAt,
        taxMode: n.taxMode, // heredado de esta misma factura
      })),
    };
  }

  // Descarga del PDF de UNA factura del cliente. Reusa el generador de H8e
  // (ClientBillingPdfService), pero valida ANTES que el ciclo sea del cliente del usuario y
  // esté emitido (SENT/PAID) — nunca DRAFT (interno) ni CANCELLED (sin acción). El org del
  // ciclo (denormalizado = autoridad) alimenta al generador scopeado por org/cliente/ciclo.
  async downloadMyInvoice(userId: string, cycleId: string, res: Response): Promise<void> {
    const client = await this.getClientByUserId(userId);

    const cycle = await this.prisma.clientBillingCycle.findFirst({
      where: {
        id: cycleId,
        clientId: client.id,
        status: { in: ['SENT', 'PAID', 'WRITTEN_OFF'] }, // #65 A1.4: ya la recibió, se la puede bajar
      },
      select: { id: true, organizationId: true },
    });
    if (!cycle) {
      throw new AppException('Factura no encontrada', 'INVOICE_NOT_FOUND', 404);
    }

    const { buffer, filename } = await this.pdfService.generateInvoicePdf(
      cycle.organizationId,
      client.id,
      cycle.id,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length.toString());
    res.send(buffer);
  }

  // H9b: descarga del PDF de UNA nota de crédito del cliente. Valida ANTES que la NC sea del cliente
  // del usuario y que la FAC acreditada esté emitida (SENT/PAID) — coherente con downloadMyInvoice.
  async downloadMyCreditNote(userId: string, creditNoteId: string, res: Response): Promise<void> {
    const client = await this.getClientByUserId(userId);
    const nc = await this.prisma.creditNote.findFirst({
      where: { id: creditNoteId, clientId: client.id, appliesTo: { status: { in: ['SENT', 'PAID', 'WRITTEN_OFF'] } } }, // #65 A1.4
      select: { id: true, organizationId: true },
    });
    if (!nc) throw new AppException('Nota de crédito no encontrada', 'CREDIT_NOTE_NOT_FOUND', 404);
    const { buffer, filename } = await this.pdfService.generateCreditNotePdf(nc.organizationId, client.id, nc.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length.toString());
    res.send(buffer);
  }

  async convertToTask(projectId: string, suggestionId: string) {
    const suggestion = await this.prisma.suggestion.findFirst({
      where: { id: suggestionId, projectId },
    });
    if (!suggestion) {
      throw new AppException('Sugerencia no encontrada', 'SUGGESTION_NOT_FOUND', 404);
    }

    if (suggestion.taskId) {
      throw new AppException('Esta sugerencia ya fue convertida en tarea', 'ALREADY_CONVERTED', 400);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Get a creator user (first org member that isn't a client)
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { organizationId: true, createdById: true },
      });

      // Find the BACKLOG column so la task cae en "Nuevo" consistente con tickets
      const backlogColumn = await tx.boardColumn.findFirst({
        where: {
          mappedStatus: 'BACKLOG',
          board: { projectId },
        },
        orderBy: { position: 'asc' },
      });

      const task = await tx.task.create({
        data: {
          projectId,
          title: suggestion.title,
          description: suggestion.description,
          priority: suggestion.priority === 'HIGH' ? 'HIGH' : suggestion.priority === 'LOW' ? 'LOW' : 'MEDIUM',
          status: 'BACKLOG',
          createdById: project!.createdById,
          clientVisible: true,
          ...(backlogColumn && { boardColumnId: backlogColumn.id }),
        },
      });

      const updated = await tx.suggestion.update({
        where: { id: suggestionId },
        data: { status: 'IMPLEMENTED', taskId: task.id },
        include: {
          client: { select: { id: true, name: true } },
          task: { select: { id: true, title: true, status: true } },
        },
      });

      return updated;
    });

    this.logger.log(`Suggestion ${suggestionId} converted to task ${result.taskId}`);
    return result;
  }

  // ── Ticket Categories (Portal) ─────────────────────────

  async getActiveTicketCategories(userId: string) {
    const client = await this.getClientByUserId(userId);

    return this.prisma.ticketCategoryConfig.findMany({
      where: { organizationId: client.organizationId, isActive: true },
      select: { id: true, name: true, description: true },
      orderBy: { name: 'asc' },
    });
  }

  async getBusinessHours(userId: string) {
    const client = await this.getClientByUserId(userId);

    const config = await this.prisma.businessHoursConfig.findUnique({
      where: { organizationId: client.organizationId },
    });

    if (!config) return null;

    const dayNames: Record<string, string> = {
      '1': 'Lunes', '2': 'Martes', '3': 'Miércoles',
      '4': 'Jueves', '5': 'Viernes', '6': 'Sábado', '0': 'Domingo',
    };
    const days = config.businessDays.split(',').map((d) => dayNames[d.trim()] || d.trim());

    return {
      start: config.businessHoursStart,
      end: config.businessHoursEnd,
      days,
      timezone: config.timezone,
    };
  }

  // ============================================================================
  // PROJECT DOCUMENTS — vista del cliente
  // ============================================================================

  async getProjectDocuments(userId: string, projectId: string) {
    const client = await this.getClientByUserId(userId);

    // Verificar que el proyecto pertenezca al cliente
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
      select: { id: true, name: true },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    // Documentos del proyecto: visibles, head version (sin descendientes mas nuevos),
    // incluyendo eliminados (se muestran como "Eliminado")
    const all = await this.prisma.file.findMany({
      where: {
        projectId,
        clientVisible: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        originalName: true,
        mimeType: true,
        size: true,
        parentFileId: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
        uploadedBy: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Filtrar para devolver solo el "head" de cada cadena de versiones
    // (el archivo que NO tiene otro archivo apuntandolo como parent)
    const parentIds = new Set(all.filter((f) => f.parentFileId).map((f) => f.parentFileId));
    const heads = all.filter((f) => !parentIds.has(f.id));

    return heads.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      mimeType: f.mimeType,
      size: f.size,
      uploadedAt: f.createdAt,
      updatedAt: f.updatedAt,
      uploadedByName: f.uploadedBy?.name ?? null,
      deleted: f.deletedAt !== null,
    }));
  }

  async downloadDocument(userId: string, fileId: string, req: Request, res: Response) {
    const client = await this.getClientByUserId(userId);

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        key: true,
        clientVisible: true,
        deletedAt: true,
        projectId: true,
        project: { select: { clientId: true } },
      },
    });

    if (!file || !file.projectId) {
      throw new AppException('Documento no encontrado', 'DOCUMENT_NOT_FOUND', 404);
    }
    if (file.project?.clientId !== client.id) {
      throw new AppException('Sin acceso a este documento', 'FORBIDDEN', 403);
    }
    if (!file.clientVisible) {
      throw new AppException('Documento no disponible', 'NOT_VISIBLE', 403);
    }
    if (file.deletedAt) {
      throw new AppException('Este documento fue eliminado', 'DOCUMENT_DELETED', 410);
    }

    const ipAddress = (req.ip || (req.headers['x-forwarded-for'] as string) || '').toString();
    const userAgent = (req.headers['user-agent'] as string) || undefined;

    await this.fileService.recordDownload(fileId, userId, ipAddress, userAgent);
    const url = await this.storage.getSignedUrl(file.key, 3600, file.id);
    return res.redirect(url);
  }

  // ============================================================================
  // CLIENT DOCUMENTS — vista del cliente desde portal (general, no por proyecto)
  // ============================================================================

  async getClientDocuments(userId: string) {
    const client = await this.getClientByUserId(userId);

    const all = await this.prisma.file.findMany({
      where: {
        clientId: client.id,
        clientVisible: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        originalName: true,
        mimeType: true,
        size: true,
        parentFileId: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
        uploadedBy: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Filtrar heads (sin descendientes), aunque para client docs no usamos
    // versionado incremental — esto es defensivo por si algun dato legacy aparece
    const parentIds = new Set(all.filter((f) => f.parentFileId).map((f) => f.parentFileId));
    const heads = all.filter((f) => !parentIds.has(f.id));

    return heads.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      mimeType: f.mimeType,
      size: f.size,
      uploadedAt: f.createdAt,
      updatedAt: f.updatedAt,
      uploadedByName: f.uploadedBy?.name ?? null,
      deleted: f.deletedAt !== null,
    }));
  }

  async downloadClientDocument(userId: string, fileId: string, req: Request, res: Response) {
    const client = await this.getClientByUserId(userId);

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        key: true,
        clientId: true,
        clientVisible: true,
        deletedAt: true,
      },
    });

    if (!file || !file.clientId) {
      throw new AppException('Documento no encontrado', 'DOCUMENT_NOT_FOUND', 404);
    }
    if (file.clientId !== client.id) {
      throw new AppException('Sin acceso a este documento', 'FORBIDDEN', 403);
    }
    if (!file.clientVisible) {
      throw new AppException('Documento no disponible', 'NOT_VISIBLE', 403);
    }
    if (file.deletedAt) {
      throw new AppException('Este documento fue eliminado', 'DOCUMENT_DELETED', 410);
    }

    const ipAddress = (req.ip || (req.headers['x-forwarded-for'] as string) || '').toString();
    const userAgent = (req.headers['user-agent'] as string) || undefined;

    await this.fileService.recordDownload(fileId, userId, ipAddress, userAgent);
    const url = await this.storage.getSignedUrl(file.key, 3600, file.id);
    return res.redirect(url);
  }
}
