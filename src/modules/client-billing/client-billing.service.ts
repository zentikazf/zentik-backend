import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppConfigService } from '../../config/app.config';
import { AppException } from '../../common/filters/app-exception';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { tzOffsetMinutes } from '../ticket/sla.util';
import { CloseCycleDto } from './dto/close-cycle.dto';
import { UpdateCycleDto } from './dto/update-cycle.dto';

// Zona del negocio (es-PY). Los bordes del período se computan en esta zona y se
// persisten/filtran como instantes UTC (§6.2 del ENGINEERING_SPEC). Paraguay es
// UTC-3 permanente desde 2024, pero el helper Intl es DST-safe igual.
const ASUNCION_TZ = 'America/Asuncion';

// Tipos de movimiento facturables del ledger (String libre en el schema).
const BILLABLE_TYPES = ['USAGE', 'LOAN'];

// Transiciones válidas de la factura formal (R7).
const CYCLE_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT'],
  SENT: ['PAID'],
};

// Cap de reintentos ante colisión del invoice_number (§1.3).
const MAX_INVOICE_RETRIES = 5;

interface ClientScope {
  id: string;
  organizationId: string;
  currency: string;
}

export interface BillingRowDto {
  id: string;
  type: string;
  hours: number;
  note: string | null;
  createdAt: Date;
  workedOn: Date | null; // H8b: fecha real de trabajo (eje de facturación)
  workedMonth: string | null; // H8b: 'YYYY-MM' de pertenencia (partes UTC de workedOn)
  atrasada: boolean; // H8b: workedMonth < período del builder (arrastrada de un mes ya cerrado)
  priceAmount: string | null;
  priceRate: string | null;
  priceCurrency: string | null;
  task: { id: string; title: string; type: string } | null;
  billable: boolean;
  fueraCupo: boolean;
  sinTarifa: boolean;
}

export interface CycleDto {
  id: string;
  status: string;
  invoiceNumber: string;
  periodStart: Date;
  periodEnd: Date;
  cutoffDate: Date | null; // H8b: instante efectivo del corte (= periodEnd si mes completo)
  totalHours: number;
  totalAmount: string;
  currency: string;
  notes: string | null;
  closedAt: Date | null;
  sentAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface CycleTransactionLine {
  id: string;
  createdAt: Date;
  workedOn: Date | null; // H8b
  workedMonth: string | null; // H8b: mes de pertenencia
  atrasada: boolean; // H8b: workedMonth < período nominal del ciclo
  type: string;
  hours: number;
  note: string | null;
  priceAmount: string | null;
  priceCurrency: string | null;
  task: { id: string; title: string; type: string } | null;
}

export interface CycleTransactionsResponse {
  cycle: CycleDto;
  transactions: CycleTransactionLine[];
}

@Injectable()
export class ClientBillingService {
  private readonly logger = new Logger(ClientBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly config: AppConfigService,
  ) {}

  // ── Helpers de scope / período (T4) ────────────────────────────────────

