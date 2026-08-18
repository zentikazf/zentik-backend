import { Injectable, Logger } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OnnixClientService } from './onnix-client.service';
import { OnnixCatalogos, OnnixEquipoUsuario } from './types/onnix.types';
import {
  ONNIX_ENTITY_TYPE_TICKET_TYPE,
  ONNIX_TICKET_TYPE_SLUG_MAP,
} from './onnix-ticket-type-map';
import { ONNIX_ENTITY_TYPE_USER, ONNIX_SUPPORT_TEAM_ID } from './onnix-user-map';

/**
 * Clave de match del seed de usuarios (#52 R1.2): trim + lowercase. El email de
 * Zentik es `@unique` pero eso NO garantiza la misma capitalizacion que OSD, y una
 * mayuscula de diferencia dejaria a un usuario sin mapear en silencio.
 * Devuelve '' para nulos/vacios, que nunca matchea (el `if (key)` del indice).
 */
function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * Resultado del seed de mappings de tipo por organización (#50 D3).
 * `created`/`updated`/`alreadyMapped` permiten verificar la idempotencia de un
 * vistazo (2ª corrida = todo en `alreadyMapped`). Las dos listas de slugs son la
 * señal de desalineación entre el árbol de Zentik y el catálogo de OSD (R1.3).
 */
export interface SeedTicketTypeMappingsOrgResult {
  organizationId: string;
  created: number;
  updated: number;
  alreadyMapped: number;
  /** Slugs de TicketType de la org que NO están en la tabla de R1.4 (solo log). */
  zentikSlugsWithoutPair: string[];
  /** Slugs de la tabla de R1.4 sin ningún TicketType en esta org (solo log). */
  tableSlugsWithoutTicketType: string[];
}

/**
 * Resultado del seed de mappings de usuario por organización (#52 R1.3).
 *
 * Las tres listas van con NOMBRE Y EMAIL, no con contadores, y ese es el punto:
 * son la única señal que va a delatar al próximo usuario que se sume a Zentik y que
 * nadie dé de alta en el equipo de OSD. Sin nombrarlos, su primera asignación se
 * pierde en un warn del dispatcher que nadie está mirando.
 */
export interface SeedUserMappingsOrgResult {
  organizationId: string;
  created: number;
  updated: number;
  alreadyMapped: number;
  /** Usuarios internos de Zentik sin par en el equipo de OSD (sus asignaciones NO viajan). */
  zentikUsersWithoutPair: string[];
  /** Miembros del equipo de OSD sin usuario interno en esta org. */
  onnixMembersWithoutPair: string[];
  /** Miembros con `is_active: false` en OSD: excluidos del mapeo a propósito. */
  inactiveSkipped: string[];
}

/**
 * Mapeo Zentik → Onnix (feature #13, D8).
 *
 * - Cliente/proyecto: tabla `onnix_entity_mappings` (IDs explícitos = fuente de
 *   verdad en runtime, NO match por nombre). Cliente obligatorio (null → la fila
 *   va a `failed`, R16); proyecto best-effort (null → se envía sin proyecto, R18).
 * - Tipo/categoría/prioridad (R19): si el dev cargó un mapeo explícito en
 *   `onnix_entity_mappings` (entityType 'ticket_type'|'ticket_category'|
 *   'ticket_priority', zentikId = el valor del enum Zentik) se usa ese id; si no,
 *   fallback al primer item del catálogo + warn. Los valores exactos los siembra
 *   el dev contra `GET /catalogos/*` vivo (D-17 [ASSUMED]).
 * - Tipo REAL del árbol (#50 R1): antes del default corre la cascada nodo → padre
 *   sobre los mappings `ticket_type` que siembra `seedTicketTypeMappings()` desde
 *   la tabla confirmada de R1.4 (`onnix-ticket-type-map.ts`).
 * - Estado (R21): mapa fijo TicketStatus → slug, validado contra el catálogo de
 *   estados cacheado (R20).
 */
@Injectable()
export class OnnixMappingService {
  private readonly logger = new Logger(OnnixMappingService.name);
  /** Cache in-memory de catálogos con TTL (R20). Por proceso; barato y suficiente. */
  private catalogCache: { value: OnnixCatalogos; expiresAt: number } | null = null;

  /**
   * Mapa fijo Zentik TicketStatus → slug Onnix. Slugs de ejemplo del OpenAPI:
   * 'nuevo'/'en_proceso'/'resuelto'. El dev valida los slugs exactos contra
   * GET /catalogos/estados (D-17). Si un slug no existe en el catálogo, se loggea
   * warn y Onnix devolverá 422 (terminal) — señal clara para corregir el mapa.
   */
  private static readonly STATUS_SLUG: Record<TicketStatus, string> = {
    OPEN: 'nuevo',
    IN_PROGRESS: 'en_proceso',
    IN_REVIEW: 'en_proceso',
    RESOLVED: 'resuelto',
    CLOSED: 'cerrado',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly onnix: OnnixClientService,
  ) {}

  /** client_id de Onnix; null si el cliente no está mapeado (→ fila failed, R16). */
  async resolveClientId(
    organizationId: string,
    zentikClientId: string,
  ): Promise<number | null> {
    return this.lookup(organizationId, 'client', zentikClientId);
  }

  /** project_id de Onnix; null si no hay mapeo (best-effort, R18). */
  async resolveProjectId(
    organizationId: string,
    zentikProjectId: string | null | undefined,
  ): Promise<number | null> {
    if (!zentikProjectId) return null;
    return this.lookup(organizationId, 'project', zentikProjectId);
  }

  /**
   * `assigned_to` de OSD para un usuario de Zentik (#52 R1.1); null si no hay
   * mapeo. Best-effort A PROPOSITO, en los DOS callers:
   * - en el create (R2.2) el ticket viaja SIN `assigned_to` — nunca se falla un
   *   ticket por no saber a quien asignarlo;
   * - en `ASSIGNEE_CHANGED` (R3.3) la fila se skipea con warn — nunca a la DLQ.
   * El seed de `seedUserMappings()` es lo que llena esta tabla.
   */
  async resolveUserId(
    organizationId: string,
    zentikUserId: string | null | undefined,
  ): Promise<number | null> {
    if (!zentikUserId) return null;
    return this.lookup(organizationId, ONNIX_ENTITY_TYPE_USER, zentikUserId);
  }

  private async lookup(
    organizationId: string,
    entityType: string,
    zentikId: string,
  ): Promise<number | null> {
    // Scoping multi-tenant: el mapeo se filtra por organizacion (clave compuesta).
    const row = await this.prisma.onnixEntityMapping.findUnique({
      where: {
        organizationId_entityType_zentikId: { organizationId, entityType, zentikId },
      },
      select: { onnixId: true },
    });
    return row?.onnixId ?? null;
  }

  /** Slug Onnix para un estado Zentik (R21), validado contra el catálogo vivo. */
  async resolveStatusSlug(status: TicketStatus, traceId: string): Promise<string> {
    const slug = OnnixMappingService.STATUS_SLUG[status];
    const catalogos = await this.getCatalogos(traceId);
    if (!catalogos.estados.some((e) => e.slug === slug)) {
      this.logger.warn(
        `Slug de estado '${slug}' (Zentik ${status}) no está en el catálogo Onnix; revisar mapeo D-17`,
      );
    }
    return slug;
  }

  /**
   * IDs Onnix de tipo/categoría/prioridad (R19). Mapeo explícito si existe; si no,
   * primer item del catálogo + warn. Lanza si un catálogo viene vacío (sin id no
   * se puede crear el ticket → fallo terminal vía 422 si se intentara).
   *
   * `zentikTicketTypeId` (#50 R1.1) es OPCIONAL y va AL FINAL a propósito: los
   * callers viejos siguen compilando y siguen cayendo en el default de hoy.
   */
  async resolveCatalogIds(
    organizationId: string,
    category: string,
    priority: string,
    traceId: string,
    zentikTicketTypeId?: string | null,
  ): Promise<{
    ticketTypeId: number;
    ticketCategoryId: number;
    ticketPriorityId: number;
  }> {
    const c = await this.getCatalogos(traceId);
    return {
      ticketTypeId: await this.resolveTicketTypeId(
        organizationId,
        category,
        zentikTicketTypeId,
        c.tipos,
      ),
      ticketCategoryId: await this.resolveCatalogId(organizationId, 'ticket_category', category, c.categorias),
      ticketPriorityId: await this.resolveCatalogId(organizationId, 'ticket_priority', priority, c.prioridades),
    };
  }

  /**
   * Cascada del tipo de incidencia REAL (#50 R1.1):
   *   1. mapping del NODO exacto (`zentikId = TicketType.id`),
   *   2. mapping del PADRE (la carpeta) — red para tipos nuevos creados dentro de
   *      una rama, que nadie sembró todavía,
   *   3. el default de HOY intacto: mapping por enum + catálogo[0] + warn.
   *
   * Ticket sin `ticketTypeId` (histórico/edge, R1.5) → salta directo al paso 3.
   * NUNCA falla por esto: el ticket igual se crea en OSD, con el tipo genérico.
   */
  private async resolveTicketTypeId(
    organizationId: string,
    category: string,
    zentikTicketTypeId: string | null | undefined,
    tipos: { id: number }[],
  ): Promise<number> {
    if (zentikTicketTypeId) {
      const exact = await this.lookup(
        organizationId,
        ONNIX_ENTITY_TYPE_TICKET_TYPE,
        zentikTicketTypeId,
      );
      if (exact !== null) return exact;

      // Miss del nodo → probar la carpeta padre. Un solo salto (no se sube toda
      // la rama): más niveles sin mapping ya son el caso del default.
      const node = await this.prisma.ticketType.findUnique({
        where: { id: zentikTicketTypeId },
        select: { parentId: true },
      });
      if (node?.parentId) {
        const parent = await this.lookup(
          organizationId,
          ONNIX_ENTITY_TYPE_TICKET_TYPE,
          node.parentId,
        );
        if (parent !== null) return parent;
      }
    }
    return this.resolveCatalogId(
      organizationId,
      ONNIX_ENTITY_TYPE_TICKET_TYPE,
      category,
      tipos,
    );
  }

  /**
   * Siembra los mappings de tipo por SLUG contra la tabla confirmada de R1.4
   * (#50 R1.3). Idempotente: dos corridas dejan el mismo estado.
   *
   * - Scope = `ONNIX_SYNC_ORG_IDS`: la whitelist YA es el alcance de la
   *   integración y el endpoint no recibe input → nada que validar ni por donde
   *   inyectar.
   * - `slug` NO es único por org (el árbol puede repetirlo en ramas distintas):
   *   todos los nodos con el mismo slug reciben el mismo `onnixId`. Correcto por
   *   diseño — en OSD son el mismo tipo de incidencia.
   * - Desalineaciones (slug de Zentik sin par / slug de la tabla sin TicketType)
   *   se LOGGEAN y se devuelven, nunca tiran error: el seed debe poder correrse
   *   siempre, aunque el árbol de una org esté incompleto.
   */
  async seedTicketTypeMappings(): Promise<SeedTicketTypeMappingsOrgResult[]> {
    const results: SeedTicketTypeMappingsOrgResult[] = [];
    for (const organizationId of this.config.onnixSyncOrgIds) {
      results.push(await this.seedTicketTypeMappingsForOrg(organizationId));
    }
    return results;
  }

  private async seedTicketTypeMappingsForOrg(
    organizationId: string,
  ): Promise<SeedTicketTypeMappingsOrgResult> {
    const types = await this.prisma.ticketType.findMany({
      where: { organizationId },
      select: { id: true, slug: true },
    });

    const targets = types.filter(
      (t) => ONNIX_TICKET_TYPE_SLUG_MAP[t.slug] !== undefined,
    );
    const matchedSlugs = new Set(targets.map((t) => t.slug));
    const zentikSlugsWithoutPair = [
      ...new Set(types.filter((t) => !matchedSlugs.has(t.slug)).map((t) => t.slug)),
    ].sort();
    const tableSlugsWithoutTicketType = Object.keys(ONNIX_TICKET_TYPE_SLUG_MAP)
      .filter((slug) => !matchedSlugs.has(slug))
      .sort();

    // Estado previo en UNA query: permite contar created/updated/alreadyMapped
    // (el `upsert` de Prisma no dice cuál de las dos ramas tomó) y evitar
    // escrituras inútiles cuando el mapping ya está igual.
    const existing = targets.length
      ? await this.prisma.onnixEntityMapping.findMany({
          where: {
            organizationId,
            entityType: ONNIX_ENTITY_TYPE_TICKET_TYPE,
            zentikId: { in: targets.map((t) => t.id) },
          },
          select: { zentikId: true, onnixId: true },
        })
      : [];
    const previous = new Map(existing.map((e) => [e.zentikId, e.onnixId]));

    let created = 0;
    let updated = 0;
    let alreadyMapped = 0;

    for (const type of targets) {
      const onnixId = ONNIX_TICKET_TYPE_SLUG_MAP[type.slug];
      const prev = previous.get(type.id);
      if (prev === onnixId) {
        alreadyMapped++;
        continue; // 2ª corrida: no toca la fila (idempotencia real, no "escribir lo mismo").
      }
      if (prev === undefined) created++;
      else updated++;
      await this.prisma.onnixEntityMapping.upsert({
        where: {
          organizationId_entityType_zentikId: {
            organizationId,
            entityType: ONNIX_ENTITY_TYPE_TICKET_TYPE,
            zentikId: type.id,
          },
        },
        create: {
          organizationId,
          entityType: ONNIX_ENTITY_TYPE_TICKET_TYPE,
          zentikId: type.id,
          onnixId,
        },
        update: { onnixId },
      });
    }

    if (zentikSlugsWithoutPair.length > 0) {
      this.logger.warn(
        `Seed ticket_type org=${organizationId}: ${zentikSlugsWithoutPair.length} slug(s) de Zentik sin par en la tabla R1.4 ` +
          `(caen al default): ${zentikSlugsWithoutPair.join(', ')}`,
      );
    }
    if (tableSlugsWithoutTicketType.length > 0) {
      this.logger.warn(
        `Seed ticket_type org=${organizationId}: ${tableSlugsWithoutTicketType.length} slug(s) de la tabla R1.4 sin TicketType en esta org: ` +
          tableSlugsWithoutTicketType.join(', '),
      );
    }
    this.logger.log(
      `Seed ticket_type org=${organizationId} created=${created} updated=${updated} alreadyMapped=${alreadyMapped}`,
    );

    return {
      organizationId,
      created,
      updated,
      alreadyMapped,
      zentikSlugsWithoutPair,
      tableSlugsWithoutTicketType,
    };
  }

  /**
   * Siembra los mappings de usuario por EMAIL contra `GET /equipos/{id}/usuarios`
   * (#52 R1.2). Idempotente: dos corridas dejan el mismo estado.
   *
   * POR QUE EMAIL Y NO NOMBRE (decision cerrada 2): la verificacion del dueño
   * (R0.2) encontro que los nombres NO coinciden entre los dos sistemas ("Ada Luisa
   * Mereles Patiño" vs "Ada Mereles"), mientras que los 5 emails matchean exacto.
   * Matchear por nombre habria fallado en produccion. `User.email` es `@unique` en
   * Zentik, asi que el email es una clave real, no una heuristica.
   *
   * - Scope = `ONNIX_SYNC_ORG_IDS` y equipo = `ONNIX_SUPPORT_TEAM_ID`: el endpoint
   *   no recibe input → nada que validar ni por donde inyectar (molde de
   *   `seedTicketTypeMappings`).
   * - Solo usuarios INTERNOS (`clientId: null`) y miembros de la org: un usuario
   *   cliente jamas es responsable de un ticket en OSD, y mapearlo solo agregaria
   *   una forma de asignar mal.
   * - `is_active: false` en OSD NO se mapea: asignarle un ticket a alguien dado de
   *   baja es exactamente el 422 que este seed viene a evitar.
   * - Las desalineaciones se LOGGEAN CON NOMBRE Y EMAIL y se devuelven, nunca tiran
   *   error (R1.3). Eso es lo que va a delatar al proximo usuario que se sume a
   *   Zentik y que nadie de de alta en el equipo de OSD: sin esa lista, su primera
   *   asignacion se pierde en un warn del dispatcher que nadie esta mirando.
   */
  async seedUserMappings(): Promise<SeedUserMappingsOrgResult[]> {
    const traceId = randomUUID();
    // UNA sola llamada a OSD para todas las orgs: el equipo de soporte es el mismo
    // (ONNIX_SUPPORT_TEAM_ID es constante) y hoy la whitelist tiene una sola org.
    const members = await this.onnix.getTeamMembers(ONNIX_SUPPORT_TEAM_ID, traceId);
    const results: SeedUserMappingsOrgResult[] = [];
    for (const organizationId of this.config.onnixSyncOrgIds) {
      results.push(await this.seedUserMappingsForOrg(organizationId, members));
    }
    return results;
  }

  private async seedUserMappingsForOrg(
    organizationId: string,
    members: OnnixEquipoUsuario[],
  ): Promise<SeedUserMappingsOrgResult> {
    // `is_active === false` EXPLICITO (no `!m.is_active`): el campo es opcional en el
    // contrato, y un OSD que deje de mandarlo no puede dejar al equipo entero sin
    // mapear en silencio. Ausente = activo.
    const inactive = members.filter((m) => m.is_active === false);
    const inactiveSkipped = inactive
      .map((m) => this.describeMember(m))
      .sort();

    // Indice email normalizado → miembro activo. Si OSD repitiera un email (no
    // deberia), gana el PRIMERO y el resto queda como "sin par": es mas honesto que
    // pisar el mapeo en silencio con el ultimo que aparecio en la lista.
    const byEmail = new Map<string, OnnixEquipoUsuario>();
    for (const m of members) {
      if (m.is_active === false) continue;
      const key = normalizeEmail(m.email);
      if (key && !byEmail.has(key)) byEmail.set(key, m);
    }

    // Usuarios INTERNOS de la org: `clientId: null` es el mismo criterio que usa el
    // dispatcher para el prefijo de autor de #50 (`user.clientId` = usuario cliente).
    const users = await this.prisma.user.findMany({
      where: {
        clientId: null,
        organizationMembers: { some: { organizationId } },
      },
      select: { id: true, email: true, name: true },
    });

    const pairs: { user: (typeof users)[number]; onnixId: number }[] = [];
    const zentikUsersWithoutPair: string[] = [];
    const matchedOnnixIds = new Set<number>();
    for (const user of users) {
      const match = byEmail.get(normalizeEmail(user.email));
      if (!match) {
        zentikUsersWithoutPair.push(`${user.name} <${user.email}>`);
        continue;
      }
      pairs.push({ user, onnixId: match.id });
      matchedOnnixIds.add(match.id);
    }
    zentikUsersWithoutPair.sort();
    const onnixMembersWithoutPair = members
      .filter((m) => m.is_active !== false && !matchedOnnixIds.has(m.id))
      .map((m) => this.describeMember(m))
      .sort();

    // Estado previo en UNA query (molde de seedTicketTypeMappings): permite contar
    // created/updated/alreadyMapped —el `upsert` de Prisma no dice que rama tomo— y
    // evitar escrituras inutiles cuando el mapping ya esta igual.
    const existing = pairs.length
      ? await this.prisma.onnixEntityMapping.findMany({
          where: {
            organizationId,
            entityType: ONNIX_ENTITY_TYPE_USER,
            zentikId: { in: pairs.map((p) => p.user.id) },
          },
          select: { zentikId: true, onnixId: true },
        })
      : [];
    const previous = new Map(existing.map((e) => [e.zentikId, e.onnixId]));

    let created = 0;
    let updated = 0;
    let alreadyMapped = 0;

    for (const { user, onnixId } of pairs) {
      const prev = previous.get(user.id);
      if (prev === onnixId) {
        alreadyMapped++;
        continue; // 2ª corrida: no toca la fila (idempotencia real).
      }
      if (prev === undefined) created++;
      else updated++;
      await this.prisma.onnixEntityMapping.upsert({
        where: {
          organizationId_entityType_zentikId: {
            organizationId,
            entityType: ONNIX_ENTITY_TYPE_USER,
            zentikId: user.id,
          },
        },
        create: {
          organizationId,
          entityType: ONNIX_ENTITY_TYPE_USER,
          zentikId: user.id,
          onnixId,
        },
        update: { onnixId },
      });
    }

    // R1.3: los dos lados sin par van con NOMBRE Y EMAIL, no con un contador. Un
    // "3 usuarios sin par" no se puede accionar; "Fulano <f@onnix.com.py>" si.
    if (zentikUsersWithoutPair.length > 0) {
      this.logger.warn(
        `Seed user org=${organizationId}: ${zentikUsersWithoutPair.length} usuario(s) interno(s) de Zentik ` +
          `SIN par en el equipo ${ONNIX_SUPPORT_TEAM_ID} de OSD (sus asignaciones NO se van a reflejar): ` +
          zentikUsersWithoutPair.join(', '),
      );
    }
    if (onnixMembersWithoutPair.length > 0) {
      this.logger.warn(
        `Seed user org=${organizationId}: ${onnixMembersWithoutPair.length} miembro(s) del equipo ` +
          `${ONNIX_SUPPORT_TEAM_ID} de OSD sin usuario interno en esta org: ` +
          onnixMembersWithoutPair.join(', '),
      );
    }
    if (inactiveSkipped.length > 0) {
      this.logger.log(
        `Seed user org=${organizationId}: ${inactiveSkipped.length} miembro(s) inactivo(s) en OSD, no mapeados: ` +
          inactiveSkipped.join(', '),
      );
    }
    this.logger.log(
      `Seed user org=${organizationId} created=${created} updated=${updated} alreadyMapped=${alreadyMapped}`,
    );

    return {
      organizationId,
      created,
      updated,
      alreadyMapped,
      zentikUsersWithoutPair,
      onnixMembersWithoutPair,
      inactiveSkipped,
    };
  }

  /** Etiqueta legible de un miembro de OSD para el reporte de R1.3. */
  private describeMember(m: OnnixEquipoUsuario): string {
    return `${m.name ?? 'sin nombre'} <${m.email ?? 'sin email'}> (osdId=${m.id})`;
  }

  private async resolveCatalogId(
    organizationId: string,
    entityType: string,
    zentikValue: string,
    catalog: { id: number }[],
  ): Promise<number> {
    const mapped = await this.lookup(organizationId, entityType, zentikValue);
    if (mapped !== null) return mapped;
    if (catalog.length === 0) {
      throw new Error(`Catálogo Onnix '${entityType}' vacío; no se puede resolver id`);
    }
    this.logger.warn(
      `Sin mapeo ${entityType} para '${zentikValue}'; usando default catálogo[0]=${catalog[0].id} (refinar D-17)`,
    );
    return catalog[0].id;
  }

  /** Catálogos Onnix cacheados in-memory con TTL (R20). */
  private async getCatalogos(traceId: string): Promise<OnnixCatalogos> {
    if (this.catalogCache && this.catalogCache.expiresAt > Date.now()) {
      return this.catalogCache.value;
    }
    const value = await this.onnix.getCatalogos(traceId);
    this.catalogCache = {
      value,
      expiresAt: Date.now() + this.config.onnixCatalogCacheTtlSec * 1000,
    };
    return value;
  }
}
