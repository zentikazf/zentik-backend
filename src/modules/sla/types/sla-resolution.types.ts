import { SlaPolicy, SlaSource, TicketCriticality } from '@prisma/client';

/**
 * Tipos de la resolución SLA por cascada (feature #42 — Fase 1).
 *
 * `SlaSource` viene del enum de Prisma (schema.prisma) — NO se redeclara acá para
 * que el compilador ate el valor persistido en `Ticket.slaSource` con el que
 * devuelve el resolver.
 */

/** Entrada de la cascada. Todo lo opcional es "puede no haberse elegido en el form". */
export interface SlaResolutionInput {
  organizationId: string;
  clientId: string;
  projectId?: string | null;
  ticketTypeId?: string | null;
  criticality?: TicketCriticality | null;
}

/** Salida de la cascada: qué política se aplicó y en qué paso se detuvo. */
export interface SlaResolution {
  policy: SlaPolicy | null;
  source: SlaSource;
}

/**
 * Resolución + deadlines ya calculados con el motor de horas hábiles existente.
 * Si `policy` es null (source NONE) ambos deadlines son null — mismo comportamiento
 * que hoy cuando no hay `SlaConfig` para la criticidad.
 */
export interface SlaResolutionWithDeadlines extends SlaResolution {
  responseDeadline: Date | null;
  resolutionDeadline: Date | null;
}

/**
 * Nombres aceptados para la política de fallback global (paso 5 de la cascada).
 * Se contempla la variante sin tilde porque el nombre lo tipea un humano en la UI
 * y el `@@unique([organizationId, name])` es case/accent-sensitive en Postgres.
 */
export const STANDARD_POLICY_NAMES: string[] = ['Estándar', 'Estandar'];

/** Nombre canónico que crea el seed cuando la org no tiene ninguna "Estándar". */
export const STANDARD_POLICY_CANONICAL_NAME = 'Estándar';

/**
 * Estado de configuración de la org para poder activar `SLA_CASCADE_ENABLED`.
 *
 * ⚠️ Guardarraíl: `canEnable` es false sin política "Estándar". Activar el flag sin
 * ella deja tickets SIN SLA (la cascada termina en `NONE` → deadlines null) para
 * todo ticket cuya criticidad no tenga política propia.
 */
export interface SlaReadiness {
  hasStandardPolicy: boolean;
  policiesCount: number;
  typesCount: number;
  canEnable: boolean;
}

/** Resultado del seed idempotente desde la configuración SLA actual. */
export interface SlaSeedResult {
  policiesCreated: number;
  typesCreated: number;
  /** Filas de `TicketCriticalityConfig` sembradas (Fase 2). Solo si la org no tenía ninguna. */
  criticalityConfigsCreated: number;
  alreadyExisting: number;
}