  /** R13: resuelve el cliente dentro de la org o 404. Toda ruta lo llama primero. */
  private async assertClient(orgId: string, clientId: string): Promise<ClientScope> {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId },
      select: { id: true, organizationId: true, currency: true },
    });
    if (!client) {
      throw new AppException('El cliente no existe', 'CLIENT_NOT_FOUND', 404, { clientId });
    }
    return client;
  }

  /**
   * R1/R2/R5/R6/R11: bordes del mes `YYYY-MM` en America/Asuncion, devueltos como
   * instantes UTC para filtrar `createdAt`. Helper único compartido (§1.5).
   */
  private parsePeriod(period: string): { periodStart: Date; periodEnd: Date } {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new AppException('El período debe tener formato YYYY-MM', 'INVALID_PERIOD', 400, { period });
    }
    const [yStr, mStr] = period.split('-');
    const year = Number(yStr);
    const monthIndex = Number(mStr) - 1; // 0-based
    if (monthIndex < 0 || monthIndex > 11) {
      throw new AppException('Mes inválido en el período', 'INVALID_PERIOD', 400, { period });
    }
    const periodStart = this.asuncionInstant(year, monthIndex, 1, 0, 0, 0, 0);
    // Fin del mes = inicio del mes siguiente (Asunción) menos 1 ms → 23:59:59.999.
    const nextMonthStart = this.asuncionInstant(year, monthIndex + 1, 1, 0, 0, 0, 0);
    const periodEnd = new Date(nextMonthStart.getTime() - 1);
    return { periodStart, periodEnd };
  }

  /**
   * Instante UTC de un wall-clock de America/Asuncion, reusando el patrón zero-dep
   * `tzOffsetMinutes` de `sla.util.ts` (fix #17). offset es negativo para UTC-3/-4;
   * `utc = wallAsUTC - offset` reconstruye el instante real (§6.2).
   */
  private asuncionInstant(
    year: number,
    monthIndex: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    ms: number,
  ): Date {
    const wallAsUTC = Date.UTC(year, monthIndex, day, hour, minute, second, ms);
    const offset = tzOffsetMinutes(new Date(wallAsUTC), ASUNCION_TZ);
    return new Date(wallAsUTC - offset * 60000);
  }

  /** Año calendario de Asunción del instante (para numerar la factura por emisión). */
  private asuncionYear(date: Date): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: ASUNCION_TZ, year: 'numeric' }).format(date));
  }

  /** Clave `YYYY-MM` del mes de Asunción de un instante (agrupación de listCycles). */
  private asuncionPeriodKey(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: ASUNCION_TZ,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const m = parts.find((p) => p.type === 'month')?.value ?? '00';
    return `${y}-${m}`;
  }

  /**
   * H8b: fecha-calendario Asunción de un INSTANTE, como Date a UTC-midnight → borde para
   * filtrar workedOn (@db.Date). Prisma serializa @db.Date por componentes UTC (probado),
   * así que `workedOn: { lte: asuncionDateOnly(until) }` es determinístico e independiente
   * del TZ de sesión. Asimetría con workedMonthKey: acá la entrada es un instante (aplica TZ).
   */
  private asuncionDateOnly(instant: Date): Date {
    const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
      timeZone: ASUNCION_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(instant)
      .split('-')
      .map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  /**
   * H8b: mes de pertenencia 'YYYY-MM' de un workedOn (@db.Date, UTC-midnight = fecha Asunción).
   * Por partes UTC, NO asuncionPeriodKey: sobre un valor UTC-midnight, el TZ de Asunción (UTC-3)
   * correría el día 1 al mes anterior (off-by-one de mes).
   */
  private workedMonthKey(workedOn: Date): string {
    return `${workedOn.getUTCFullYear()}-${String(workedOn.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * H8b: meses ya "cerrados" (con ciclo activo, no CANCELLED), como set de claves 'YYYY-MM'.
   * El arrastre 2A-acotado solo trae atrasadas de estos meses (no de meses nunca cerrados).
   * asuncionPeriodKey(periodStart) y workedMonthKey(workedOn) dan la MISMA clave para el mismo
   * mes calendario, así que son comparables.
   */
  private async getClosedMonthKeys(orgId: string, clientId: string): Promise<Set<string>> {
    const cycles = await this.prisma.clientBillingCycle.findMany({
      where: { clientId, organizationId: orgId, status: { not: 'CANCELLED' } },
      select: { periodStart: true },
    });
    return new Set(cycles.map((c) => this.asuncionPeriodKey(c.periodStart)));
  }

  /**
   * R3/R5 (+ H8b): predicado del conjunto facturable SUPPORT priced sin estampar con borde
   * superior workedOn ≤ untilDate. El borde INFERIOR (qué meses entran) lo aplica el filtro
   * de mes en JS del caller (arrastre 2A-acotado), NO un `gte` fijo.
   */
  private buildFacturableWhere(clientId: string, untilDate: Date): Prisma.HoursTransactionWhereInput {
    return {
      clientId,
      deletedAt: null,
      billedCycleId: null,
      type: { in: BILLABLE_TYPES },
      priceAmount: { not: null },
      task: { type: 'SUPPORT' },
      workedOn: { lte: untilDate },
    };
  }

  /** R7: valida la transición de estado de la factura o lanza 409. */
  private assertValidCycleTransition(from: string, to: string): void {
    if (!CYCLE_TRANSITIONS[from]?.includes(to)) {
      throw new AppException(
        `No se puede pasar la factura de ${from} a ${to}`,
        'INVALID_CYCLE_TRANSITION',
        409,
        { from, to },
      );
    }
  }

  /**
   * §1.3: ¿el error es una colisión del invoice_number? Robusto ante el shape de
   * `meta.target` (Postgres devuelve el nombre del índice como string; otras versiones,
   * un array de campos). El único unique de la tabla es (organization_id, invoice_number),
   * así que cualquier P2002 sobre este flujo es la colisión del número.
   */
  private isInvoiceNumberConflict(e: unknown): boolean {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
    const target = (e.meta as { target?: string[] | string } | undefined)?.target;
    const hay = Array.isArray(target) ? target.join(',') : target ?? '';
    return hay.toLowerCase().includes('invoice');
  }

  // ── DTO helpers ────────────────────────────────────────────────────────

  private toRowDto(
    r: {
      id: string;
      type: string;
      hours: number;
      note: string | null;
      createdAt: Date;
      workedOn: Date | null;
      priceAmount: Prisma.Decimal | null;
      priceRate: Prisma.Decimal | null;
      priceCurrency: string | null;
      task: { id: string; title: string; type: string } | null;
    },
    flags: { billable: boolean; fueraCupo: boolean; sinTarifa: boolean; atrasada: boolean },
  ): BillingRowDto {
    return {
      id: r.id,
      type: r.type,
      hours: r.hours,
      note: r.note,
      createdAt: r.createdAt,
      workedOn: r.workedOn,
      workedMonth: r.workedOn ? this.workedMonthKey(r.workedOn) : null,
      atrasada: flags.atrasada,
      priceAmount: r.priceAmount != null ? r.priceAmount.toString() : null,
      priceRate: r.priceRate != null ? r.priceRate.toString() : null,
      priceCurrency: r.priceCurrency,
      task: r.task ? { id: r.task.id, title: r.task.title, type: r.task.type } : null,
      billable: flags.billable,
      fueraCupo: flags.fueraCupo,
      sinTarifa: flags.sinTarifa,
    };
  }

  private toCycleDto(c: {
    id: string;
    status: string;
    invoiceNumber: string;
    periodStart: Date;
    periodEnd: Date;
    cutoffDate: Date | null;
    totalHours: number;
    totalAmount: Prisma.Decimal;
    currency: string;
    notes: string | null;
    closedAt: Date | null;
    sentAt: Date | null;
    paidAt: Date | null;
    createdAt: Date;
  }): CycleDto {
    return {
      id: c.id,
      status: c.status,
      invoiceNumber: c.invoiceNumber,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      cutoffDate: c.cutoffDate,
      totalHours: c.totalHours,
      totalAmount: c.totalAmount.toString(),
      currency: c.currency,
      notes: c.notes,
      closedAt: c.closedAt,
      sentAt: c.sentAt,
      paidAt: c.paidAt,
      createdAt: c.createdAt,
    };
  }

  // ── Lecturas (T5, T6) ──────────────────────────────────────────────────

  /**
   * R2/R3/R11 AC1: card de armado del período. Soporte facturable (suma) + Proyecto/
   * Interno visible-only + filas SUPPORT sin tarifar marcadas `sinTarifa`. El total se
   * computa por reducción decimal.js sobre el mismo set facturable (§1.4).
   */
  async getBuilder(orgId: string, clientId: string, period: string) {
    const client = await this.assertClient(orgId, clientId);
    const { periodStart, periodEnd } = this.parsePeriod(period);

    const periodStartDate = this.asuncionDateOnly(periodStart);
    const periodEndDate = this.asuncionDateOnly(periodEnd);
    const closedMonthKeys = await this.getClosedMonthKeys(orgId, clientId);

    // (1) on-time: TODAS las clases, con workedOn dentro del mes P (excluye workedOn NULL por el rango).
    const onTime = await this.prisma.hoursTransaction.findMany({
      where: { clientId, deletedAt: null, billedCycleId: null, workedOn: { gte: periodStartDate, lte: periodEndDate } },
      include: { task: { select: { id: true, title: true, type: true } } },
      orderBy: { workedOn: 'asc' },
    });
    // (2) atrasadas: SUPPORT USAGE/LOAN (priced o sin-tarifa) de meses YA CERRADOS, workedOn < inicio de P.
    //     Sin filtro de priceAmount: las sin-tarifa DEBEN mostrarse (el guard R11 las bloquea; §3.1).
    const atrasadasRaw = await this.prisma.hoursTransaction.findMany({
      where: {
        clientId, deletedAt: null, billedCycleId: null,
        type: { in: BILLABLE_TYPES }, task: { type: 'SUPPORT' },
        workedOn: { lt: periodStartDate },
      },
      include: { task: { select: { id: true, title: true, type: true } } },
      orderBy: { workedOn: 'asc' },
    });
    const atrasadas = atrasadasRaw.filter(
      (r) => r.workedOn && closedMonthKeys.has(this.workedMonthKey(r.workedOn)),
    );

    const soporte: BillingRowDto[] = [];
    const proyecto: BillingRowDto[] = [];
    const interno: BillingRowDto[] = [];
    let subtotalSoporte = new Prisma.Decimal(0);
    let subtotalFueraCupo = new Prisma.Decimal(0);

    // Clasifica una fila SUPPORT USAGE/LOAN en `soporte`: priced suma; sin-tarifa visible pero no sumable (R11 AC1).
    const pushSoporte = (r: (typeof onTime)[number], atrasada: boolean) => {
      const fueraCupo = r.type === 'LOAN';
      if (r.priceAmount != null) {
        soporte.push(this.toRowDto(r, { billable: true, fueraCupo, sinTarifa: false, atrasada }));
        subtotalSoporte = subtotalSoporte.plus(r.priceAmount);
        if (fueraCupo) subtotalFueraCupo = subtotalFueraCupo.plus(r.priceAmount);
      } else {
        soporte.push(this.toRowDto(r, { billable: false, fueraCupo, sinTarifa: true, atrasada }));
      }
    };

    for (const r of onTime) {
      const taskType = r.task?.type ?? null;
      const isBillableType = BILLABLE_TYPES.includes(r.type);
      if (taskType === 'SUPPORT' && isBillableType) {
        pushSoporte(r, false);
      } else if (taskType === 'PROJECT' && isBillableType) {
        proyecto.push(this.toRowDto(r, { billable: false, fueraCupo: false, sinTarifa: false, atrasada: false }));
      } else {
        interno.push(this.toRowDto(r, { billable: false, fueraCupo: false, sinTarifa: false, atrasada: false }));
      }
    }
    // Atrasadas ya son SUPPORT USAGE/LOAN de meses cerrados → a `soporte`, tagueadas atrasada:true.
    for (const r of atrasadas) {
      pushSoporte(r, true);
    }

    // Integridad (hallazgo 2): SUPPORT billable con precio, sin estampar y workedOn NULL = plata invisible.
    //   El operador la ve acá y el guard de closeCycle la bloquea (BILLABLE_WITHOUT_WORKED_ON).
    const sinFechaTrabajo = await this.prisma.hoursTransaction.count({
      where: {
        clientId, deletedAt: null, billedCycleId: null,
        type: { in: BILLABLE_TYPES }, priceAmount: { not: null }, task: { type: 'SUPPORT' },
        workedOn: null,
      },
    });

    const cycles = await this.prisma.clientBillingCycle.findMany({
      where: { clientId, organizationId: orgId, periodStart: { gte: periodStart, lte: periodEnd } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      period,
      soporte,
      proyecto,
      interno,
      subtotalSoporte: subtotalSoporte.toString(),
      subtotalFueraCupo: subtotalFueraCupo.toString(),
      totalFacturable: subtotalSoporte.toString(),
      currency: client.currency,
      sinFechaTrabajo,
      cycles: cycles.map((c) => this.toCycleDto(c)),
    };
  }

  /**
   * R1: por cada mes con actividad facturable o con ciclos, deriva el `estado`
   * (no persistido) + `totalFacturable` (remanente sin estampar) + `cycles[]`.
   */
  async listCycles(orgId: string, clientId: string) {
    const client = await this.assertClient(orgId, clientId);

    const cycles = await this.prisma.clientBillingCycle.findMany({
      where: { clientId, organizationId: orgId },
      orderBy: { periodStart: 'desc' },
    });

    // Filas facturables (todas, estampadas o no) para determinar hasFacturable + remanente.
    const facturableRows = await this.prisma.hoursTransaction.findMany({
      where: {
        clientId,
        deletedAt: null,
        type: { in: BILLABLE_TYPES },
        priceAmount: { not: null },
        task: { type: 'SUPPORT' },
      },
      select: { workedOn: true, priceAmount: true, billedCycleId: true }, // H8b: bucketea por workedOn
    });

    const currentKey = this.asuncionPeriodKey(new Date());

    interface MonthBucket {
      hasFacturable: boolean;
      remainder: Prisma.Decimal;
      cycles: CycleDto[];
    }
    const months = new Map<string, MonthBucket>();
    const ensure = (key: string): MonthBucket => {
      let b = months.get(key);
      if (!b) {
        b = { hasFacturable: false, remainder: new Prisma.Decimal(0), cycles: [] };
        months.set(key, b);
      }
      return b;
    };

    for (const r of facturableRows) {
      if (!r.workedOn) continue; // H8b: sin fecha de trabajo no bucketea (el guard de closeCycle es el que alarma)
      const bucket = ensure(this.workedMonthKey(r.workedOn)); // H8b: mes de pertenencia, partes UTC
      bucket.hasFacturable = true;
      if (r.billedCycleId === null && r.priceAmount != null) {
        bucket.remainder = bucket.remainder.plus(r.priceAmount);
      }
    }
    for (const c of cycles) {
      ensure(this.asuncionPeriodKey(c.periodStart)).cycles.push(this.toCycleDto(c));
    }

    const result = [...months.entries()].map(([period, b]) => {
      const activeCycles = b.cycles.filter((c) => c.status !== 'CANCELLED');
      const hasRemainder = b.remainder.greaterThan(0);
      let estado: string;
      if (period === currentKey) {
        estado = 'EN_CURSO';
      } else if (!b.hasFacturable) {
        estado = 'SIN_TRABAJO';
      } else if (activeCycles.length > 0 && hasRemainder) {
        estado = 'FACTURADO_PARCIAL';
      } else if (activeCycles.length > 0) {
        estado = 'FACTURADO';
      } else {
        estado = 'NO_FACTURADO';
      }
      return {
        period,
        estado,
        totalFacturable: estado === 'SIN_TRABAJO' ? '0' : b.remainder.toString(),
        currency: client.currency,
        cycles: b.cycles,
      };
    });

    result.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
    return result;
  }

  /**
   * R1/R4 (T24): líneas facturadas de un ciclo (snapshot congelado). Devuelve el ciclo
   * (totales congelados) + las filas estampadas con `billedCycleId = cycleId`. Scopeado por
   * cliente (assertClient) y por ciclo del cliente. Montos Decimal → string (sin desenvolver).
   */
  async getCycleTransactions(orgId: string, clientId: string, cycleId: string): Promise<CycleTransactionsResponse> {
    await this.assertClient(orgId, clientId);

    const cycle = await this.prisma.clientBillingCycle.findFirst({
      where: { id: cycleId, clientId, organizationId: orgId },
    });
    if (!cycle) {
      throw new AppException('El ciclo no existe', 'CYCLE_NOT_FOUND', 404, { cycleId });
    }

    const transactions = await this.prisma.hoursTransaction.findMany({
      where: { billedCycleId: cycleId },
      include: { task: { select: { id: true, title: true, type: true } } },
      orderBy: { workedOn: 'asc' },
    });

    const cyclePeriod = this.asuncionPeriodKey(cycle.periodStart); // H8b: período nominal del ciclo

    return {
      cycle: this.toCycleDto(cycle),
      transactions: transactions.map((t) => {
        const workedMonth = t.workedOn ? this.workedMonthKey(t.workedOn) : null;
        return {
          id: t.id,
          createdAt: t.createdAt,
          workedOn: t.workedOn,
          workedMonth,
          atrasada: workedMonth != null && workedMonth < cyclePeriod, // H8b: pertenece a un mes anterior al del ciclo
          type: t.type,
          hours: t.hours,
          note: t.note,
          priceAmount: t.priceAmount != null ? t.priceAmount.toString() : null,
          priceCurrency: t.priceCurrency,
          task: t.task ? { id: t.task.id, title: t.task.title, type: t.task.type } : null,
        };
      }),
    };
  }

  // ── Mutaciones (T7, T8) ────────────────────────────────────────────────

  /**
   * R4/R5/R6/R11/R12/R14: cierra el período. Read+compute FUERA del tx; writes acoplados
   * DENTRO (create ciclo → estampa por lista de ids → snapshot Decimal); audit DESPUÉS.
   * Retry P2002 del invoice_number POR FUERA del tx (§1.1/§1.3).
   */
  async closeCycle(orgId: string, clientId: string, period: string, dto: CloseCycleDto, user: AuthenticatedUser) {
    const client = await this.assertClient(orgId, clientId);
    const { periodStart, periodEnd } = this.parsePeriod(period);

    let until = periodEnd;
    if (dto.until) {
      until = new Date(dto.until);
      if (until < periodStart || until > periodEnd) {
        throw new AppException('La fecha de corte está fuera del período', 'INVALID_UNTIL', 400, {
          until: dto.until,
          period,
        });
      }
    }

    const untilDate = this.asuncionDateOnly(until);
    const closedMonthKeys = await this.getClosedMonthKeys(orgId, clientId);
    // Arrastre 2A-acotado: una fila entra al cierre de P si es on-time (workedMonth == period) o
    // atrasada de un mes YA cerrado. Meses nunca cerrados NO se barren.
    const inScope = (w: Date | null): boolean =>
      !!w && (this.workedMonthKey(w) === period || closedMonthKeys.has(this.workedMonthKey(w)));

    // Guard R11 (SUPPORT sin tarifar) — ACOTADO al facturable-al-cerrar-P (findMany + filtro de mes),
    // conservando el borde superior workedOn ≤ untilDate (en corte parcial no cuenta trabajo posterior
    // al corte, aunque sea del mes). Antes contaba todo ≤ until sin filtro de mes → una fila de un mes
    // nunca cerrado bloqueaba todos los cierres.
    const sinTarifaRows = await this.prisma.hoursTransaction.findMany({
      where: {
        clientId, deletedAt: null, billedCycleId: null,
        type: { in: BILLABLE_TYPES }, task: { type: 'SUPPORT' },
        priceAmount: null, workedOn: { lte: untilDate },
      },
      select: { workedOn: true },
    });
    const sinTarifa = sinTarifaRows.filter((r) => inScope(r.workedOn)).length;
    if (sinTarifa > 0) {
      throw new AppException(
        'El cliente no tiene tarifa de soporte configurada para horas sin tarifar',
        'SUPPORT_RATE_NOT_CONFIGURED',
        409,
        { sinTarifa },
      );
    }

    // Guard de integridad (H8b): SUPPORT billable CON precio, sin estampar y workedOn NULL = plata
    // invisible (nunca matchearía el rango de workedOn → se perdería en silencio). No facturar a ciegas:
    // 409 con los ids para corregir el dato antes de cerrar. Con datos sanos (H8a: worked_on NULL=0) no dispara.
    const sinFecha = await this.prisma.hoursTransaction.findMany({
      where: {
        clientId, deletedAt: null, billedCycleId: null,
        type: { in: BILLABLE_TYPES }, priceAmount: { not: null }, task: { type: 'SUPPORT' },
        workedOn: null,
      },
      select: { id: true },
    });
    if (sinFecha.length > 0) {
      throw new AppException(
        'Hay movimientos facturables sin fecha de trabajo; corregí el dato antes de facturar',
        'BILLABLE_WITHOUT_WORKED_ON',
        409,
        { ids: sinFecha.map((r) => r.id) },
      );
    }

    // Resolve-ids-then-stamp (§1.2) con arrastre acotado: candidatos SUPPORT priced con workedOn ≤ untilDate,
    // filtrados en JS por el mes (on-time + atrasadas de meses cerrados). Se estampa por lista de ids + candado.
    const candidatos = await this.prisma.hoursTransaction.findMany({
      where: this.buildFacturableWhere(clientId, untilDate),
      select: { id: true, workedOn: true },
    });
    const facturableIds = candidatos.filter((r) => inScope(r.workedOn)).map((r) => r.id);

    const issueYear = this.asuncionYear(new Date());
    const yearStart = this.asuncionInstant(issueYear, 0, 1, 0, 0, 0, 0);
    const yearEnd = this.asuncionInstant(issueYear + 1, 0, 1, 0, 0, 0, 0);

    let result: { cycleId: string; invoiceNumber: string; movementCount: number; totalAmount: Prisma.Decimal; totalHours: number } | undefined;

    for (let attempt = 0; attempt < MAX_INVOICE_RETRIES; attempt++) {
      try {
        result = await this.prisma.$transaction(
          async (tx) => {
            // Numeración POR-ORG, status-agnóstica, año de emisión (§6.1).
            const count = await tx.clientBillingCycle.count({
              where: { organizationId: orgId, createdAt: { gte: yearStart, lt: yearEnd } },
            });
            const invoiceNumber = `FAC-${issueYear}-${String(count + 1).padStart(5, '0')}`;

            const cycle = await tx.clientBillingCycle.create({
              data: {
                organizationId: orgId,
                clientId,
                periodStart,
                periodEnd,
                cutoffDate: until, // H8b: instante efectivo del corte (= periodEnd si mes completo)
                status: 'DRAFT',
                invoiceNumber,
                currency: client.currency,
                notes: dto.notes ?? null,
              },
            });

            const stamped = await tx.hoursTransaction.updateMany({
              where: { id: { in: facturableIds }, billedCycleId: null },
              data: { billedCycleId: cycle.id },
            });
            if (stamped.count === 0) {
              // Rollback: revierte también el create del ciclo (R5 AC3).
              throw new AppException('No hay movimientos facturables en este período', 'NOTHING_TO_BILL', 409);
            }

            const agg = await tx.hoursTransaction.aggregate({
              where: { billedCycleId: cycle.id },
              _sum: { priceAmount: true, hours: true },
            });
            const totalAmount = agg._sum.priceAmount ?? new Prisma.Decimal(0);
            const totalHours = agg._sum.hours ?? 0;

            await tx.clientBillingCycle.update({
              where: { id: cycle.id },
              data: { totalAmount, totalHours, closedAt: new Date(), closedById: user.id },
            });

            return { cycleId: cycle.id, invoiceNumber, movementCount: stamped.count, totalAmount, totalHours };
          },
          { timeout: this.config.prismaTxTimeoutMs, maxWait: this.config.prismaTxMaxWaitMs },
        );
        break; // éxito
      } catch (e) {
        if (this.isInvoiceNumberConflict(e)) {
          if (attempt < MAX_INVOICE_RETRIES - 1) continue; // re-abre la tx y recomputa el número
          throw new AppException('No se pudo asignar número de factura, reintentá', 'INVOICE_NUMBER_CONFLICT', 409);
        }
        throw e; // NOTHING_TO_BILL y cualquier otro se re-lanzan tal cual
      }
    }

    // Guard de tipos (el break garantiza result definido en éxito).
    if (!result) {
      throw new AppException('No se pudo asignar número de factura, reintentá', 'INVOICE_NUMBER_CONFLICT', 409);
    }

    // Audit best-effort DESPUÉS del tx (§1.8, R12).
    await this.auditService.create({
      organizationId: orgId,
      userId: user.id,
      action: 'client.billing.cycle_closed',
      resource: 'client',
      resourceId: clientId,
      newData: {
        cycleId: result.cycleId,
        invoiceNumber: result.invoiceNumber,
        period,
        totalAmount: result.totalAmount.toString(),
        totalHours: result.totalHours,
        currency: client.currency,
        movementCount: result.movementCount,
      },
    });

    this.logger.log(
      `Cerrado ciclo ${result.cycleId} (${result.invoiceNumber}) cliente ${clientId}: ` +
        `${result.movementCount} movimientos, ${result.totalAmount.toString()} ${client.currency}`,
    );

    return {
      id: result.cycleId,
      invoiceNumber: result.invoiceNumber,
      period,
      status: 'DRAFT',
      totalAmount: result.totalAmount.toString(),
      totalHours: result.totalHours,
      movementCount: result.movementCount,
      currency: client.currency,
    };
  }

  /**
   * R8/R12: reabre un ciclo DRAFT/SENT → libera estampados (billedCycleId=null) y marca
   * el ciclo CANCELLED (keep-data). PAID → 409 sin liberar.
   */
  async reopenCycle(orgId: string, clientId: string, cycleId: string, user: AuthenticatedUser) {
    await this.assertClient(orgId, clientId);

    const cycle = await this.prisma.clientBillingCycle.findFirst({
      where: { id: cycleId, clientId, organizationId: orgId },
    });
    if (!cycle) {
      throw new AppException('El ciclo no existe', 'CYCLE_NOT_FOUND', 404, { cycleId });
    }
    if (cycle.status === 'PAID') {
      throw new AppException('El ciclo está cobrado y no puede reabrirse', 'CYCLE_ALREADY_PAID', 409, { cycleId });
    }
    if (cycle.status !== 'DRAFT' && cycle.status !== 'SENT') {
      throw new AppException('El ciclo no se puede reabrir en su estado actual', 'INVALID_CYCLE_STATE', 409, {
        cycleId,
        status: cycle.status,
      });
    }

    const released = await this.prisma.$transaction(
      async (tx) => {
        const freed = await tx.hoursTransaction.updateMany({
          where: { billedCycleId: cycleId },
          data: { billedCycleId: null },
        });
        await tx.clientBillingCycle.update({ where: { id: cycleId }, data: { status: 'CANCELLED' } });
        return freed.count;
      },
      { timeout: this.config.prismaTxTimeoutMs, maxWait: this.config.prismaTxMaxWaitMs },
    );

    await this.auditService.create({
      organizationId: orgId,
      userId: user.id,
      action: 'client.billing.cycle_reopened',
      resource: 'client',
      resourceId: clientId,
      oldData: {
        cycleId,
        invoiceNumber: cycle.invoiceNumber,
        totalAmount: cycle.totalAmount.toString(),
        totalHours: cycle.totalHours,
        currency: cycle.currency,
        movementCount: released,
      },
    });

    this.logger.log(`Reabierto ciclo ${cycleId} cliente ${clientId}: liberados ${released} movimientos`);

    return { id: cycleId, status: 'CANCELLED', releasedCount: released };
  }

  /** R7: transición de estado de la factura (DRAFT→SENT→PAID) + notas. */
  async updateCycle(orgId: string, clientId: string, cycleId: string, dto: UpdateCycleDto, _user: AuthenticatedUser) {
    await this.assertClient(orgId, clientId);

    const cycle = await this.prisma.clientBillingCycle.findFirst({
      where: { id: cycleId, clientId, organizationId: orgId },
    });
    if (!cycle) {
      throw new AppException('El ciclo no existe', 'CYCLE_NOT_FOUND', 404, { cycleId });
    }

    const data: Prisma.ClientBillingCycleUpdateInput = {};
    if (dto.status !== undefined) {
      this.assertValidCycleTransition(cycle.status, dto.status);
      data.status = dto.status;
      if (dto.status === 'SENT') data.sentAt = new Date();
      if (dto.status === 'PAID') data.paidAt = new Date();
    }
    if (dto.notes !== undefined) {
      data.notes = dto.notes;
    }
    if (Object.keys(data).length === 0) {
      throw new AppException('No hay cambios para aplicar', 'NOTHING_TO_UPDATE', 400);
    }

    const updated = await this.prisma.clientBillingCycle.update({ where: { id: cycleId }, data });
    return this.toCycleDto(updated);
  }
}
