import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, TicketCriticality, TicketCriticalityConfig } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';
import { UpdateCriticalityConfigDto } from './dto';

/** Criticidad tal como la ve el cliente en el portal (nunca el nombre interno). */
export interface ClientVisibleCriticality {
  criticality: TicketCriticality;
  label: string;
  level: number;
}

/**
 * Config por defecto de cada criticidad. La usa el seed on-demand y el `upsert`
 * cuando la fila todavía no existe (PATCH sobre una org sin seed corrido).
 *
 * `level` mayor = más urgente (el portal ordena descendente). El default de la
 * organización es MEDIUM: es la criticidad que entra si el cliente no elige
 * (o si ninguna está `clientVisible` → modo 2B, sin deploy).
 */
export const CRITICALITY_DEFAULTS: Record<
  TicketCriticality,
  { displayName: string; level: number; isDefault: boolean }
> = {
  // #42 Fase 3: CRITICAL nace `clientVisible: false` (ver `seedClientVisible`) —
  // la criticidad mas alta NO se ofrece al cliente por defecto; se habilita a mano
  // si el negocio lo decide. Level 4 = la mas urgente.
  [TicketCriticality.CRITICAL]: { displayName: 'Crítica', level: 4, isDefault: false },
  [TicketCriticality.HIGH]: { displayName: 'Alta', level: 3, isDefault: false },
  [TicketCriticality.MEDIUM]: { displayName: 'Media', level: 2, isDefault: true },
  [TicketCriticality.LOW]: { displayName: 'Baja', level: 1, isDefault: false },
};

/**
 * Criticidades que NO se ofrecen al cliente al crear la fila por defecto.
 * `CRITICAL` es decision de producto (#42 Fase 3): dejar que el cliente se
 * autoasigne la maxima urgencia seria un agujero cuando falta el contrato.
 */
export const CRITICALITY_HIDDEN_BY_DEFAULT: TicketCriticality[] = [TicketCriticality.CRITICAL];

/**
 * Criticidad que entra si la organización no configuró ninguna como default.
 * Coincide con el default del `SlaConfig` histórico → sin cambio de comportamiento.
 */
export const FALLBACK_CRITICALITY = TicketCriticality.MEDIUM;

const CRITICALITY_VALUES = Object.values(TicketCriticality);

/**
 * Valida un valor suelto (path param / query / DTO) contra el enum de Prisma.
 * Devuelve `null` para vacío/ausente; lanza si el valor vino pero no existe.
 *
 * Los path params NO pasan por el `ValidationPipe` global (no tienen metatype),
 * así que esta es la única defensa del `PATCH .../criticality-configs/:criticality`.
 */
export function parseCriticality(value?: string | null): TicketCriticality | null {
  if (value === undefined || value === null || value === '') return null;
  const match = CRITICALITY_VALUES.find((c) => c === value);
  if (!match) {
    throw new AppException(
      `Criticidad inválida: "${value}". Valores admitidos: ${CRITICALITY_VALUES.join(', ')}`,
      'CRITICALITY_INVALID',
      400,
    );
  }
  return match;
}

/** Igual que `parseCriticality`, pero para donde el valor es obligatorio (path param). */
export function requireCriticality(value?: string | null): TicketCriticality {
  const parsed = parseCriticality(value);
  if (!parsed) {
    throw new AppException('La criticidad es obligatoria', 'CRITICALITY_INVALID', 400);
  }
  return parsed;
}

/**
 * Presentación y visibilidad de las criticidades POR ORGANIZACIÓN
 * (feature #42 — Fase 2).
 *
 * NO crea una identidad nueva: el enum `TicketCriticality` sigue siendo la fuente.
 * Esta tabla solo decide **qué ve el cliente, con qué etiqueta y en qué orden**, y
 * cuál entra por defecto. Por eso pasar del modo 2A (el cliente elige) al 2B (no
 * elige) es desmarcar `clientVisible` — cero migración, cero deploy.
 *
 * Todo scopeado por `organizationId`.
 */
