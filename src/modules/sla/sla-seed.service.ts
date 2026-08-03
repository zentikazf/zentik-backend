import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, TicketCriticality } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { domainEvent } from '../../common/events/domain-event.helper';
import { CRITICALITY_DEFAULTS } from './criticality-config.service';
import { slugifyTicketTypeName } from './ticket-type.service';
import {
  SlaReadiness,
  SlaSeedResult,
  STANDARD_POLICY_CANONICAL_NAME,
  STANDARD_POLICY_NAMES,
} from './types/sla-resolution.types';

/**
 * Nombre de la política que representa cada criticidad al importar la config actual.
 *
 * MEDIUM → "Estándar" a propósito: así el `SlaConfig` de la criticidad media se
 * convierte en la política de fallback global (paso 5 de la cascada) sin inventar
 * tiempos, y el guardarraíl del feature flag queda satisfecho con un solo import.
 */
const POLICY_NAME_BY_CRITICALITY: Record<TicketCriticality, string> = {
  [TicketCriticality.HIGH]: 'Crítico',
  [TicketCriticality.MEDIUM]: STANDARD_POLICY_CANONICAL_NAME,
  [TicketCriticality.LOW]: 'Bajo',
};

/** Fallback de la "Estándar" cuando la org no tiene `SlaConfig` de MEDIUM. */
const DEFAULT_STANDARD_FIRST_RESPONSE_HOURS = 4;
const DEFAULT_STANDARD_RESOLUTION_HOURS = 24;

/** minutos → horas hacia arriba, con piso 1 (una política de 0h vencería al instante). */
function minutesToHours(minutes: number): number {
  return Math.max(1, Math.ceil(minutes / 60));
}

/**
 * Seed on-demand ("Importar configuración actual") + readiness del feature flag.
 *
 * Es **idempotente y NO destructivo**: solo CREA lo que falta (política por nombre,
 * tipo por slug) y nunca borra ni modifica lo existente. Correrlo dos veces deja el
 * mismo estado y reporta todo como `alreadyExisting`.
 */
