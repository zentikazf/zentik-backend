import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { CreateChannelDto, ChannelTypeDto } from './dto/create-channel.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateMessageDto } from './dto/update-message.dto';
import { AppException } from '../../common/filters/app-exception';

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
   * Get channel members
   */
  async getMembers(channelId: string) {
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
  ) {}

  /** Enrich message with senderType + resolved file URLs */
  private async enrichMessage(message: any) {
    const { clientId, ...userRest } = message.user;
    const files = message.files?.length
      ? await Promise.all(
          message.files.map(async (f: any) => ({
            ...f,
            url: await this.storage.getSignedUrl(f.key),
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
    cursor?: string,
    limit: number = 50,
  ) {
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
    const message = await this.prisma.message.create({
      data: {
        content: dto.content,
        channelId,
        userId,
      },
      include: this.messageInclude,
    });

    // Link uploaded files to this message
    if (dto.fileIds?.length) {
      await this.prisma.file.updateMany({
        where: { id: { in: dto.fileIds }, uploadedById: userId, messageId: null },
        data: { messageId: message.id },
      });
    }

    // Re-fetch to include linked files
    const final = dto.fileIds?.length
      ? await this.prisma.message.findUnique({
          where: { id: message.id },
          include: this.messageInclude,
        })
      : message;

    // Update channel's updatedAt
    await this.prisma.channel.update({
      where: { id: channelId },
      data: { updatedAt: new Date() },
    });

    const enriched = await this.enrichMessage(final!);

    this.eventEmitter.emit('message.sent', {
      messageId: message.id,
      channelId,
      userId,
      content: dto.content,
      enrichedMessage: enriched,
    });

    this.logger.log(
      `Mensaje enviado: ${message.id} en canal ${channelId}`,
    );

    return enriched;
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