@Injectable()
export class CriticalityConfigService {
  private readonly logger = new Logger(CriticalityConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Config completa de la org (incluye las no visibles): es la vista del admin. */
  async list(orgId: string): Promise<TicketCriticalityConfig[]> {
    return this.prisma.ticketCriticalityConfig.findMany({
      where: { organizationId: orgId },
      orderBy: { level: 'desc' },
    });
  }

  /**
   * Crea o edita la config de UNA criticidad.
   *
   * `isDefault` es EXCLUYENTE: marcar una desmarca las demás **en la misma
   * `$transaction`**. Si no fuera atómico, un fallo entre ambas escrituras dejaría
   * la org con dos defaults y `getDefault()` elegiría cualquiera de las dos.
   */
  async upsert(
    orgId: string,
    criticality: TicketCriticality,
    dto: UpdateCriticalityConfigDto,
    userId: string,
  ): Promise<TicketCriticalityConfig> {
    const defaults = CRITICALITY_DEFAULTS[criticality];

    const update: Prisma.TicketCriticalityConfigUpdateInput = {
      ...(dto.displayName !== undefined && { displayName: dto.displayName.trim() }),
      // `?? null` para que un `clientLabel: null` explícito limpie la etiqueta.
      ...(dto.clientLabel !== undefined && { clientLabel: dto.clientLabel ?? null }),
      ...(dto.clientVisible !== undefined && { clientVisible: dto.clientVisible }),
      ...(dto.level !== undefined && { level: dto.level }),
      ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
    };

    const config = await this.prisma.$transaction(async (tx) => {
      const row = await tx.ticketCriticalityConfig.upsert({
        where: { organizationId_criticality: { organizationId: orgId, criticality } },
        create: {
          organizationId: orgId,
          criticality,
          displayName: dto.displayName?.trim() || defaults.displayName,
          clientLabel: dto.clientLabel ?? null,
          clientVisible: dto.clientVisible ?? true,
          level: dto.level ?? defaults.level,
          isDefault: dto.isDefault ?? false,
        },
        update,
      });

      if (dto.isDefault === true) {
        await tx.ticketCriticalityConfig.updateMany({
          where: { organizationId: orgId, criticality: { not: criticality }, isDefault: true },
          data: { isDefault: false },
        });
      }

      // Evento dentro de la transacción (checklist del blueprint).
      this.eventEmitter.emit('criticality.config.updated', {
        ...domainEvent('criticality.config.updated', 'organization', orgId, orgId, userId),
        organizationId: orgId,
        criticality,
        changes: update,
        userId,
      });

      return row;
    });

    this.logger.log(
      `Config de criticidad ${criticality} actualizada org=${orgId} ` +
        `(visible=${config.clientVisible} default=${config.isDefault})`,
    );
    return config;
  }

  /**
   * Criticidades que el cliente PUEDE elegir, de más a menos urgente.
   *
   * Devolver `[]` es un estado válido y esperado: significa "el cliente no elige"
   * (modo 2B) y el front no renderiza el selector. También es lo que pasa en una
   * org sin seed corrido.
   */
  async getClientVisible(orgId: string): Promise<ClientVisibleCriticality[]> {
    const rows = await this.prisma.ticketCriticalityConfig.findMany({
      where: { organizationId: orgId, clientVisible: true },
      orderBy: { level: 'desc' },
      select: { criticality: true, displayName: true, clientLabel: true, level: true },
    });

    return rows.map((row) => ({
      criticality: row.criticality,
      label: row.clientLabel ?? row.displayName,
      level: row.level,
    }));
  }

  /**
   * Criticidad que entra cuando el cliente no elige. Si la org todavía no
   * configuró ninguna como default cae a MEDIUM (mismo valor que el default del
   * modelo `Ticket`), así ningún ticket queda sin criticidad.
   */
  async getDefault(orgId: string): Promise<TicketCriticality> {
    const row = await this.prisma.ticketCriticalityConfig.findFirst({
      where: { organizationId: orgId, isDefault: true },
      select: { criticality: true },
    });
    return row?.criticality ?? FALLBACK_CRITICALITY;
  }
}
