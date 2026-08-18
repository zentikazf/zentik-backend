import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, SlaPolicy, TicketCriticality } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';
import { CreateSlaPolicyDto, SlaCriticalityDto, UpdateSlaPolicyDto } from './dto';

/**
 * Mapa DTO → enum de Prisma. Evita el `as any` del path viejo: los valores son
 * idénticos pero TS no considera asignable un miembro de string-enum a la unión
 * de literales que genera Prisma.
 */
const CRITICALITY_BY_DTO: Record<SlaCriticalityDto, TicketCriticality> = {
  [SlaCriticalityDto.CRITICAL]: TicketCriticality.CRITICAL,
  [SlaCriticalityDto.HIGH]: TicketCriticality.HIGH,
  [SlaCriticalityDto.MEDIUM]: TicketCriticality.MEDIUM,
  [SlaCriticalityDto.LOW]: TicketCriticality.LOW,
};

/** Código de error de Prisma para violación de unique constraint. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * CRUD del catálogo de políticas SLA con nombre (feature #42 — Fase 1).
 *
 * Reglas de negocio:
 * - `(organizationId, name)` es único → `SLA_POLICY_DUPLICATE_NAME` (409).
 * - Nunca se borra: desactivar (`isActive=false`) y solo si NADIE la referencia
 *   (contrato / proyecto / cliente) → `SLA_POLICY_IN_USE` (409). Los tickets
 *   históricos que la apuntan quedan intactos (deadlines congelados).
 */
@Injectable()
export class SlaPolicyService {
  private readonly logger = new Logger(SlaPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async list(orgId: string, includeInactive = false): Promise<SlaPolicy[]> {
    return this.prisma.slaPolicy.findMany({
      where: { organizationId: orgId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ criticality: 'asc' }, { name: 'asc' }],
    });
  }

  async getById(orgId: string, policyId: string): Promise<SlaPolicy> {
    const policy = await this.prisma.slaPolicy.findFirst({
      where: { id: policyId, organizationId: orgId },
    });
    if (!policy) {
      throw new AppException('Política SLA no encontrada', 'SLA_POLICY_NOT_FOUND', 404);
    }
    return policy;
  }

  async create(orgId: string, dto: CreateSlaPolicyDto, userId: string): Promise<SlaPolicy> {
    const name = dto.name.trim();
    await this.assertNameAvailable(orgId, name);

    const policy = await this.runUnique(name, () =>
      this.prisma.slaPolicy.create({
        data: {
          organizationId: orgId,
          name,
          criticality: CRITICALITY_BY_DTO[dto.criticality],
          firstResponseHours: dto.firstResponseHours,
          resolutionHours: dto.resolutionHours,
          pausesOnWaiting: dto.pausesOnWaiting ?? false,
        },
      }),
    );

    this.logger.log(`Política SLA creada: ${policy.id} (${policy.name}) org=${orgId}`);
    this.eventEmitter.emit('sla.policy.created', {
      ...domainEvent('sla.policy.created', 'sla_policy', policy.id, orgId, userId),
      policyId: policy.id,
      organizationId: orgId,
      userId,
    });
    return policy;
  }

