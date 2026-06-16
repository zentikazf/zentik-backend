import { Injectable, Logger } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OnnixClientService } from './onnix-client.service';
import { OnnixCatalogos } from './types/onnix.types';

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
  async resolveClientId(zentikClientId: string): Promise<number | null> {
    return this.lookup('client', zentikClientId);
  }

  /** project_id de Onnix; null si no hay mapeo (best-effort, R18). */
  async resolveProjectId(
    zentikProjectId: string | null | undefined,
  ): Promise<number | null> {
    if (!zentikProjectId) return null;
    return this.lookup('project', zentikProjectId);
  }

  private async lookup(entityType: string, zentikId: string): Promise<number | null> {
    const row = await this.prisma.onnixEntityMapping.findUnique({
      where: { entityType_zentikId: { entityType, zentikId } },
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
   */
  async resolveCatalogIds(
    category: string,
    priority: string,
    traceId: string,
  ): Promise<{
    ticketTypeId: number;
    ticketCategoryId: number;
    ticketPriorityId: number;
  }> {
    const c = await this.getCatalogos(traceId);
    return {
      ticketTypeId: await this.resolveCatalogId('ticket_type', category, c.tipos),
      ticketCategoryId: await this.resolveCatalogId('ticket_category', category, c.categorias),
      ticketPriorityId: await this.resolveCatalogId('ticket_priority', priority, c.prioridades),
    };
  }

  private async resolveCatalogId(
    entityType: string,
    zentikValue: string,
    catalog: { id: number }[],
  ): Promise<number> {
    const mapped = await this.lookup(entityType, zentikValue);
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
