import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../database/prisma.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { CreateClientUserDto } from './dto/create-client-user.dto';
import { AppException, DuplicateResourceException } from '../../common/filters/app-exception';
import { PaginatedResult } from '../../common/interfaces/request.interface';

@Injectable()
export class ClientService {
  private readonly logger = new Logger(ClientService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(orgId: string, dto: CreateClientDto) {
    const client = await this.prisma.client.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        notes: dto.notes,
      },
    });

    this.logger.log(`Client created: ${client.id} in org: ${orgId}`);
    return client;
  }

  async findAll(
    orgId: string,
    params: { search?: string; page?: number; limit?: number },
  ): Promise<PaginatedResult<any>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.ClientWhereInput = { organizationId: orgId };

    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { email: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.client.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: {
          _count: { select: { projects: true } },
          user: { select: { email: true } },
        },
      }),
      this.prisma.client.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findById(orgId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId },
      include: {
        _count: { select: { projects: true } },
        projects: {
          select: { id: true, name: true, status: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!client) {
      throw new AppException('El cliente no existe', 'CLIENT_NOT_FOUND', 404, { clientId });
    }

    return client;
  }

  async update(orgId: string, clientId: string, dto: UpdateClientDto) {
    const existing = await this.findById(orgId, clientId);

    const client = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.client.update({
        where: { id: clientId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      // Sync User.name if client has a linked user account
      if (dto.name !== undefined && existing.userId) {
        await tx.user.update({
          where: { id: existing.userId },
          data: { name: dto.name },
        });
      }

      return updated;
    });

    this.logger.log(`Client updated: ${clientId}`);
    return client;
  }

  async delete(orgId: string, clientId: string) {
    await this.findById(orgId, clientId);

    await this.prisma.client.delete({ where: { id: clientId } });

    this.logger.log(`Client deleted: ${clientId} from org: ${orgId}`);
  }

  async createClientUser(orgId: string, clientId: string, dto: CreateClientUserDto) {
    const client = await this.findById(orgId, clientId);

    if (client.userId) {
      throw new AppException('Este cliente ya tiene un usuario asignado', 'CLIENT_USER_EXISTS', 400);
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new DuplicateResourceException('usuario', 'email', dto.email);
    }

    // Find or create "Cliente" role for the organization
    let clienteRole = await this.prisma.role.findFirst({
      where: { organizationId: orgId, name: 'Cliente' },
    });

    if (!clienteRole) {
      clienteRole = await this.prisma.role.create({
        data: {
          organizationId: orgId,
          name: 'Cliente',
          description: 'Cliente externo con acceso al portal',
          isSystem: true,
          isDefault: false,
        },
      });

      // Assign default permissions for the client role
      const permissions = await this.prisma.permission.findMany({
        where: {
          OR: [
            { action: 'read', resource: 'projects' },
            { action: 'read', resource: 'tasks' },
          ],
        },
      });

      if (permissions.length > 0) {
        await this.prisma.rolePermission.createMany({
          data: permissions.map((p) => ({
            roleId: clienteRole!.id,
            permissionId: p.id,
          })),
          skipDuplicates: true,
        });
      }

      this.logger.log(`Created "Cliente" role for org: ${orgId}`);
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    const updatedClient = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          emailVerified: true,
        },
      });

      await tx.account.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: 'credential',
          password: hashedPassword,
        },
      });

      await tx.organizationMember.create({
        data: {
          organizationId: orgId,
          userId: user.id,
          roleId: clienteRole.id,
        },
      });

      const updated = await tx.client.update({
        where: { id: clientId },
        data: { userId: user.id },
        include: {
          user: { select: { id: true, email: true, name: true } },
          _count: { select: { projects: true } },
        },
      });

      return updated;
    });

    this.logger.log(`Client user created: ${updatedClient.userId} for client: ${clientId}`);
    return updatedClient;
  }
}
