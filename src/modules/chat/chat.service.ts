import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { CreateChannelDto, ChannelTypeDto } from './dto/create-channel.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateMessageDto } from './dto/update-message.dto';
import { AppException } from '../../common/filters/app-exception';
import { OutboxService } from '../sync/outbox.service';

// ============================================
// ChannelService — Gestion de canales de chat
// ============================================

@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * List channels where the user is a member (org-level)
   */
  async findByOrganization(orgId: string, userId: string) {
    return this.prisma.channel.findMany({
      where: {
        organizationId: orgId,
        members: { some: { userId } },
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
          take: 5,
        },
        _count: { select: { members: true, messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Legacy: list channels by project
   */
  async findByProject(projectId: string) {
    return this.prisma.channel.findMany({
      where: { projectId },
      include: {
        _count: { select: { members: true, messages: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Create a DM between two users (returns existing if already exists)
   */
  async createDM(orgId: string, userId: string, targetUserId: string) {
    if (userId === targetUserId) {
      throw new AppException('No puedes crear un DM contigo mismo', 'INVALID_DM', 400);
    }

    // Check for existing DM between these two users
    const existing = await this.prisma.channel.findFirst({
      where: {
        organizationId: orgId,
        type: 'DM',
        AND: [
          { members: { some: { userId } } },
          { members: { some: { userId: targetUserId } } },
        ],
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
        },
      },
    });

    if (existing) return existing;

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { name: true },
    });

    const channel = await this.prisma.channel.create({
      data: {
        name: `DM`,
        type: 'DM',
        organizationId: orgId,
        createdById: userId,
        members: {
          create: [{ userId }, { userId: targetUserId }],
        },
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
        },
      },
    });

    this.logger.log(`DM creado: ${channel.id} entre ${userId} y ${targetUserId}`);
    return channel;
  }

  /**
   * Create a group channel with selected members
   */
  async createGroup(orgId: string, userId: string, dto: CreateChannelDto) {
    const memberIds = [...new Set([userId, ...(dto.memberIds || [])])];

    const channel = await this.prisma.channel.create({
      data: {
        name: dto.name,
        description: dto.description,
        type: 'GROUP',
        organizationId: orgId,
        createdById: userId,
        members: {
          create: memberIds.map((id) => ({ userId: id })),
        },
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
        },
        _count: { select: { members: true } },
      },
    });

    this.logger.log(`Grupo creado: ${channel.id} en org ${orgId}`);
    return channel;
  }

  /**
   * Create a project channel (auto-add project members)
   */
  async createProjectChannel(orgId: string, projectId: string, userId: string, dto: CreateChannelDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        organizationId: true,
        members: { select: { userId: true } },
      },
    });

    if (!project) {
      throw new AppException('El proyecto no existe', 'PROJECT_NOT_FOUND', 404);
    }

    if (project.organizationId !== orgId) {
      throw new AppException('El proyecto no pertenece a esta organizacion', 'INVALID_PROJECT', 400);
    }

    // Add all project members + creator
    const memberIds = [...new Set([userId, ...project.members.map((m) => m.userId)])];

    const channel = await this.prisma.channel.create({
      data: {
        name: dto.name || `#${project.name}`,
        description: dto.description,
        type: 'PROJECT',
        organizationId: orgId,
        projectId,
        createdById: userId,
        members: {
          create: memberIds.map((id) => ({ userId: id })),
        },
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
        },
        _count: { select: { members: true } },
      },
    });

    this.logger.log(`Canal de proyecto creado: ${channel.id} para proyecto ${projectId}`);
    return channel;
  }

  /**
   * Unified create method dispatched by type
   */
  async create(orgId: string, userId: string, dto: CreateChannelDto) {
    switch (dto.type) {
      case ChannelTypeDto.DM: {
        if (!dto.memberIds?.length) {
          throw new AppException('Se requiere un miembro para DM', 'MISSING_MEMBER', 400);
        }
        return this.createDM(orgId, userId, dto.memberIds[0]);
      }
      case ChannelTypeDto.GROUP:
        return this.createGroup(orgId, userId, dto);
      case ChannelTypeDto.PROJECT: {
        if (!dto.projectId) {
          throw new AppException('Se requiere un proyecto para canal de proyecto', 'MISSING_PROJECT', 400);
        }
        return this.createProjectChannel(orgId, dto.projectId, userId, dto);
      }
      default:
        throw new AppException('Tipo de canal no valido', 'INVALID_CHANNEL_TYPE', 400);
    }
  }

  /**
   * Get channel members.
   * Membership gate (feature #18, R2): solo un miembro del canal puede listar a
   * los miembros. Sin esto, cualquier user podia enumerar miembros de un canal ajeno.
   */
  async getMembers(channelId: string, requesterId: string) {
    const membership = await this.prisma.channelMember.findFirst({
      where: { channelId, userId: requesterId },
      select: { id: true },
    });
    if (!membership) {
      throw new AppException(
        'No tenés acceso a este canal',
        'CHANNEL_FORBIDDEN',
        403,
        { channelId },
      );
    }

    return this.prisma.channelMember.findMany({
      where: { channelId },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }

  /**
   * Add a member to a channel
   */
  async addMember(channelId: string, userId: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      throw new AppException('El canal no existe', 'CHANNEL_NOT_FOUND', 404);
    }

    if (channel.type === 'DM') {
      throw new AppException('No se pueden agregar miembros a un DM', 'DM_NO_ADD', 400);
    }

    const existing = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });

    if (existing) return existing;

    const member = await this.prisma.channelMember.create({
      data: { channelId, userId },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    this.logger.log(`Miembro ${userId} agregado al canal ${channelId}`);
    return member;
  }

  /**
   * Remove a member from a channel
   */
  async removeMember(channelId: string, userId: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      throw new AppException('El canal no existe', 'CHANNEL_NOT_FOUND', 404);
    }

    if (channel.type === 'DM') {
      throw new AppException('No se pueden quitar miembros de un DM', 'DM_NO_REMOVE', 400);
    }

    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });

    if (!member) {
      throw new AppException('El usuario no es miembro del canal', 'MEMBER_NOT_FOUND', 404);
    }

    await this.prisma.channelMember.delete({
      where: { channelId_userId: { channelId, userId } },
    });

    this.logger.log(`Miembro ${userId} removido del canal ${channelId}`);
  }
}

