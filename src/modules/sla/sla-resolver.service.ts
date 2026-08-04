import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SlaSource } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { domainEvent } from '../../common/events/domain-event.helper';
// `sla.util` es un util PURO del módulo ticket (no es provider Nest): se importa la
// FUNCIÓN directamente. Así `SlaModule` NO importa `TicketModule` y no hay ciclo
// (decisión 2A del blueprint: el util se muda al módulo sla recién en Fase 3).
import { calculateBusinessDeadline, parseBusinessDays } from './sla.util';
import {
  SlaResolution,
  SlaResolutionInput,
  SlaResolutionWithDeadlines,
  STANDARD_POLICY_NAMES,
} from './types/sla-resolution.types';

/**
 * ★ Corazón del feature #42 — Fase 1: la CASCADA de resolución del SLA.
 *
 * Devuelve `{ policy, source }` deteniéndose en el PRIMER paso con respuesta:
 *
 *  | # | Paso                                             | source        |
 *  |---|--------------------------------------------------|---------------|
 *  | 1 | Contrato activo del par (proyecto + tipo)         | `CONTRACT`    |
 *  | 2 | `Project.slaPolicyId`                             | `PROJECT`     |
 *  | 3 | `Client.defaultSlaPolicyId`                       | `CLIENT`      |
 *  | 4 | Política activa con la criticidad del ticket      | `CRITICALITY` |
 *  | 5 | Política activa llamada "Estándar"                | `STANDARD`    |
 *  | — | Ninguna                                           | `NONE`        |
 *
 * Invariantes que NO se negocian:
 * - Toda política considerada es `isActive: true` y de la MISMA `organizationId`
 *   (scoping multi-tenant en cada query, incluidas las que llegan por relación).
 * - El cálculo de deadlines usa el motor de horas hábiles + feriados EXISTENTE
 *   (`calculateBusinessDeadline`): este servicio solo convierte horas → minutos.
 * - El resolver NO escribe: quien crea el ticket congela `slaPolicyId`/`slaSource`
 *   y los deadlines dentro de su propia `$transaction`.
 */
