import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TicketType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { CreateTicketTypeDto, UpdateTicketTypeDto } from './dto';

const PRISMA_UNIQUE_VIOLATION = 'P2002';
const MAX_SLUG_LENGTH = 60;

/**
 * Tope de profundidad del árbol: 3 niveles (`level` 0, 1 y 2).
 *
 * Guardarraíl deliberado: OSD deja el árbol libre, pero un árbol sin tope es una
 * trampa de UI (no hay selector ni breadcrumb que aguante 8 niveles) y convierte
 * cualquier recálculo de rama en un recorrido impredecible.
 */
export const MAX_TICKET_TYPE_DEPTH = 3;
const MAX_TICKET_TYPE_LEVEL = MAX_TICKET_TYPE_DEPTH - 1;
const PATH_SEPARATOR = '/';

/** Nodo del árbol: el tipo + su rama anidada (`children` vacío = hoja). */
export interface TicketTypeNode extends TicketType {
  children: TicketTypeNode[];
}

/** Proyección mínima para trepar por los ancestros (validación de ciclos). */
type TicketTypeAncestor = { id: string; parentId: string | null };

/**
 * Normaliza un nombre a slug: sin tildes, minúsculas, guiones.
 * "Incidencia Crítica" → "incidencia-critica".
 *
 * Se exporta para que el seed reutilice EXACTAMENTE la misma normalización (si
 * divergieran, el seed dejaría de ser idempotente contra los tipos ya creados
 * desde la UI).
 */
export function slugifyTicketTypeName(name: string): string {
  return name
    .normalize('NFD')
    // \u0300-\u036f = bloque de diacríticos combinantes que NFD dejó sueltos
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // el slice puede dejar un guión colgando
}

/**
 * CRUD del catálogo de tipos de solicitud (feature #42 — Fase 1 lista plana,
 * Fase 3 ÁRBOL: `parentId` / `path` / `level`).
 *
 * `(organizationId, slug)` es único → `TICKET_TYPE_DUPLICATE` (409).
 *
 * ── Invariantes del árbol (no se negocian) ────────────────────────────────────
 * 1. `path` y `level` son DERIVADOS: los calcula este service al crear/mover/
 *    renombrar. NUNCA llegan del cliente (ni siquiera están en los DTOs).
 *    `path` = slugs desde la raíz unidos por "/" (`incidencia/error-del-sistema`);
 *    `level` = profundidad, 0 = raíz.
 * 2. Máximo `MAX_TICKET_TYPE_DEPTH` niveles → `TICKET_TYPE_MAX_DEPTH` (400).
 * 3. Sin ciclos: ni padre de sí mismo ni de un descendiente → `TICKET_TYPE_CYCLE` (400).
 * 4. El padre tiene que ser de la MISMA organización → `TICKET_TYPE_NOT_FOUND` (404).
 * 5. Nunca queda un hijo activo colgando de un padre inactivo: desactivar un padre
 *    apaga la rama entera, y reactivar un hijo con el padre apagado se rechaza con
 *    `TICKET_TYPE_PARENT_INACTIVE` (400).
 *
 * ⚠️ CONTRATOS: **match EXACTO por tipo**. Un contrato sobre el PADRE no cubre a los
 * hijos — la cascada de SLA (`SlaResolverService`, paso 1) y la disponibilidad del
 * portal (`TicketTypeAvailabilityService`) buscan el `ticketTypeId` tal cual, sin
 * trepar por los ancestros. Es la misma regla que OSD y es DELIBERADA: heredar
 * contratos haría que agregar un hijo cambie en silencio el SLA de tickets que ya
 * estaban cubiertos por otra vía. Si algún día se quiere herencia, es un feature
 * nuevo con su propia migración de datos, no un `if` acá.
 */
