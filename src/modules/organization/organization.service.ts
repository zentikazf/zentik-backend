import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto';
import {
  OrganizationNotFoundException,
  DuplicateResourceException,
} from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class OrganizationService {
  private readonly logger = new Logger(OrganizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateOrganizationDto, userId: string) {
    const slug = dto.slug || this.generateSlug(dto.name);

    const existing = await this.prisma.organization.findUnique({
      where: { slug },
    });

    if (existing) {
      throw new DuplicateResourceException('organizacion', 'slug', slug);
    }

    const organization = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: dto.name,
          slug,
        },
      });

      // Default SaaS factory roles
      const defaultRoles = [
        { name: 'Owner', description: 'Propietario con acceso completo', isSystem: true, isDefault: false },
        { name: 'Product Owner', description: 'Responsable del producto y backlog', isSystem: false, isDefault: false },
        { name: 'Project Manager', description: 'Gestión de proyectos y equipo', isSystem: false, isDefault: false },
        { name: 'Tech Lead', description: 'Líder técnico del equipo', isSystem: false, isDefault: false },
        { name: 'Developer', description: 'Desarrollador de software', isSystem: false, isDefault: true },
        { name: 'QA Engineer', description: 'Ingeniero de calidad y testing', isSystem: false, isDefault: false },
        { name: 'Designer', description: 'Diseñador UI/UX', isSystem: false, isDefault: false },
        { name: 'DevOps', description: 'Infraestructura y despliegues', isSystem: false, isDefault: false },
        { name: 'Soporte', description: 'Soporte al cliente', isSystem: false, isDefault: false },
        { name: 'Cliente', description: 'Cliente externo con acceso al portal', isSystem: true, isDefault: false },
      ];

      const createdRoles: { id: string; name: string }[] = [];
      for (const roleDef of defaultRoles) {
        const role = await tx.role.create({
          data: {
            organizationId: org.id,
            name: roleDef.name,
            description: roleDef.description,
            isSystem: roleDef.isSystem,
            isDefault: roleDef.isDefault,
          },
        });
        createdRoles.push({ id: role.id, name: role.name });
      }

      // Assign suggested permissions to each role
      const allPermissions = await tx.permission.findMany();
      const permMap = new Map(allPermissions.map((p) => [`${p.action}:${p.resource}`, p.id]));

      const suggestions: Record<string, string[]> = {
        'Owner': ['*:*'],
        'Product Owner': ['manage:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:members', 'read:members', 'read:billing', 'manage:chat'],
        'Project Manager': ['manage:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:members', 'manage:time-entries', 'read:billing', 'manage:chat', 'read:audit'],
        'Tech Lead': ['read:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:time-entries', 'read:members', 'manage:chat'],
        'Developer': ['read:projects', 'manage:tasks', 'read:sprints', 'read:boards', 'manage:time-entries', 'manage:chat'],
        'QA Engineer': ['read:projects', 'manage:tasks', 'read:sprints', 'read:boards', 'manage:time-entries', 'manage:chat'],
        'Designer': ['read:projects', 'manage:tasks', 'read:boards', 'manage:time-entries', 'manage:chat'],
        'DevOps': ['read:projects', 'read:tasks', 'read:sprints', 'manage:time-entries', 'manage:chat'],
        'Soporte': ['read:projects', 'read:tasks', 'manage:time-entries', 'manage:chat'],
        'Cliente': ['read:projects', 'read:tasks'],
      };

      for (const role of createdRoles) {
        const permKeys = suggestions[role.name] || [];
        const permIds = permKeys.map((k) => permMap.get(k)).filter(Boolean) as string[];
        if (permIds.length > 0) {
          await tx.rolePermission.createMany({
            data: permIds.map((permissionId) => ({ roleId: role.id, permissionId })),
            skipDuplicates: true,
          });
        }
      }

      const ownerRole = createdRoles.find((r) => r.name === 'Owner')!;

      // Add the creator as owner
      await tx.organizationMember.create({
        data: {
          organizationId: org.id,
          userId,
          roleId: ownerRole.id,
        },
      });

      return org;
    });

    this.logger.log(`Organization created: ${organization.id} by user: ${userId}`);
    this.eventEmitter.emit('organization.created', {
      ...domainEvent('organization.created', 'organization', organization.id, organization.id, userId),
      organizationId: organization.id,
      userId,
    });

    return organization;
  }

  async findAll(userId: string) {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId },
      include: {
        organization: {
          include: {
            _count: {
              select: {
                members: true,
                projects: true,
              },
            },
          },
        },
        role: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return memberships.map((m) => ({
      ...m.organization,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
  }

  async findById(orgId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        _count: {
          select: {
            members: true,
            projects: true,
          },
        },
        subscription: {
          select: {
            plan: true,
            status: true,
            seatsIncluded: true,
            seatsUsed: true,
          },
        },
      },
    });

    if (!organization) {
      throw new OrganizationNotFoundException(orgId);
    }

    return organization;
  }

  async update(orgId: string, dto: UpdateOrganizationDto) {
    await this.findById(orgId);

    if (dto.slug) {
      const existing = await this.prisma.organization.findFirst({
        where: { slug: dto.slug, id: { not: orgId } },
      });

      if (existing) {
        throw new DuplicateResourceException('organizacion', 'slug', dto.slug);
      }
    }

    const organization = await this.prisma.organization.update({
      where: { id: orgId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.slug && { slug: dto.slug }),
      },
    });

    this.eventEmitter.emit('organization.updated', {
      ...domainEvent('organization.updated', 'organization', orgId, orgId),
      organizationId: orgId,
    });

    return organization;
  }

  async softDelete(orgId: string, userId: string) {
    await this.findById(orgId);

    // Soft delete: append timestamp to slug to free up the slug, then mark via naming convention
    const timestamp = Date.now();
    const organization = await this.prisma.organization.update({
      where: { id: orgId },
      data: {
        slug: `deleted-${timestamp}-${orgId}`,
        name: `[Eliminada] ${(await this.prisma.organization.findUnique({ where: { id: orgId } }))?.name}`,
      },
    });

    this.logger.log(`Organization soft-deleted: ${orgId} by user: ${userId}`);
    this.eventEmitter.emit('organization.deleted', {
      ...domainEvent('organization.deleted', 'organization', orgId, orgId, userId),
      organizationId: orgId,
      userId,
    });

    return organization;
  }

  async listMembers(orgId: string) {
    await this.findById(orgId);

    return this.prisma.organizationMember.findMany({
      where: { organizationId: orgId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        role: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }

  async updateMemberRole(orgId: string, memberId: string, roleId: string) {
    await this.findById(orgId);

    const member = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId: orgId },
    });

    if (!member) {
      throw new OrganizationNotFoundException(orgId);
    }

    // Validate the role belongs to this organization
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, organizationId: orgId },
    });

    if (!role) {
      throw new OrganizationNotFoundException(orgId);
    }

    return this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { roleId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        role: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  }

  async removeMember(orgId: string, memberId: string) {
    await this.findById(orgId);

    const member = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId: orgId },
    });

    if (!member) {
      throw new OrganizationNotFoundException(orgId);
    }

    await this.prisma.organizationMember.delete({
      where: { id: memberId },
    });

    this.eventEmitter.emit('organization.member.removed', {
      ...domainEvent('organization.member.removed', 'organization', orgId, orgId, member.userId),
      organizationId: orgId,
      userId: member.userId,
    });

    return { deleted: true };
  }

  async ensureSaaSRoles(orgId: string) {
    await this.findById(orgId);

    const existingRoles = await this.prisma.role.findMany({
      where: { organizationId: orgId },
      select: { name: true },
    });
    const existingNames = new Set(existingRoles.map((r) => r.name));

    const defaultRoles = [
      { name: 'Owner', description: 'Propietario con acceso completo', isSystem: true, isDefault: false },
      { name: 'Product Owner', description: 'Responsable del producto y backlog', isSystem: false, isDefault: false },
      { name: 'Project Manager', description: 'Gestión de proyectos y equipo', isSystem: false, isDefault: false },
      { name: 'Tech Lead', description: 'Líder técnico del equipo', isSystem: false, isDefault: false },
      { name: 'Developer', description: 'Desarrollador de software', isSystem: false, isDefault: true },
      { name: 'QA Engineer', description: 'Ingeniero de calidad y testing', isSystem: false, isDefault: false },
      { name: 'Designer', description: 'Diseñador UI/UX', isSystem: false, isDefault: false },
      { name: 'DevOps', description: 'Infraestructura y despliegues', isSystem: false, isDefault: false },
      { name: 'Soporte', description: 'Soporte al cliente', isSystem: false, isDefault: false },
    ];

    const missing = defaultRoles.filter((r) => !existingNames.has(r.name));
    if (missing.length === 0) {
      return { created: [], existing: defaultRoles.map((r) => r.name) };
    }

    const suggestions: Record<string, string[]> = {
      'Owner': ['*:*'],
      'Product Owner': ['manage:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:members', 'read:members', 'read:billing', 'manage:chat'],
      'Project Manager': ['manage:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:members', 'manage:time-entries', 'read:billing', 'manage:chat', 'read:audit'],
      'Tech Lead': ['read:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:time-entries', 'read:members', 'manage:chat'],
      'Developer': ['read:projects', 'manage:tasks', 'read:sprints', 'read:boards', 'manage:time-entries', 'manage:chat'],
      'QA Engineer': ['read:projects', 'manage:tasks', 'read:sprints', 'read:boards', 'manage:time-entries', 'manage:chat'],
      'Designer': ['read:projects', 'manage:tasks', 'read:boards', 'manage:time-entries', 'manage:chat'],
      'DevOps': ['read:projects', 'read:tasks', 'read:sprints', 'manage:time-entries', 'manage:chat'],
      'Soporte': ['read:projects', 'read:tasks', 'manage:time-entries', 'manage:chat'],
    };

    const allPermissions = await this.prisma.permission.findMany();
    const permMap = new Map(allPermissions.map((p) => [`${p.action}:${p.resource}`, p.id]));

    const createdNames: string[] = [];
    for (const roleDef of missing) {
      const role = await this.prisma.role.create({
        data: {
          organizationId: orgId,
          name: roleDef.name,
          description: roleDef.description,
          isSystem: roleDef.isSystem,
          isDefault: roleDef.isDefault,
        },
      });

      const permKeys = suggestions[roleDef.name] || [];
      const permIds = permKeys.map((k) => permMap.get(k)).filter(Boolean) as string[];
      if (permIds.length > 0) {
        await this.prisma.rolePermission.createMany({
          data: permIds.map((permissionId) => ({ roleId: role.id, permissionId })),
          skipDuplicates: true,
        });
      }

      createdNames.push(roleDef.name);
    }

    this.logger.log(`Backfilled ${createdNames.length} roles for org: ${orgId}`);
    return {
      created: createdNames,
      existing: [...existingNames],
    };
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