@Injectable()
export class SlaSeedService {
  private readonly logger = new Logger(SlaSeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async importCurrentConfig(orgId: string, userId: string): Promise<SlaSeedResult> {
    const [slaConfigs, categories, existingPolicies, existingTypes, existingCriticalities] =
      await Promise.all([
        this.prisma.slaConfig.findMany({ where: { organizationId: orgId } }),
        this.prisma.ticketCategoryConfig.findMany({
          where: { organizationId: orgId, isActive: true },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.slaPolicy.findMany({
          where: { organizationId: orgId },
          select: { name: true },
        }),
        this.prisma.ticketType.findMany({
          where: { organizationId: orgId },
          select: { slug: true },
        }),
        this.prisma.ticketCriticalityConfig.findMany({
          where: { organizationId: orgId },
          select: { criticality: true },
        }),
      ]);

    // Los sets crecen a medida que se encolan filas: sirven de dedupe DENTRO de la
    // misma corrida (dos categorías que normalizan al mismo slug, por ejemplo).
    const existingNames = new Set(existingPolicies.map((p) => p.name));
    const existingSlugs = new Set(existingTypes.map((t) => t.slug));
    let alreadyExisting = 0;

    /** ¿Ya hay una política de fallback global (con o sin tilde)? */
    const standardExists = () => STANDARD_POLICY_NAMES.some((name) => existingNames.has(name));

    const policiesToCreate: Prisma.SlaPolicyCreateManyInput[] = [];
    for (const config of slaConfigs) {
      const name = POLICY_NAME_BY_CRITICALITY[config.criticality];
      // El nombre de MEDIUM ES la "Estándar": si la org ya tiene una variante
      // ("Estandar" sin tilde, tipeada a mano), NO se crea una gemela — dos políticas
      // de fallback dejarían el paso 5 de la cascada ambiguo.
      const isStandardName = STANDARD_POLICY_NAMES.includes(name);
      if (existingNames.has(name) || (isStandardName && standardExists())) {
        alreadyExisting++;
        continue;
      }
      existingNames.add(name);
      policiesToCreate.push({
        organizationId: orgId,
        name,
        criticality: config.criticality,
        firstResponseHours: minutesToHours(config.responseTimeMinutes),
        resolutionHours: minutesToHours(config.resolutionTimeMinutes),
      });
    }

    // Garantía de la política "Estándar" (guardarraíl del feature flag). Si ya
    // existe en la DB o quedó encolada arriba (MEDIUM), no se duplica.
    if (!standardExists()) {
      const medium = slaConfigs.find((c) => c.criticality === TicketCriticality.MEDIUM);
      existingNames.add(STANDARD_POLICY_CANONICAL_NAME);
      policiesToCreate.push({
        organizationId: orgId,
        name: STANDARD_POLICY_CANONICAL_NAME,
        criticality: TicketCriticality.MEDIUM,
        firstResponseHours: medium
          ? minutesToHours(medium.responseTimeMinutes)
          : DEFAULT_STANDARD_FIRST_RESPONSE_HOURS,
        resolutionHours: medium
          ? minutesToHours(medium.resolutionTimeMinutes)
          : DEFAULT_STANDARD_RESOLUTION_HOURS,
      });
    }

    const typesToCreate: Prisma.TicketTypeCreateManyInput[] = [];
    for (const category of categories) {
      const name = category.name.trim();
      const slug = slugifyTicketTypeName(name);
      if (!slug || existingSlugs.has(slug)) {
        alreadyExisting++;
        continue;
      }
      existingSlugs.add(slug);
      typesToCreate.push({ organizationId: orgId, name, slug });
    }

    // ── Config de criticidades (Fase 2) ──────────────────────────────────────
    // Solo se siembra si la org NO tiene NINGUNA fila: una vez que el admin las
    // editó, el seed no vuelve a opinar (idempotente y no destructivo, igual que
    // políticas y tipos). Sin estas filas el portal no muestra el selector de
    // criticidad (modo 2B) y entra el default MEDIUM.
    const criticalityConfigsToCreate: Prisma.TicketCriticalityConfigCreateManyInput[] =
      existingCriticalities.length > 0
        ? []
        : Object.entries(CRITICALITY_DEFAULTS).map(([criticality, config]) => ({
            organizationId: orgId,
            criticality: criticality as TicketCriticality,
            displayName: config.displayName,
            clientVisible: true,
            level: config.level,
            isDefault: config.isDefault,
          }));
    const alreadyExistingCriticalities = existingCriticalities.length;

    await this.prisma.$transaction(async (tx) => {
      if (criticalityConfigsToCreate.length > 0) {
        await tx.ticketCriticalityConfig.createMany({
          data: criticalityConfigsToCreate,
          skipDuplicates: true,
        });
      }
      if (policiesToCreate.length > 0) {
        // `skipDuplicates`: red contra dos imports simultáneos (la unique de la DB
        // manda; sin esto el segundo request rompería con P2002).
        await tx.slaPolicy.createMany({ data: policiesToCreate, skipDuplicates: true });
      }
      if (typesToCreate.length > 0) {
        await tx.ticketType.createMany({ data: typesToCreate, skipDuplicates: true });
      }

      // Evento dentro de la transacción (checklist del blueprint).
      this.eventEmitter.emit('sla.config.imported', {
        ...domainEvent('sla.config.imported', 'organization', orgId, orgId, userId),
        organizationId: orgId,
        policiesCreated: policiesToCreate.length,
        typesCreated: typesToCreate.length,
        criticalityConfigsCreated: criticalityConfigsToCreate.length,
        userId,
      });
    });

    this.logger.log(
      `Import de configuración SLA org=${orgId}: ${policiesToCreate.length} política(s), ` +
        `${typesToCreate.length} tipo(s), ${criticalityConfigsToCreate.length} criticidad(es), ` +
        `${alreadyExisting + alreadyExistingCriticalities} ya existían`,
    );

    return {
      policiesCreated: policiesToCreate.length,
      typesCreated: typesToCreate.length,
      criticalityConfigsCreated: criticalityConfigsToCreate.length,
      alreadyExisting: alreadyExisting + alreadyExistingCriticalities,
    };
  }

  /**
   * ¿Se puede activar `SLA_CASCADE_ENABLED` en esta organización?
   *
   * ⚠️ `canEnable=false` sin política "Estándar": activar el flag en ese estado deja
   * SIN SLA (deadlines null) a todo ticket cuya criticidad tampoco tenga política
   * propia — la cascada terminaría en `NONE`.
   */
  async getReadiness(orgId: string): Promise<SlaReadiness> {
    const [policiesCount, typesCount, standard] = await Promise.all([
      this.prisma.slaPolicy.count({ where: { organizationId: orgId, isActive: true } }),
      this.prisma.ticketType.count({ where: { organizationId: orgId, isActive: true } }),
      this.prisma.slaPolicy.findFirst({
        where: { organizationId: orgId, isActive: true, name: { in: STANDARD_POLICY_NAMES } },
        select: { id: true },
      }),
    ]);

    const hasStandardPolicy = !!standard;
    return {
      hasStandardPolicy,
      policiesCount,
      typesCount,
      canEnable: hasStandardPolicy,
    };
  }
}
