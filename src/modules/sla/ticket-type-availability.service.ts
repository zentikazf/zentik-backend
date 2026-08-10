import { Injectable, Logger } from '@nestjs/common';
import { TicketCriticality } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MAX_TICKET_TYPE_DEPTH } from './ticket-type.service';

/**
 * Quién está preguntando (#48 T3).
 *
 * NO tiene default a propósito: sin él, el compilador obliga a decidir en cada
 * call site nuevo. Con un default, la elección equivocada pasa en silencio — y
 * la equivocación cara es filtrar de menos (mostrarle al cliente una carpeta que
 * el admin ocultó).
 */
export type TicketTypeAudience = 'CLIENT' | 'STAFF';

export interface GetAvailableTypesOptions {
  /**
   * Filtro del selector encadenado del portal: solo los contratos cuya política
   * sea de ESA criticidad. Si no matchea ninguno se cae al modo permisivo.
   */
  criticality?: TicketCriticality | null;
  audience: TicketTypeAudience;
}

/** Tipo de solicitud ofrecible en el selector del portal. */
export interface AvailableTicketType {
  id: string;
  name: string;
  slug: string;
  /**
   * Nombres de los ancestros, de la raíz hacia abajo y SIN el propio, listos
   * para pintar `Incidencia › Error del sistema` (#48 T4).
   *
   * Se resuelven acá y no en el front porque el front solo tiene los tipos
   * OFRECIDOS: un padre oculto o sin contrato nunca viaja en esa lista, así que
   * la cadena se le cortaba y el contexto desaparecía.
   *
   * Con `audience: 'CLIENT'` un ancestro con `clientVisible: false` **no aporta
   * su nombre** (#48 R3.1, decisión del dueño): el cliente lee
   * `Error del sistema`, no `Incidencia › Error del sistema`. Con `'STAFF'`
   * viajan todos.
   */
  ancestorNames: string[];
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
 *
 * ⚠️ Fase 3 (tipos en ÁRBOL): la disponibilidad también es de **match EXACTO**. Un
 * contrato sobre el tipo PADRE no habilita a sus hijos, ni contratar un hijo
 * arrastra al padre. Es la misma decisión deliberada que el paso 1 de
 * `SlaResolverService` (paridad con OSD): lo ofrecido es exactamente lo contratado,
 * sin herencia por la jerarquía. La UI muestra el path del padre solo como contexto
 * (`Incidencia › Error del sistema`), nunca como cobertura.
 */
@Injectable()
export class TicketTypeAvailabilityService {
  private readonly logger = new Logger(TicketTypeAvailabilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tipos contratados del proyecto; si no hay ninguno → todos los activos de la org.
   *
   * ⚠️ El filtro por `clientVisible` va DENTRO del `where`, en LAS DOS ramas
   * (#48 R2.4). No es estilo, es corrección: el modo lo decide
   * `if (contracts.length > 0)`. Filtrando DESPUÉS, un proyecto cuyos contratos
   * apunten todos a carpetas ocultas devolvería `{ types: [], fallback: false }`
   * → selector vacío y la UI creyendo que el proyecto está configurado. Con el
   * filtro adentro, esos contratos no cuentan y cae correctamente al modo
   * permisivo. La rama permisiva es la más fácil de olvidar y la más peligrosa:
   * es el estado por defecto de todo proyecto sin configurar.
   */
  async getAvailableTypes(
    orgId: string,
    projectId: string,
    options: GetAvailableTypesOptions,
  ): Promise<AvailableTicketTypes> {
    const { criticality, audience } = options;
    // El ojito SOLO filtra la lectura del CLIENTE. El staff ve todo, siempre
    // (#48 R2.1): el catálogo, la reclasificación y el alta interna no lo miran.
    const visibleOnly = audience === 'CLIENT' ? { clientVisible: true } : {};

    const contracts = await this.prisma.projectTicketTypeSla.findMany({
      where: {
        projectId,
        isActive: true,
        // Triple scoping por organización: el proyecto, la política y el tipo tienen
        // que ser de la MISMA org que pide (multi-tenant, igual que el resolver).
        project: { organizationId: orgId },
        slaPolicy: { organizationId: orgId, isActive: true, ...(criticality && { criticality }) },
        // Un tipo dado de baja no se ofrece aunque el contrato siga vivo.
        ticketType: { organizationId: orgId, isActive: true, ...visibleOnly },
      },
      select: { ticketType: { select: { id: true, name: true, slug: true, parentId: true } } },
    });

    if (contracts.length > 0) {
      const rows = contracts
        .map((contract) => contract.ticketType)
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
      return { types: await this.withAncestorNames(orgId, rows, audience), fallback: false };
    }

    const rows = await this.prisma.ticketType.findMany({
      where: { organizationId: orgId, isActive: true, ...visibleOnly },
      select: { id: true, name: true, slug: true, parentId: true },
      orderBy: { name: 'asc' },
    });

    this.logger.debug(
      `Proyecto ${projectId} sin contratos aplicables (criticidad=${criticality ?? '-'}, ` +
        `audiencia=${audience}): modo permisivo con ${rows.length} tipo(s) activos org=${orgId}`,
    );
    return { types: await this.withAncestorNames(orgId, rows, audience), fallback: true };
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
   * ⚠️ `audience: 'CLIENT'` fijo: este método ES la validación del POST del
   * PORTAL, y por eso mismo tiene que rechazar lo que el cliente no puede ver
   * (una carpeta oculta enviada a mano). Si algún día lo necesita un path de
   * staff, no lo reutilices así: agregale el parámetro de audiencia.
   *
   * En modo permisivo (proyecto sin contratos) alcanza con que el tipo exista,
   * esté activo, sea visible y sea de la organización — el scoping NO se relaja nunca.
   */
  async isTypeAvailable(orgId: string, projectId: string, ticketTypeId: string): Promise<boolean> {
    const { types } = await this.getAvailableTypes(orgId, projectId, { audience: 'CLIENT' });
    return types.some((type) => type.id === ticketTypeId);
  }

  /**
   * Resuelve el camino de nombres de cada tipo trepando por `parentId` (#48 T4).
   *
   * Se hace SERVER-SIDE porque el front solo recibe los tipos OFRECIDOS: un
   * ancestro oculto o sin contrato no viaja en esa lista, así que armar la cadena
   * allá la cortaba justo en el caso que importa (el helper del front documenta
   * esa degradación).
   *
   * Una consulta más al catálogo COMPLETO de la organización — decenas de filas
   * (#48 R1.4), y hace falta completo justamente porque los ancestros pueden no
   * estar entre los ofrecidos.
   *
   * Regla R3.1: con `audience: 'CLIENT'`, un ancestro con `clientVisible: false`
   * NO aporta su nombre; los ancestros visibles POR ENCIMA de él sí (un abuelo
   * visible bajo un padre oculto sigue dando contexto). No se filtra por
   * `isActive`: desactivar un padre desactiva su rama entera, así que un tipo
   * ofrecido no puede colgar de un ancestro inactivo.
   */
  private async withAncestorNames(
    orgId: string,
    rows: { id: string; name: string; slug: string; parentId: string | null }[],
    audience: TicketTypeAudience,
  ): Promise<AvailableTicketType[]> {
    if (rows.length === 0) return [];

    const catalog = await this.prisma.ticketType.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true, parentId: true, clientVisible: true },
    });
    const byId = new Map(catalog.map((type) => [type.id, type]));

    return rows.map(({ id, name, slug, parentId }) => {
      const ancestorNames: string[] = [];
      let current = parentId ? byId.get(parentId) : undefined;
      let hops = 0;

      // Tope de saltos: un ciclo ya persistido es imposible con las validaciones
      // del service, pero colgar el request sale más caro que cubrirlo.
      while (current && hops < MAX_TICKET_TYPE_DEPTH) {
        if (audience === 'STAFF' || current.clientVisible) {
          ancestorNames.unshift(current.name);
        }
        current = current.parentId ? byId.get(current.parentId) : undefined;
        hops++;
      }

      return { id, name, slug, ancestorNames };
    });
  }
}
