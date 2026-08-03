import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TicketType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { CreateTicketTypeDto, UpdateTicketTypeDto } from './dto';

const PRISMA_UNIQUE_VIOLATION = 'P2002';
const MAX_SLUG_LENGTH = 60;

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
 * CRUD del catálogo de tipos de solicitud (feature #42 — Fase 1, lista plana).
 * Fase 3 los convierte en árbol (`parentId`/`path`/`level`).
 *
 * `(organizationId, slug)` es único → `TICKET_TYPE_DUPLICATE` (409).
 */
@Injectable()
export class TicketTypeService {
  private readonly logger = new Logger(TicketTypeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(orgId: string, includeInactive = false): Promise<TicketType[]> {
    return this.prisma.ticketType.findMany({
      where: { organizationId: orgId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { name: 'asc' },
    });
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

    const type = await this.runUnique(slug, () =>
      this.prisma.ticketType.create({ data: { organizationId: orgId, name, slug } }),
    );

    this.logger.log(`Tipo de solicitud creado: ${type.id} (${type.slug}) org=${orgId}`);
    return type;
  }

  async update(orgId: string, typeId: string, dto: UpdateTicketTypeDto): Promise<TicketType> {
    const existing = await this.getById(orgId, typeId);

    const name = dto.name?.trim();
    // El slug SOLO cambia si el request lo pide explícitamente: renombrar no debe
    // mover la clave estable del tipo (la UI y las integraciones la usan).
    const slug = dto.slug !== undefined ? this.resolveSlug(name ?? existing.name, dto.slug) : undefined;
    if (slug && slug !== existing.slug) {
      await this.assertSlugAvailable(orgId, slug);
    }

    return this.runUnique(slug ?? existing.slug, () =>
      this.prisma.ticketType.update({
        where: { id: typeId },
        data: {
          ...(name !== undefined && { name }),
          ...(slug !== undefined && { slug }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      }),
    );
  }

  /**
   * Baja lógica. No se bloquea por contratos: un contrato de un tipo inactivo
   * simplemente deja de matchear en el paso 1 de la cascada (el ticket cae al
   * paso siguiente), y los tickets históricos conservan su `ticketTypeId`.
   */
  async deactivate(orgId: string, typeId: string): Promise<TicketType> {
    await this.getById(orgId, typeId);
    this.logger.log(`Tipo de solicitud desactivado: ${typeId} org=${orgId}`);
    return this.prisma.ticketType.update({ where: { id: typeId }, data: { isActive: false } });
  }

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
