import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateRoleDto, UpdateRoleDto } from './dto';
import {
  AppException,
  DuplicateResourceException,
  OrganizationNotFoundException,
} from '../../common/filters/app-exception';

@Injectable()
export class RoleService {
  private readonly logger = new Logger(RoleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string) {
    await this.validateOrganization(orgId);

    return this.prisma.role.findMany({
      where: { organizationId: orgId },
      include: {
        _count: {
          select: { organizationMembers: true },
        },
        rolePermissions: {
          include: {
            permission: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(orgId: string, dto: CreateRoleDto) {
    await this.validateOrganization(orgId);

    // Check for duplicate name within org
    const existing = await this.prisma.role.findUnique({
      where: {
        organizationId_name: {
          organizationId: orgId,
          name: dto.name,
        },
      },
    });

    if (existing) {
      throw new DuplicateResourceException('rol', 'name', dto.name);
    }

    const role = await this.prisma.$transaction(async (tx) => {
      const newRole = await tx.role.create({
        data: {
          organizationId: orgId,
          name: dto.name,
          description: dto.description,
        },
      });

      // Assign permissions if provided
      if (dto.permissions && dto.permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: dto.permissions.map((permissionId) => ({
            roleId: newRole.id,
            permissionId,
          })),
          skipDuplicates: true,
        });
      }

      return tx.role.findUnique({
        where: { id: newRole.id },
        include: {
          rolePermissions: {
            include: { permission: true },
          },
        },
      });
    });

    this.logger.log(`Role created: ${role?.id} in org: ${orgId}`);
    return role;
  }

  async update(orgId: string, roleId: string, dto: UpdateRoleDto) {
    const role = await this.findRoleOrThrow(orgId, roleId);

    if (role.isSystem) {
      throw new AppException(
        'No se pueden modificar roles del sistema',
        'SYSTEM_ROLE_IMMUTABLE',
        403,
      );
    }

    if (dto.name && dto.name !== role.name) {
      const existing = await this.prisma.role.findUnique({
        where: {
          organizationId_name: {
            organizationId: orgId,
            name: dto.name,
          },
        },
      });

      if (existing) {
        throw new DuplicateResourceException('rol', 'name', dto.name);
      }
    }

    const updatedRole = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.role.update({
        where: { id: roleId },
        data: {
          ...(dto.name && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
        },
      });

      // Update permissions if provided
      if (dto.permissions !== undefined) {
        await tx.rolePermission.deleteMany({ where: { roleId } });

        if (dto.permissions.length > 0) {
          await tx.rolePermission.createMany({
            data: dto.permissions.map((permissionId) => ({
              roleId,
              permissionId,
            })),
            skipDuplicates: true,
          });
        }
      }

      return tx.role.findUnique({
        where: { id: updated.id },
        include: {
          rolePermissions: {
            include: { permission: true },
          },
        },
      });
    });

    this.logger.log(`Role updated: ${roleId} in org: ${orgId}`);
    return updatedRole;
  }

  async delete(orgId: string, roleId: string) {
    const role = await this.findRoleOrThrow(orgId, roleId);

    if (role.isSystem) {
      throw new AppException(
        'No se pueden eliminar roles del sistema',
        'SYSTEM_ROLE_IMMUTABLE',
        403,
      );
    }

    // Check if any members are using this role
    const membersCount = await this.prisma.organizationMember.count({
      where: { roleId },
    });

    if (membersCount > 0) {
      throw new AppException(
        `No se puede eliminar el rol porque esta asignado a ${membersCount} miembro(s)`,
        'ROLE_IN_USE',
        409,
        { membersCount },
      );
    }

    await this.prisma.role.delete({ where: { id: roleId } });

    this.logger.log(`Role deleted: ${roleId} from org: ${orgId}`);
    return { deleted: true };
  }

  async getRolePermissions(orgId: string, roleId: string) {
    await this.findRoleOrThrow(orgId, roleId);

    return this.prisma.rolePermission.findMany({
      where: { roleId },
      include: { permission: true },
    });
  }

  async updateRolePermissions(orgId: string, roleId: string, permissionIds: string[]) {
    const role = await this.findRoleOrThrow(orgId, roleId);

    if (role.isSystem) {
      throw new AppException(
        'No se pueden modificar permisos de roles del sistema',
        'SYSTEM_ROLE_IMMUTABLE',
        403,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Remove all existing permissions
      await tx.rolePermission.deleteMany({ where: { roleId } });

      // Assign new permissions
      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({
            roleId,
            permissionId,
          })),
          skipDuplicates: true,
        });
      }
    });

    this.logger.log(
      `Permissions updated for role: ${roleId}, count: ${permissionIds.length}`,
    );

    return this.prisma.rolePermission.findMany({
      where: { roleId },
      include: { permission: true },
    });
  }

  private async findRoleOrThrow(orgId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, organizationId: orgId },
    });

    if (!role) {
      throw new AppException(
        'El rol no existe en esta organizacion',
        'ROLE_NOT_FOUND',
        404,
        { roleId, orgId },
      );
    }

    return role;
  }

  private async validateOrganization(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });

    if (!org) {
      throw new OrganizationNotFoundException(orgId);
    }

    return org;
  }
}
