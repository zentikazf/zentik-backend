import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProjectLifecycleStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';
import { AssignSlaDto, UpsertProjectContractDto } from './dto';

/** Fila de la matriz tipo → política de un proyecto (con su hueco si no hay contrato). */
export interface ProjectContractRow {
  ticketTypeId: string;
  ticketTypeName: string;
  contractId: string | null;
  slaPolicyId: string | null;
  slaPolicyName: string | null;
  contractNotes: string | null;
  isActive: boolean;
}

/** Cobertura de contratos de UN proyecto. */
export interface ProjectCoverage {
  totalTypes: number;
  coveredTypes: number;
  missingTypes: { id: string; name: string }[];
  isComplete: boolean;
}

/**
 * Contratos SLA por proyecto + tipo (paso 1 de la cascada) y asignación de las
 * políticas de proyecto (paso 2) y cliente (paso 3).
 *
 * Todo scopeado por `organizationId`: un proyecto/cliente/tipo/política de otra
 * organización se trata como inexistente (404), nunca como error de permisos.
 */
@Injectable()
export class SlaContractService {
  private readonly logger = new Logger(SlaContractService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Matriz del proyecto + qué tipos activos quedaron SIN contrato. */
  async getByProject(orgId: string, projectId: string) {
    const project = await this.assertProject(orgId, projectId);

    const [types, contracts] = await Promise.all([
      this.prisma.ticketType.findMany({
        where: { organizationId: orgId, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.projectTicketTypeSla.findMany({
        where: { projectId },
        include: { slaPolicy: { select: { id: true, name: true } } },
      }),
    ]);

    const byTypeId = new Map(contracts.map((c) => [c.ticketTypeId, c]));
    const items: ProjectContractRow[] = types.map((type) => {
      const contract = byTypeId.get(type.id);
      const covered = !!contract?.isActive;
      return {
        ticketTypeId: type.id,
        ticketTypeName: type.name,
        contractId: contract?.id ?? null,
        slaPolicyId: covered ? contract!.slaPolicyId : null,
        slaPolicyName: covered ? contract!.slaPolicy.name : null,
        contractNotes: contract?.contractNotes ?? null,
        isActive: covered,
      };
    });

    return {
      project: {
        id: project.id,
        name: project.name,
        slaPolicyId: project.slaPolicyId,
      },
      items,
      coverage: this.buildCoverage(types, items),
    };
  }

  /**
   * Upsert de la matriz completa del proyecto, en UNA `$transaction` (todo o nada:
   * una matriz a medio guardar dejaría contratos inconsistentes con lo que el
   * usuario ve en pantalla).
   */
  async upsertForProject(
    orgId: string,
    projectId: string,
    dto: UpsertProjectContractDto,
    userId: string,
  ) {
    await this.assertProject(orgId, projectId);

    const typeIds = dto.items.map((i) => i.ticketTypeId);
    const duplicated = typeIds.filter((id, idx) => typeIds.indexOf(id) !== idx);
    if (duplicated.length > 0) {
      throw new AppException(
        'La matriz tiene el mismo tipo de solicitud más de una vez',
        'SLA_CONTRACT_DUPLICATE_TYPE',
        422,
        { ticketTypeIds: [...new Set(duplicated)] },
      );
    }

    const uniqueTypeIds = [...new Set(typeIds)];
    const uniquePolicyIds = [...new Set(dto.items.map((i) => i.slaPolicyId))];

    if (uniqueTypeIds.length > 0) {
      const typeCount = await this.prisma.ticketType.count({
        where: { id: { in: uniqueTypeIds }, organizationId: orgId },
      });
      if (typeCount !== uniqueTypeIds.length) {
        throw new AppException(
          'Algún tipo de solicitud no existe en la organización',
          'TICKET_TYPE_NOT_FOUND',
          404,
        );
      }
    }

    if (uniquePolicyIds.length > 0) {
      const policyCount = await this.prisma.slaPolicy.count({
        where: { id: { in: uniquePolicyIds }, organizationId: orgId, isActive: true },
      });
      if (policyCount !== uniquePolicyIds.length) {
        throw new AppException(
          'Alguna política SLA no existe o está desactivada en la organización',
          'SLA_POLICY_NOT_FOUND',
          404,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        await tx.projectTicketTypeSla.upsert({
          where: {
            projectId_ticketTypeId: { projectId, ticketTypeId: item.ticketTypeId },
          },
          create: {
            projectId,
            ticketTypeId: item.ticketTypeId,
            slaPolicyId: item.slaPolicyId,
            contractNotes: item.contractNotes ?? null,
            isActive: item.isActive ?? true,
          },
          update: {
            slaPolicyId: item.slaPolicyId,
            contractNotes: item.contractNotes ?? null,
            isActive: item.isActive ?? true,
          },
        });
      }

      // Evento dentro de la transacción (checklist del blueprint).
      this.eventEmitter.emit('sla.contract.upserted', {
        ...domainEvent('sla.contract.upserted', 'project', projectId, orgId, userId),
        projectId,
        organizationId: orgId,
        changes: dto.items.length,
        userId,
      });
    });

    this.logger.log(
      `Contratos SLA actualizados: proyecto=${projectId} filas=${dto.items.length} org=${orgId}`,
    );
    return this.getByProject(orgId, projectId);
  }

  /** Paso 2 de la cascada: SLA propio del proyecto. `null` desasigna. */
  async assignProjectPolicy(orgId: string, projectId: string, dto: AssignSlaDto, userId: string) {
    await this.assertProject(orgId, projectId);
    const slaPolicyId = await this.resolveAssignablePolicyId(orgId, dto);

    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: { slaPolicyId },
      select: { id: true, name: true, slaPolicyId: true },
    });

    this.logger.log(
      `SLA de proyecto ${projectId} → ${slaPolicyId ?? 'sin política'} (user=${userId})`,
    );
    return project;
  }

  /** Paso 3 de la cascada: SLA default del cliente. `null` desasigna. */
  async assignClientPolicy(orgId: string, clientId: string, dto: AssignSlaDto, userId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId },
      select: { id: true },
    });
    if (!client) {
      throw new AppException('Cliente no encontrado', 'CLIENT_NOT_FOUND', 404);
    }
    const defaultSlaPolicyId = await this.resolveAssignablePolicyId(orgId, dto);