// ============================================
// MessageService — Gestion de mensajes
// ============================================

/**
 * Cliente Prisma suelto o cliente de transaccion: las escrituras del mensaje
 * corren en los dos modos (mismo molde que `PrismaLike` en
 * ticket-classification-guard.service.ts / task-hours-guard.service.ts).
 * `PrismaService` extiende `PrismaClient`, asi que la union cubre ambos.
 */
type PrismaLike = Prisma.TransactionClient | PrismaService;

@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  /** Shared include for user + files in message queries */
  private readonly messageInclude = {
    user: { select: { id: true, name: true, email: true, image: true, clientId: true } },
    files: {
      select: { id: true, name: true, originalName: true, mimeType: true, size: true, key: true, url: true },
    },
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly storage: StorageService,
    // OutboxService (#50 D5): encola el mensaje como comentario para OSD dentro
    // de la MISMA tx que lo crea. 4º parametro nuevo — los specs que instancian
    // MessageService a mano deben pasar el mock.
    private readonly outbox: OutboxService,
  ) {}

  /** Enrich message with senderType + resolved file URLs */
  private async enrichMessage(message: any) {
    const { clientId, ...userRest } = message.user;
    const files = message.files?.length
      ? await Promise.all(
          message.files.map(async (f: any) => ({
            ...f,
            url: await this.storage.getSignedUrl(f.key, 3600, f.id),
          })),
        )
      : [];
    return {
      ...message,
      user: userRest,
      files,
      senderType: clientId ? ('client' as const) : ('team' as const),
    };
  }

  async findByChannel(
    channelId: string,
    requesterId: string,
    cursor?: string,
    limit: number = 50,
  ) {
    // Membership gate (feature #18, R2): solo un miembro del canal puede leer sus
    // mensajes via REST. Sin esto, GET /channels/:id/messages filtraba historial
    // de cualquier canal a cualquier user autenticado (CRITICO-2: disclosure por HTTP).
    const membership = await this.prisma.channelMember.findFirst({
      where: { channelId, userId: requesterId },
      select: { id: true },
    });
    if (!membership) {
      throw new AppException(
        'No tenés acceso a este canal',
        'CHANNEL_FORBIDDEN',
        403,
        { channelId },
      );
    }

    const where: any = {
      channelId,
    };

    if (cursor) {
      where.id = { lt: cursor };
    }

    const messages = await this.prisma.message.findMany({
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: this.messageInclude,
    });

    const nextCursor =
      messages.length === limit
        ? messages[messages.length - 1].id
        : null;

    return {
      data: await Promise.all(messages.map((m) => this.enrichMessage(m))),
      nextCursor,
    };
  }

  async create(
    channelId: string,
    userId: string,
    dto: SendMessageDto,
  ) {
    // Membership gate (feature #18, R3): validar que el sender sea miembro del
    // canal ANTES de crear el mensaje. Cubre WS (message:send) y POST REST por un
    // solo punto. Sin esto, cualquier user podia escribir en un canal ajeno (ALTO-1).
    // El userId siempre proviene del request autenticado (socket/sesion), no del body.
    const membership = await this.prisma.channelMember.findFirst({
      where: { channelId, userId },
      select: { id: true },
    });
    if (!membership) {
      throw new AppException(
        'No tenés acceso a este canal',
        'CHANNEL_FORBIDDEN',
        403,
        { channelId },
      );
    }

    // Gate read-only (feature #11 + #43): si el canal pertenece a un ticket en
    // estado terminal para el cliente — RESOLVED (resuelto) o CLOSED (cancelado,
    // #43 D3b) — y el sender es cliente (User.clientId !== null), rechazar. El
    // staff (clientId === null) y los tickets en cualquier otro estado pasan sin
    // cambios. Cubre HTTP (POST /chat/channels/:id/messages) y WS (message:send),
    // porque ambos entran por este método. Una sola query liviana por path.
    // Se conserva el código TICKET_RESOLVED_READ_ONLY para ambos estados: el
    // frontend lo trata como "chat de solo lectura" sin distinguir la causa.
    const [sender, channel] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { clientId: true },
      }),
      this.prisma.channel.findUnique({
        where: { id: channelId },
        // El select del ticket se extiende con id/category/organizationId (#50
        // D5): son exactamente los datos que necesita el gate de encolado del
        // outbox mas abajo. Se aprovecha la query que ya existia para el gate
        // read-only en vez de sumar un round-trip nuevo por mensaje.
        select: {
          ticket: {
            select: { id: true, status: true, category: true, organizationId: true },
          },
        },
      }),
    ]);

    const ticketStatus = channel?.ticket?.status;
    if (sender?.clientId && (ticketStatus === 'RESOLVED' || ticketStatus === 'CLOSED')) {
      throw new AppException(
        ticketStatus === 'RESOLVED'
          ? 'El ticket está resuelto. Creá una nueva consulta para continuar.'
          : 'El ticket fue cancelado. Creá una nueva consulta para continuar.',
        'TICKET_RESOLVED_READ_ONLY',
        403,
        { channelId },
      );
    }

    // Gate de encolado al outbox de OSD (#50 R2.1): el mensaje viaja como
    // comentario PUBLICO del ticket. Misma condicion que el resto de los encolados
    // del proyecto (ticket.service / portal.service): solo los tickets de soporte
    // estan en el scope de la integracion. Un canal sin ticket (DM, grupo, canal
    // de proyecto) no encola nada. El flag maestro (ONNIX_SYNC_ENABLED) y la
    // whitelist de orgs los aplica `enqueueTx` adentro — NO se repiten aca.
    // Este metodo es el UNICO punto de entrada de WS (`message:send`) y REST
    // (`POST /chat/channels/:id/messages`), asi que el gate no se duplica en el
    // gateway.
    const ticket = channel?.ticket;
    const syncTicket =
      ticket && ticket.category === 'SUPPORT_REQUEST' ? ticket : null;

    // La transaccion se abre SOLO cuando hay algo que encolar, y es a proposito.
    // Envolver SIEMPRE las 4 escrituras (como quedo en el primer pase de #50)
    // metia un modo de falla NUEVO en el path caliente del chat para la enorme
    // mayoria de los mensajes del producto — canales sin ticket, tickets fuera de
    // SUPPORT_REQUEST, orgs fuera de la whitelist, flag apagado: como
    // PrismaService no configura `transactionOptions`, regian los defaults de
    // Prisma (maxWait 2s / timeout 5s), asi que bajo pico de chat o pool chico en
    // Railway aparecia un P2024/P2028 donde antes no habia ninguno, el usuario
    // comia un 500 y PERDIA el mensaje entero por rollback. Antes de #50 esas 4
    // queries iban sueltas, sin limite agregado ni retencion de conexion: el
    // mensaje se guardaba igual, solo que mas lento. Sin fila de outbox que
    // atomizar no hay nada que ganar con la tx, asi que este camino vuelve a ser
    // byte a byte el de antes de #50 (regla del dueño: probar el camino VIEJO con
    // el flag APAGADO).
    //
    // Cuando SI hay que encolar, la tx es obligatoria: la fila del outbox tiene
    // que nacer JUNTO con el mensaje — si el envio falla a mitad de camino, el
    // rollback se lleva la fila y OSD nunca recibe el comentario de un mensaje que
    // no existe (garantia nativa de Prisma, mismo molde que portal.service y
    // ticket.service). A ese camino se le pasan `maxWait`/`timeout` EXPLICITOS y
    // holgados (5s/15s) en vez de los defaults: un pico de carga no tiene por que
    // costarle el mensaje al cliente, y 15s sigue siendo un techo sano para 5
    // escrituras chicas. Dentro de la tx SOLO hay escrituras de Prisma: S3
    // (`enrichMessage`) y el emit del WS quedan afuera para no estirar la
    // transaccion con I/O externo.
    //
    // Payload `{ ticketId, messageId }` (R2.2): el dispatcher RELEE el Message al
    // drenar; no se snapshotea el contenido (si el mensaje se borro antes del
    // envio, el drain lo skipea).
    const { messageId, final, enqueued } = syncTicket
      ? await this.prisma.$transaction(
          async (tx) => {
            const written = await this.writeMessage(tx, channelId, userId, dto);
            const wroteOutboxRow = await this.outbox.enqueueTx(tx, {
              eventType: 'COMMENT_ADDED',
              aggregateId: syncTicket.id,
              organizationId: syncTicket.organizationId,
              payload: { ticketId: syncTicket.id, messageId: written.messageId },
            });
            return { ...written, enqueued: wroteOutboxRow };
          },
          { maxWait: 5_000, timeout: 15_000 },
        )
      : {
          ...(await this.writeMessage(this.prisma, channelId, userId, dto)),
          enqueued: false,
        };

    // Drain-on-enqueue (#50 R4.3): POST-COMMIT, jamas adentro de la tx — si la tx
    // revierte no hay nada que drenar. Solo si `enqueueTx` escribio fila de
    // verdad (devolvio true); si el flag/whitelist lo dejaron en no-op no hay a
    // quien avisar. Es best-effort: si el listener falla, la fila sigue
    // `pending` y el cron horario la levanta.
    if (enqueued) {
      this.outbox.notifyEnqueued();
    }

    const enriched = await this.enrichMessage(final!);

    this.eventEmitter.emit('message.sent', {
      messageId,
      channelId,
      userId,
      content: dto.content,
      enrichedMessage: enriched,
    });

    this.logger.log(
      `Mensaje enviado: ${messageId} en canal ${channelId}`,
    );

    return enriched;
  }

  /**
   * Las escrituras del mensaje (create + link de archivos + re-fetch + touch del
   * canal), extraidas para que el MISMO cuerpo corra en los dos modos SIN
   * duplicarse: suelto contra `this.prisma` (canal sin ticket sincronizable) o
   * dentro de la `$transaction` que ademas encola la fila del outbox. El
   * comportamiento observable es identico en ambos; lo unico que cambia es si las
   * queries comparten transaccion.
   *
   * @param db cliente Prisma o `tx` de la transaccion del caller.
   */
  private async writeMessage(
    db: PrismaLike,
    channelId: string,
    userId: string,
    dto: SendMessageDto,
  ) {
    const created = await db.message.create({
      data: {
        content: dto.content,
        channelId,
        userId,
      },
      include: this.messageInclude,
    });

    // Link uploaded files to this message
    if (dto.fileIds?.length) {
      await db.file.updateMany({
        where: { id: { in: dto.fileIds }, uploadedById: userId, messageId: null },
        data: { messageId: created.id },
      });
    }

    // Re-fetch to include linked files
    const withFiles = dto.fileIds?.length
      ? await db.message.findUnique({
          where: { id: created.id },
          include: this.messageInclude,
        })
      : created;

    // Update channel's updatedAt
    await db.channel.update({
      where: { id: channelId },
      data: { updatedAt: new Date() },
    });

    return { messageId: created.id, final: withFiles };
  }

  async update(messageId: string, userId: string, dto: UpdateMessageDto) {
    const existing = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!existing || existing.userId !== userId) {
      throw new AppException(
        'El mensaje no existe o no te pertenece',
        'MESSAGE_NOT_FOUND',
        404,
      );
    }

    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        content: dto.content,
        editedAt: new Date(),
      },
      include: this.messageInclude,
    });

    return this.enrichMessage(updated);  // async — returns Promise
  }

  async delete(messageId: string, userId: string) {
    const existing = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!existing || existing.userId !== userId) {
      throw new AppException(
        'El mensaje no existe o no te pertenece',
        'MESSAGE_NOT_FOUND',
        404,
      );
    }

    return this.prisma.message.delete({ where: { id: messageId } });
  }
}