  async update(
    orgId: string,
    policyId: string,
    dto: UpdateSlaPolicyDto,
    userId: string,
  ): Promise<SlaPolicy> {
    const existing = await this.getById(orgId, policyId);

    const name = dto.name?.trim();
    if (name && name !== existing.name) {
      await this.assertNameAvailable(orgId, name);
    }

    const policy = await this.runUnique(name ?? existing.name, () =>
      this.prisma.slaPolicy.update({
        where: { id: policyId },
        data: {
          ...(name !== undefined && { name }),
          ...(dto.criticality !== undefined && {
            criticality: CRITICALITY_BY_DTO[dto.criticality],
          }),
          ...(dto.firstResponseHours !== undefined && {
            firstResponseHours: dto.firstResponseHours,
          }),
          ...(dto.resolutionHours !== undefined && { resolutionHours: dto.resolutionHours }),
          ...(dto.pausesOnWaiting !== undefined && { pausesOnWaiting: dto.pausesOnWaiting }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      }),
    );

    this.eventEmitter.emit('sla.policy.updated', {
      ...domainEvent('sla.policy.updated', 'sla_policy', policy.id, orgId, userId),
      policyId: policy.id,
      organizationId: orgId,
      userId,
    });
    return policy;
  }

  /**
   * Baja lógica. Se bloquea si la política está referenciada por un contrato
   * ACTIVO, por un proyecto, por un cliente o por un **paquete de contratos
   * activo**: desactivarla dejaría esos lazos apuntando a una política que la
   * cascada ya no considera (tickets sin SLA).
   *
   * ── Por qué también cuenta los paquetes (#58, decisión 8 del dueño) ──────────
   * Un paquete es la única referencia que NO produce un síntoma inmediato: sus
   * ítems no resuelven ningún ticket, así que dar de baja una política los pudre
   * EN SILENCIO y el dueño se entera recién el día que aplica el paquete y ve
   * "2 ítems omitidos". Contarlos acá convierte ese descubrimiento tardío en un
   * 409 en el momento exacto en que se rompe.
   *
   * Solo los paquetes ACTIVOS: uno archivado no se puede aplicar, así que no
   * tiene sentido que bloquee la limpieza del catálogo de políticas.
   */
  async deactivate(orgId: string, policyId: string, userId: string): Promise<SlaPolicy> {
    await this.getById(orgId, policyId);

    const [contracts, projects, clients, packageItems] = await Promise.all([
      this.prisma.projectTicketTypeSla.count({ where: { slaPolicyId: policyId, isActive: true } }),
      this.prisma.project.count({ where: { slaPolicyId: policyId, organizationId: orgId } }),
      this.prisma.client.count({ where: { defaultSlaPolicyId: policyId, organizationId: orgId } }),
      this.prisma.contractPackageItem.count({
        where: { slaPolicyId: policyId, package: { organizationId: orgId, isActive: true } },
      }),
    ]);

    if (contracts > 0 || projects > 0 || clients > 0 || packageItems > 0) {
      throw new AppException(
        `La política está en uso (${contracts} contrato(s), ${projects} proyecto(s), ${clients} cliente(s), ` +
          `${packageItems} ítem(s) de paquete). Reasigná esas referencias antes de desactivarla.`,
        'SLA_POLICY_IN_USE',
        409,
        { contracts, projects, clients, packageItems },
      );
    }

    const policy = await this.prisma.slaPolicy.update({
      where: { id: policyId },
      data: { isActive: false },
    });

    this.logger.log(`Política SLA desactivada: ${policyId} org=${orgId}`);
    this.eventEmitter.emit('sla.policy.deactivated', {
      ...domainEvent('sla.policy.deactivated', 'sla_policy', policyId, orgId, userId),
      policyId,
      organizationId: orgId,
      userId,
    });
    return policy;
  }

  private async assertNameAvailable(orgId: string, name: string): Promise<void> {
    const duplicate = await this.prisma.slaPolicy.findFirst({
      where: { organizationId: orgId, name },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppException(
        `Ya existe una política SLA llamada "${name}" en la organización`,
        'SLA_POLICY_DUPLICATE_NAME',
        409,
      );
    }
  }

  /**
   * El pre-chequeo de nombre no es atómico (dos requests concurrentes pasan los
   * dos): la unique de la DB es la que manda. Se traduce el P2002 al MISMO código
   * de error para que el cliente no vea un 500.
   */
  private async runUnique<T>(name: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new AppException(
          `Ya existe una política SLA llamada "${name}" en la organización`,
          'SLA_POLICY_DUPLICATE_NAME',
          409,
        );
      }
      throw error;
    }
  }
}