@Injectable()
export class SlaResolverService {
  private readonly logger = new Logger(SlaResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async resolve(input: SlaResolutionInput): Promise<SlaResolution> {
    const { organizationId, clientId, projectId, ticketTypeId, criticality } = input;

    // ── Paso 1: contrato (proyecto + tipo) ──────────────────────────────────
    // ⚠️ MATCH EXACTO por tipo. Desde la Fase 3 los tipos son un ÁRBOL
    // (`parentId`/`path`/`level`) y este paso NO trepa por los ancestros: un
    // contrato sobre el PADRE no cubre a los hijos. Es deliberado y espeja a OSD —
    // con herencia, crear un hijo cambiaría en silencio el SLA resuelto de tickets
    // que ya estaban cubiertos por otro paso de la cascada. Si el tipo hijo no tiene
    // contrato propio, el ticket cae al paso 2 (SLA del proyecto), como siempre.
    if (projectId && ticketTypeId) {
      const contract = await this.prisma.projectTicketTypeSla.findFirst({
        where: {
          projectId,
          ticketTypeId,
          isActive: true,
          // Doble scoping: el proyecto Y la política deben ser de la org del ticket.
          project: { organizationId },
          slaPolicy: { organizationId, isActive: true },
        },
        include: { slaPolicy: true },
      });
      if (contract?.slaPolicy) {
        return { policy: contract.slaPolicy, source: SlaSource.CONTRACT };
      }
    }

    // ── Paso 2: SLA propio del proyecto ─────────────────────────────────────
    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: {
          id: projectId,
          organizationId,
          slaPolicy: { organizationId, isActive: true },
        },
        select: { slaPolicy: true },
      });
      if (project?.slaPolicy) {
        return { policy: project.slaPolicy, source: SlaSource.PROJECT };
      }
    }

    // ── Paso 3: SLA default del cliente ─────────────────────────────────────
    const client = await this.prisma.client.findFirst({
      where: {
        id: clientId,
        organizationId,
        defaultSlaPolicy: { organizationId, isActive: true },
      },
      select: { defaultSlaPolicy: true },
    });
    if (client?.defaultSlaPolicy) {
      return { policy: client.defaultSlaPolicy, source: SlaSource.CLIENT };
    }

    // ── Paso 4: política de la criticidad del ticket (red de seguridad) ─────
    // Replica el comportamiento actual (SlaConfig por criticidad) para que, con
    // la config a medio cargar, ningún ticket se quede sin SLA.
    if (criticality) {
      const byCriticality = await this.prisma.slaPolicy.findFirst({
        where: { organizationId, criticality, isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      if (byCriticality) {
        return { policy: byCriticality, source: SlaSource.CRITICALITY };
      }
    }

    // ── Paso 5: política "Estándar" (fallback global) ───────────────────────
    const standard = await this.prisma.slaPolicy.findFirst({
      where: { organizationId, isActive: true, name: { in: STANDARD_POLICY_NAMES } },
      orderBy: { createdAt: 'asc' },
    });
    if (standard) {
      return { policy: standard, source: SlaSource.STANDARD };
    }

    // ── Sin política: el ticket queda sin deadlines (igual que hoy sin SlaConfig).
    this.logger.warn(
      `SLA sin resolver (org=${organizationId} client=${clientId} project=${projectId ?? '-'} ` +
        `type=${ticketTypeId ?? '-'} criticality=${criticality ?? '-'}): la organización no tiene ` +
        'política "Estándar". El ticket se crea SIN deadlines.',
    );
    return { policy: null, source: SlaSource.NONE };
  }

  /**
   * Resuelve la cascada y calcula ambos deadlines con el motor de horas hábiles.
   *
   * `horas * 60` → minutos, que es la unidad que espera `calculateBusinessDeadline`
   * (el `SlaConfig` viejo ya guardaba minutos; las políticas guardan horas).
   *
   * @param now instante de referencia (inyectable para tests deterministas).
   */
  async resolveAndCalculateDeadlines(
    input: SlaResolutionInput,
    now: Date = new Date(),
  ): Promise<SlaResolutionWithDeadlines> {
    const resolution = await this.resolve(input);

    if (!resolution.policy) {
      return { ...resolution, responseDeadline: null, resolutionDeadline: null };
    }

    // Mismo par de queries que el path actual (ticket.service / portal.service):
    // horario hábil de la org + feriados.
    const [businessHours, holidayRows] = await Promise.all([
      this.prisma.businessHoursConfig.findUnique({
        where: { organizationId: input.organizationId },
      }),
      this.prisma.holiday.findMany({
        where: { organizationId: input.organizationId },
        select: { date: true },
      }),
    ]);

    const bhConfig = businessHours
      ? {
          start: businessHours.businessHoursStart,
          end: businessHours.businessHoursEnd,
          days: parseBusinessDays(businessHours.businessDays),
          timezone: businessHours.timezone,
        }
      : undefined;
    const holidays = holidayRows.map((h) => h.date);

    const responseDeadline = calculateBusinessDeadline(
      now,
      resolution.policy.firstResponseHours * 60,
      bhConfig,
      holidays,
    );
    const resolutionDeadline = calculateBusinessDeadline(
      now,
      resolution.policy.resolutionHours * 60,
      bhConfig,
      holidays,
    );

    this.emitFallbackIfNeeded(input, resolution);

    return { ...resolution, responseDeadline, resolutionDeadline };
  }

  /**
   * `sla.resolved.fallback` — alimenta la alerta de "configuración incompleta".
   *
   * Se emite cuando la cascada tuvo que caer a la red de seguridad (`CRITICALITY`)
   * o al fallback global (`STANDARD`): significa que ese proyecto/tipo NO tiene
   * contrato ni SLA de proyecto/cliente.
   *
   * `ticketId` va null a propósito: la resolución ocurre ANTES de la `$transaction`
   * que crea el ticket (los deadlines se congelan en el mismo create), así que el id
   * todavía no existe. El consumidor de la alerta agrupa por proyecto + tipo, que sí
   * viajan en el payload.
   */
  private emitFallbackIfNeeded(input: SlaResolutionInput, resolution: SlaResolution): void {
    if (resolution.source !== SlaSource.CRITICALITY && resolution.source !== SlaSource.STANDARD) {
      return;
    }
    const policyId = resolution.policy?.id ?? '';
    this.eventEmitter.emit('sla.resolved.fallback', {
      ...domainEvent('sla.resolved.fallback', 'sla_policy', policyId, input.organizationId),
      ticketId: null,
      organizationId: input.organizationId,
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      ticketTypeId: input.ticketTypeId ?? null,
      policyId,
      source: resolution.source,
    });
  }
}
