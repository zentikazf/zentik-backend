import { Injectable, Logger } from '@nestjs/common';
import { TicketCriticality } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Tipo de solicitud ofrecible en el selector del portal. */
export interface AvailableTicketType {
  id: string;
  name: string;
  slug: string;
}

/**
 * `fallback: true` = el proyecto NO tiene contratos que apliquen, así que se
 * devolvieron TODOS los tipos activos de la organización (modo permisivo, igual
 * que OSD). El front lo usa para mostrar la nota "todos los tipos disponibles".
 */
export interface AvailableTicketTypes {
  types: AvailableTicketType[];
  fallback: boolean;
}

/**
 * "¿Qué tipos de solicitud puede elegir el cliente en ESTE proyecto?"
 * (feature #42 — Fase 2).
 *
 * Es la CONTRACARA de `SlaResolverService`: el resolver va de (proyecto, tipo) a
 * la política; este servicio va del proyecto al conjunto de tipos contratados.
 * Mismo dato (`ProjectTicketTypeSla`), otra dirección.
 *
 * Regla de negocio central: **si no hay contratos, se es permisivo**. Un proyecto
 * sin la matriz cargada NO puede dejar al cliente sin poder abrir un ticket; se
 * ofrecen todos los tipos activos y se marca `fallback: true` para que la UI (y la
 * pestaña de cobertura) muestren que falta configurar.
 */
@Injectable()
export class TicketTypeAvailabilityService {
  private readonly logger = new Logger(TicketTypeAvailabilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tipos contratados del proyecto; si no hay ninguno → todos los activos de la org.
   *
   * @param criticality si viene, solo los contratos cuya política sea de ESA
   *   criticidad (así el selector encadena `criticidad → tipo`). Si el filtro no
   *   matchea ningún contrato también se cae al modo permisivo: el cliente ve todos
   *   los tipos en vez de un selector vacío.
   */
  async getAvailableTypes(
    orgId: string,
    projectId: string,
    criticality?: TicketCriticality | null,
  ): Promise<AvailableTicketTypes> {
    const contracts = await this.prisma.projectTicketTypeSla.findMany({
      where: {
        projectId,
        isActive: true,
        // Triple scoping por organización: el proyecto, la política y el tipo tienen
        // que ser de la MISMA org que pide (multi-tenant, igual que el resolver).
        project: { organizationId: orgId },
        slaPolicy: { organizationId: orgId, isActive: true, ...(criticality && { criticality }) },
        // Un tipo dado de baja no se ofrece aunque el contrato siga vivo.
        ticketType: { organizationId: orgId, isActive: true },
      },
      select: { ticketType: { select: { id: true, name: true, slug: true } } },
    });

    if (contracts.length > 0) {
      const types = contracts
        .map((contract) => contract.ticketType)
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
      return { types, fallback: false };
    }

    const types = await this.prisma.ticketType.findMany({
      where: { organizationId: orgId, isActive: true },
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    });

    this.logger.debug(
      `Proyecto ${projectId} sin contratos aplicables (criticidad=${criticality ?? '-'}): ` +
        `modo permisivo con ${types.length} tipo(s) activos org=${orgId}`,
    );
    return { types, fallback: true };
  }

  /**
   * Validación server-side de la creación desde el portal: ¿este tipo se puede
   * usar en este proyecto?
   *
   * Se resuelve SIN filtrar por criticidad a propósito: la disponibilidad es del
   * par (proyecto, tipo); la criticidad solo encadena el selector. Reutiliza
   * `getAvailableTypes` para que lo validado sea exactamente lo ofrecido (si
   * divergieran, el cliente podría ver un tipo que el POST después rechaza).
   *
   * En modo permisivo (proyecto sin contratos) alcanza con que el tipo exista,
   * esté activo y sea de la organización — el scoping NO se relaja nunca.
   */
  async isTypeAvailable(orgId: string, projectId: string, ticketTypeId: string): Promise<boolean> {
    const { types } = await this.getAvailableTypes(orgId, projectId);
    return types.some((type) => type.id === ticketTypeId);
  }
}