    const updated = await this.prisma.client.update({
      where: { id: clientId },
      data: { defaultSlaPolicyId },
      select: { id: true, name: true, defaultSlaPolicyId: true },
    });

    this.logger.log(
      `SLA default de cliente ${clientId} → ${defaultSlaPolicyId ?? 'sin política'} (user=${userId})`,
    );
    return updated;
  }

  /**
   * Cobertura global: todos los proyectos ACTIVOS × tipos activos, marcando los
   * pares sin contrato. Los proyectos archivados/deshabilitados se excluyen: no
   * reciben tickets nuevos y solo ensuciarían el checklist.
   */
  async getCoverage(orgId: string) {
    const [projects, types] = await Promise.all([
      this.prisma.project.findMany({
        where: { organizationId: orgId, lifecycleStatus: ProjectLifecycleStatus.ACTIVE },
        select: {
          id: true,
          name: true,
          slaPolicyId: true,
          client: { select: { id: true, name: true, defaultSlaPolicyId: true } },
          slaContracts: { where: { isActive: true }, select: { ticketTypeId: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.ticketType.findMany({
        where: { organizationId: orgId, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const items = projects.map((project) => {
      const coveredTypeIds = new Set(project.slaContracts.map((c) => c.ticketTypeId));
      const missingTypes = types.filter((t) => !coveredTypeIds.has(t.id));
      return {
        projectId: project.id,
        projectName: project.name,
        clientId: project.client?.id ?? null,
        clientName: project.client?.name ?? null,
        hasProjectPolicy: !!project.slaPolicyId,
        hasClientPolicy: !!project.client?.defaultSlaPolicyId,
        totalTypes: types.length,
        coveredTypes: types.length - missingTypes.length,
        missingTypes,
        isComplete: missingTypes.length === 0,
      };
    });

    return {
      totalProjects: items.length,
      totalTypes: types.length,
      completeProjects: items.filter((i) => i.isComplete).length,
      items,
    };
  }

  private buildCoverage(
    types: { id: string; name: string }[],
    items: ProjectContractRow[],
  ): ProjectCoverage {
    const coveredTypeIds = new Set(items.filter((i) => i.isActive).map((i) => i.ticketTypeId));
    const missingTypes = types
      .filter((t) => !coveredTypeIds.has(t.id))
      .map((t) => ({ id: t.id, name: t.name }));
    return {
      totalTypes: types.length,
      coveredTypes: types.length - missingTypes.length,
      missingTypes,
      isComplete: missingTypes.length === 0,
    };
  }

  private async assertProject(orgId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId },
      select: { id: true, name: true, slaPolicyId: true },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }
    return project;
  }

  /** Valida que la política exista, esté activa y sea de la org. `null` = desasignar. */
  private async resolveAssignablePolicyId(orgId: string, dto: AssignSlaDto): Promise<string | null> {
    if (!dto.slaPolicyId) return null;

    const policy = await this.prisma.slaPolicy.findFirst({
      where: { id: dto.slaPolicyId, organizationId: orgId, isActive: true },
      select: { id: true },
    });
    if (!policy) {
      throw new AppException(
        'Política SLA no encontrada o desactivada',
        'SLA_POLICY_NOT_FOUND',
        404,
      );
    }
    return policy.id;
  }
}