@Injectable()
export class TicketTypeService {
  private readonly logger = new Logger(TicketTypeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Catálogo PLANO, ordenado por `path`: cada padre queda inmediatamente antes de
   * su rama, así la lista ya sale en orden de árbol sin post-procesar.
   */
  async list(orgId: string, includeInactive = false): Promise<TicketType[]> {
    return this.prisma.ticketType.findMany({
      where: { organizationId: orgId, ...(includeInactive ? {} : { isActive: true }) },
      // `name` es solo desempate determinista (filas legacy que todavía no tengan path).
      orderBy: [{ path: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Jerarquía anidada lista para pintar.
   *
   * UNA sola query (la de `list`) + armado en memoria: NO hay N+1 ni recursión
   * contra la DB. El catálogo de tipos de una organización son decenas de filas,
   * traerlo entero sale más barato que una query por nivel.
   */
  async getTree(orgId: string, includeInactive = false): Promise<TicketTypeNode[]> {
    const types = await this.list(orgId, includeInactive);
    return this.toTree(types);
  }

  async getById(orgId: string, typeId: string): Promise<TicketType> {
    const type = await this.prisma.ticketType.findFirst({
      where: { id: typeId, organizationId: orgId },
    });
    if (!type) {
      throw new AppException('Tipo de solicitud no encontrado', 'TICKET_TYPE_NOT_FOUND', 404);
    }
    return type;
  }

  async create(orgId: string, dto: CreateTicketTypeDto): Promise<TicketType> {
    const name = dto.name.trim();
    const slug = this.resolveSlug(name, dto.slug);
    await this.assertSlugAvailable(orgId, slug);

    const parent = await this.resolveParent(orgId, dto.parentId ?? null);
    const level = parent ? parent.level + 1 : 0;
    this.assertDepth(level);

    const type = await this.runUnique(slug, () =>
      this.prisma.ticketType.create({
        data: {
          organizationId: orgId,
          name,
          slug,
          parentId: parent?.id ?? null,
          path: this.buildPath(parent?.path ?? '', slug),
          level,
          // #48 R1: ausente = el default de la columna (`true`). Un tipo nuevo
          // nace visible.
          ...(dto.clientVisible !== undefined && { clientVisible: dto.clientVisible }),
        },
      }),
    );

    this.logger.log(
      `Tipo de solicitud creado: ${type.id} (${type.path}) level=${type.level} org=${orgId}`,
    );
    return type;
  }

  /**
   * Editar un tipo. Tres cambios pueden tocar la rama entera:
   * - **renombrar el slug** → cambia el `path` propio y el prefijo de todos los hijos;
   * - **mover** (`parentId`) → cambia `path` Y `level` de toda la rama;
   * - **desactivar** (`isActive: false`) → apaga la rama (misma regla que `deactivate`,
   *   acá también, si no el `PATCH` sería un desvío para dejar hijos huérfanos activos).
   *
   * Todo lo que toca más de una fila va en la misma `$transaction`: un árbol a
   * medio recalcular es peor que un error.
   */
  async update(orgId: string, typeId: string, dto: UpdateTicketTypeDto): Promise<TicketType> {
    const existing = await this.getById(orgId, typeId);

    const name = dto.name?.trim();
    // El slug SOLO cambia si el request lo pide explícitamente: renombrar no debe
    // mover la clave estable del tipo (la UI y las integraciones la usan).
    const slug = dto.slug !== undefined ? this.resolveSlug(name ?? existing.name, dto.slug) : undefined;
    if (slug && slug !== existing.slug) {
      await this.assertSlugAvailable(orgId, slug);
    }

    // `parentId` ausente = NO se mueve; `null` explícito = se mueve a raíz.
    const moves = dto.parentId !== undefined && (dto.parentId ?? null) !== existing.parentId;
    const parent = moves ? await this.resolveParent(orgId, dto.parentId ?? null) : null;
    if (parent) {
      await this.assertNoCycle(orgId, existing.id, parent);
    }

    // Reactivar: el padre tiene que estar vivo (invariante 5). Si el tipo se mueve,
    // `resolveParent` ya validó que el padre NUEVO está activo.
    if (dto.isActive === true && !moves && existing.parentId) {
      await this.resolveParent(orgId, existing.parentId);
    }

    const renames = slug !== undefined && slug !== existing.slug;
    const rebuilds = moves || renames;
    // Los descendientes se traen UNA vez y solo si hace falta recalcular la rama.
    const descendants = rebuilds ? await this.findDescendants(orgId, existing) : [];

    const nextSlug = slug ?? existing.slug;
    const nextLevel = moves ? (parent ? parent.level + 1 : 0) : existing.level;
    const nextPath = this.buildPath(
      moves ? (parent?.path ?? '') : this.parentPathOf(existing),
      nextSlug,
    );

    if (moves) {
      // La profundidad se valida sobre la RAMA COMPLETA, no sobre el nodo: mover un
      // subárbol de 2 niveles bajo un padre de nivel 1 excede el tope aunque el nodo
      // movido, solo, entre.
      const deepest = descendants.reduce((max, node) => Math.max(max, node.level), existing.level);
      this.assertDepth(deepest + (nextLevel - existing.level));
    }

    const updated = await this.runUnique(nextSlug, () =>
      this.prisma.$transaction(async (tx) => {
        const node = await tx.ticketType.update({
          where: { id: typeId },
          data: {
            ...(name !== undefined && { name }),
            ...(slug !== undefined && { slug }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
            // #48 R6.3: el ojito es PRESENTACIÓN. No cascadea a la rama (a
            // diferencia de `isActive`) ni toca contratos: cada nodo tiene el suyo
            // y un padre oculto con contrato sigue resolviendo.
            ...(dto.clientVisible !== undefined && { clientVisible: dto.clientVisible }),
            ...(moves && { parentId: parent?.id ?? null, level: nextLevel }),
            ...(rebuilds && { path: nextPath }),
          },
        });

        if (rebuilds) {
          // `existing.path`/`existing.level` se pasan como primitivos capturados ANTES
          // del update: el recálculo necesita el prefijo VIEJO para recortar el sufijo
          // relativo de cada descendiente.
          await this.rebuildBranch(tx, {
            previousPath: existing.path,
            previousLevel: existing.level,
            descendants,
            nextPath,
            nextLevel,
          });
        }
        // Se apaga DESPUÉS del recálculo: así el prefijo de path que usa la cascada
        // es el nuevo, no el viejo.
        if (dto.isActive === false) {
          await this.deactivateDescendants(tx, orgId, node.path);
        }
        return node;
      }),
    );

    if (rebuilds) {
      this.logger.log(
        `Tipo de solicitud ${typeId} recalculado a "${nextPath}" level=${nextLevel} ` +
          `(${descendants.length} descendiente(s)) org=${orgId}`,
      );
    }
    return updated;
  }

  /**
   * Baja lógica EN CASCADA: apaga el tipo y toda su rama en una `$transaction`.
   *
   * No se bloquea por contratos: un contrato de un tipo inactivo simplemente deja de
   * matchear en el paso 1 de la cascada (el ticket cae al paso siguiente), y los
   * tickets históricos conservan su `ticketTypeId`.
   *
   * @returns `deactivated` = cuántos tipos se apagaron **incluido el propio** (la UI
   *   lo informa: "se desactivaron 4 tipos"). Los que ya estaban inactivos no se
   *   cuentan, así que repetir la baja devuelve 0 (idempotente).
   */
  async deactivate(orgId: string, typeId: string): Promise<{ deactivated: number }> {
    const type = await this.getById(orgId, typeId);

    const deactivated = await this.prisma.$transaction(async (tx) => {
      const self = await tx.ticketType.updateMany({
        where: { id: type.id, organizationId: orgId, isActive: true },
        data: { isActive: false },
      });
      const branch = await this.deactivateDescendants(tx, orgId, type.path);
      return self.count + branch;
    });

    this.logger.log(
      `Tipo de solicitud desactivado: ${typeId} org=${orgId} (rama: ${deactivated} tipo(s))`,
    );
    return { deactivated };
  }

  // ── Árbol: helpers privados ──────────────────────────────────────────────

  /**
   * Valida el padre propuesto. `null` = raíz (no valida nada).
   *
   * El scoping por organización es lo que impide colgar un tipo del árbol de OTRA
   * org: un `parentId` ajeno responde 404 (no 403 — no se confirma que exista).
   */
  private async resolveParent(orgId: string, parentId: string | null): Promise<TicketType | null> {
    if (!parentId) {
      return null;
    }
    const parent = await this.prisma.ticketType.findFirst({
      where: { id: parentId, organizationId: orgId },
    });
    if (!parent) {
      throw new AppException(
        'El tipo de solicitud padre no existe en la organización',
        'TICKET_TYPE_NOT_FOUND',
        404,
      );
    }
    if (!parent.isActive) {
      throw new AppException(
        `El tipo padre "${parent.name}" está inactivo: no puede tener hijos activos`,
        'TICKET_TYPE_PARENT_INACTIVE',
        400,
      );
    }
    return parent;
  }

  private assertDepth(level: number): void {
    if (level > MAX_TICKET_TYPE_LEVEL) {
      throw new AppException(
        `El árbol de tipos de solicitud admite como máximo ${MAX_TICKET_TYPE_DEPTH} niveles`,
        'TICKET_TYPE_MAX_DEPTH',
        400,
      );
    }
  }

  /**
   * Rechaza los ciclos trepando por los ancestros del padre PROPUESTO: si en el
   * camino a la raíz aparece el propio nodo, el padre es él mismo o un descendiente
   * suyo (y el árbol quedaría desconectado, girando en redondo).
   *
   * Se trepa por `parentId` en vez de mirar el `path` a propósito: el `path` es un
   * derivado y esta validación es justamente la que lo protege.
   */
  private async assertNoCycle(orgId: string, nodeId: string, parent: TicketType): Promise<void> {
    let current: TicketTypeAncestor | null = { id: parent.id, parentId: parent.parentId };
    let hops = 0;

    while (current) {
      if (current.id === nodeId) {
        throw new AppException(
          'Un tipo de solicitud no puede depender de sí mismo ni de uno de sus descendientes',
          'TICKET_TYPE_CYCLE',
          400,
        );
      }
      if (!current.parentId) {
        return;
      }
      // Una cadena más larga que el tope es imposible con datos sanos: si pasa, hay
      // un ciclo ya persistido. Se corta acá (nunca un loop infinito).
      if (++hops > MAX_TICKET_TYPE_DEPTH) {
        throw new AppException(
          'La jerarquía de tipos de solicitud tiene un ciclo',
          'TICKET_TYPE_CYCLE',
          400,
        );
      }
      current = await this.prisma.ticketType.findFirst({
        where: { id: current.parentId, organizationId: orgId },
        select: { id: true, parentId: true },
      });
    }
  }

  /**
   * Rama completa de un nodo (todos sus niveles) con UNA sola query, por prefijo de
   * `path` — para eso se persiste `path`.
   *
   * El separador en el prefijo (`incidencia/`) evita el falso positivo del hermano
   * `incidencia-critica`. Los slugs son `[a-z0-9-]+` (regex del DTO + `slugify`), así
   * que no pueden colar comodines de LIKE (`%`, `_`) en el prefijo.
   */
  private async findDescendants(orgId: string, node: TicketType): Promise<TicketType[]> {
    return this.prisma.ticketType.findMany({
      where: {
        organizationId: orgId,
        path: { startsWith: `${node.path}${PATH_SEPARATOR}` },
      },
      orderBy: { level: 'asc' },
    });
  }

  /**
   * Reescribe `path`/`level` de los descendientes tras mover o renombrar el nodo.
   *
   * Fila por fila porque cada una lleva un `path` distinto (`updateMany` escribe el
   * mismo valor en todas). Va dentro de la `$transaction` del llamador.
   */
  private async rebuildBranch(
    tx: Prisma.TransactionClient,
    branch: {
      previousPath: string;
      previousLevel: number;
      descendants: TicketType[];
      nextPath: string;
      nextLevel: number;
    },
  ): Promise<void> {
    const { previousPath, previousLevel, descendants, nextPath, nextLevel } = branch;
    const levelShift = nextLevel - previousLevel;

    for (const descendant of descendants) {
      await tx.ticketType.update({
        where: { id: descendant.id },
        data: {
          // El sufijo relativo del descendiente no cambia: solo se reemplaza el prefijo.
          path: `${nextPath}${descendant.path.slice(previousPath.length)}`,
          level: descendant.level + levelShift,
        },
      });
    }
  }

  /** Apaga los descendientes VIVOS de `path`. Devuelve cuántos se apagaron. */
  private async deactivateDescendants(
    tx: Prisma.TransactionClient,
    orgId: string,
    path: string,
  ): Promise<number> {
    const { count } = await tx.ticketType.updateMany({
      where: {
        organizationId: orgId,
        isActive: true,
        path: { startsWith: `${path}${PATH_SEPARATOR}` },
      },
      data: { isActive: false },
    });
    return count;
  }

  /**
   * Arma la jerarquía en memoria a partir de la lista plana (ya ordenada por `path`,
   * así que los hijos entran en orden natural).
   *
   * Un nodo cuyo padre NO está en el conjunto (raíz real, o hijo cuyo padre quedó
   * filtrado por inactivo) sube a raíz: el árbol nunca se come un tipo.
   */
  private toTree(types: TicketType[]): TicketTypeNode[] {
    const byId = new Map<string, TicketTypeNode>(
      types.map((type): [string, TicketTypeNode] => [type.id, { ...type, children: [] }]),
    );
    const roots: TicketTypeNode[] = [];

    for (const type of types) {
      const node = byId.get(type.id);
      if (!node) {
        continue; // inalcanzable: el mapa se sembró con estos mismos ids
      }
      const parent = type.parentId ? byId.get(type.parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  private buildPath(parentPath: string, slug: string): string {
    return parentPath ? `${parentPath}${PATH_SEPARATOR}${slug}` : slug;
  }

  /** Prefijo del `path` sin el último segmento (`a/b/c` → `a/b`; raíz → ''). */
  private parentPathOf(node: TicketType): string {
    const lastSeparator = node.path.lastIndexOf(PATH_SEPARATOR);
    return lastSeparator === -1 ? '' : node.path.slice(0, lastSeparator);
  }

  // ── Slug ─────────────────────────────────────────────────────────────────

  private resolveSlug(name: string, providedSlug?: string): string {
    const slug = providedSlug ? slugifyTicketTypeName(providedSlug) : slugifyTicketTypeName(name);
    if (!slug) {
      throw new AppException(
        'El nombre del tipo no genera un identificador válido (usá letras o números)',
        'TICKET_TYPE_INVALID_NAME',
        422,
      );
    }
    return slug;
  }

  private async assertSlugAvailable(orgId: string, slug: string): Promise<void> {
    const duplicate = await this.prisma.ticketType.findFirst({
      where: { organizationId: orgId, slug },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppException(
        `Ya existe un tipo de solicitud con el identificador "${slug}" en la organización`,
        'TICKET_TYPE_DUPLICATE',
        409,
      );
    }
  }

  /** El pre-chequeo no es atómico: la unique de la DB es la autoridad final. */
  private async runUnique<T>(slug: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new AppException(
          `Ya existe un tipo de solicitud con el identificador "${slug}" en la organización`,
          'TICKET_TYPE_DUPLICATE',
          409,
        );
      }
      throw error;
    }
  }
}
