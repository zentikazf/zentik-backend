import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppConfigService } from '../../config/app.config';
import { AppException } from '../../common/filters/app-exception';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { tzOffsetMinutes } from '../ticket/sla.util';
import { CloseCycleDto } from './dto/close-cycle.dto';
import { PreviewCycleDto } from './dto/preview-cycle.dto';
import { ReopenCycleDto } from './dto/reopen-cycle.dto';
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
  kind: string; // H8d: MONTH | ACCUMULATED
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
  cancelReason: string | null; // H8d/A3: motivo de anulación (keep-data)
  cancelledAt: Date | null; // H8d/A3: cuándo se anuló
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
  priceRate: string | null; // H8e: tarifa por hora (para el PDF de la factura)
  priceCurrency: string | null;
  task: { id: string; title: string; type: string } | null;
}

export interface CycleTransactionsResponse {
  cycle: CycleDto;
  transactions: CycleTransactionLine[];
  grupos: Array<{ workedMonth: string; label: string; subtotal: string; horas: number }>; // H8d: desglose por mes
}

// H8d: modo del motor. MES = un mes nominal (comportamiento mono-mes previo). ACUMULADO = varios
// meses ELEGIDOS a mano (A1) barridos en una sola factura, sin gate de mes cerrado.
type FacturableMode = 'MES' | 'ACUMULADO';

// Fila cruda del candidato facturable (con Decimal), para agrupar/subtotalizar en el preview.
interface FacturableRawRow {
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
}

// Resultado de la fase read+compute compartida por preview (dry-run) y emisión (closeCycle).
interface ComputeFacturableResult {
  facturableIds: string[];
  rows: FacturableRawRow[]; // filas incluidas (post inScope), con workedOn no-null garantizado
  periodStart: Date; // borde inferior (mes nominal en MES; 1º del mes más viejo con filas en ACUMULADO)
  periodEnd: Date; // borde nominal superior (= cutoffDate)
  cutoffDate: Date; // instante efectivo del corte (= until)
  currency: string;
  bloqueos: {
    sinTarifaRate: boolean; // SUPPORT_RATE_NOT_CONFIGURED anticipado (flag, no lanza)
    sinFechaTrabajo: { count: number; ids: string[] }; // BILLABLE_WITHOUT_WORKED_ON anticipado
    revertidasVivas: { count: number; ids: string[] }; // H9a: BILLABLE_INTEGRITY_VIOLATION anticipado
  };
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
    kind: string;
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
    cancelReason: string | null;
    cancelledAt: Date | null;
    createdAt: Date;
  }): CycleDto {
    return {
      id: c.id,
      status: c.status,
      kind: c.kind,
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
      cancelReason: c.cancelReason,
      cancelledAt: c.cancelledAt,
      createdAt: c.createdAt,
    };
  }

  /** H8d: etiqueta de mes es-PY 'YYYY-MM' → 'Abril 2026' (header de grupo del preview). */
  private monthLabel(period: string): string {
    const [y, m] = period.split('-').map(Number);
    if (!y || !m) return period;
    const label = new Intl.DateTimeFormat('es-PY', { month: 'long', year: 'numeric' }).format(
      new Date(Date.UTC(y, m - 1, 15)),
    );
    return label.charAt(0).toUpperCase() + label.slice(1);
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
      } else if (!hasRemainder) {
        // H8d: sin remanente = todo lo facturable del mes ya está estampado, venga de un ciclo mensual
        //   o de una factura ACUMULADA que barrió este mes (bucketeada bajo su mes más viejo, no acá).
        //   Antes esto exigía activeCycles>0 y dejaba mayo/junio de una acumulada como "No facturado Gs 0".
        estado = 'FACTURADO';
      } else if (activeCycles.length > 0) {
        estado = 'FACTURADO_PARCIAL';
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

    const lines = transactions.map((t) => {
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
        priceRate: t.priceRate != null ? t.priceRate.toString() : null, // H8e
        priceCurrency: t.priceCurrency,
        task: t.task ? { id: t.task.id, title: t.task.title, type: t.task.type } : null,
      };
    });

    // H8d: desglose por mes-de-trabajo (subtotales Decimal → string en el BACKEND; nunca aritmética en el
    // cliente). Útil sobre todo en facturas ACUMULADAS que cruzan varios meses.
    const bucket = new Map<string, { subtotal: Prisma.Decimal; horas: number }>();
    for (const t of transactions) {
      const key = t.workedOn ? this.workedMonthKey(t.workedOn) : 'sin-fecha';
      const b = bucket.get(key) ?? { subtotal: new Prisma.Decimal(0), horas: 0 };
      b.subtotal = b.subtotal.plus(t.priceAmount ?? 0);
      b.horas += t.hours ?? 0;
      bucket.set(key, b);
    }
    const grupos = [...bucket.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([workedMonth, b]) => ({
        workedMonth,
        label: workedMonth === 'sin-fecha' ? 'Sin fecha' : this.monthLabel(workedMonth),
        subtotal: b.subtotal.toString(),
        horas: b.horas,
      }));

    return {
      cycle: this.toCycleDto(cycle),
      transactions: lines,
      grupos,
    };
  }

  // ── Mutaciones (T7, T8) ────────────────────────────────────────────────

  /**
   * H8d Capa 0: fase read+compute COMPARTIDA por el preview (dry-run) y la emisión (closeCycle), para
   * que NUNCA diverjan (el preview no puede mentir respecto de lo que se estampa). En modo MES conserva
   * EXACTAMENTE el arrastre 2A-acotado previo (mismas queries, mismo orden). En ACUMULADO (A1) barre el
   * trabajo no facturado de los MESES ELEGIDOS a mano, sin gate de mes cerrado. Devuelve los bloqueos
   * como data (flags): el caller decide si lanza (closeCycle) o los expone (preview).
   */
  private async computeFacturable(
    orgId: string,
    clientId: string,
    opts: { mode: FacturableMode; period?: string; months?: string[]; until?: string },
  ): Promise<ComputeFacturableResult> {
    const client = await this.assertClient(orgId, clientId);

    let periodStart: Date;
    let periodEnd: Date;
    let until: Date;
    let inScope: (w: Date | null) => boolean;

    if (opts.mode === 'MES') {
      if (!opts.period) {
        throw new AppException('Falta el período a facturar', 'PERIOD_REQUIRED', 400);
      }
      const period = opts.period;
      ({ periodStart, periodEnd } = this.parsePeriod(period));
      until = periodEnd;
      if (opts.until) {
        until = new Date(opts.until);
        if (until < periodStart || until > periodEnd) {
          throw new AppException('La fecha de corte está fuera del período', 'INVALID_UNTIL', 400, {
            until: opts.until,
            period,
          });
        }
      }
      // Arrastre 2A-acotado (idéntico al mono-mes previo): on-time del mes o atrasada de un mes YA cerrado.
      const closedMonthKeys = await this.getClosedMonthKeys(orgId, clientId);
      inScope = (w: Date | null): boolean =>
        !!w && (this.workedMonthKey(w) === period || closedMonthKeys.has(this.workedMonthKey(w)));
    } else {
      // ACUMULADO (A1): se factura el trabajo no facturado de los MESES ELEGIDOS a mano.
      if (!opts.months || opts.months.length === 0) {
        throw new AppException('Elegí al menos un mes para la factura acumulada', 'MONTHS_REQUIRED', 400);
      }
      for (const m of opts.months) {
        if (!/^\d{4}-\d{2}$/.test(m)) {
          throw new AppException('Mes inválido en la selección (formato YYYY-MM)', 'INVALID_PERIOD', 400, { month: m });
        }
      }
      const monthSet = new Set(opts.months);
      const sortedMonths = [...opts.months].sort();
      const oldestMonth = sortedMonths[0];
      const latestMonth = sortedMonths[sortedMonths.length - 1];
      // Bordes nominales del rango elegido; periodStart se refina al mes más viejo con filas reales (A4).
      periodStart = this.parsePeriod(oldestMonth).periodStart;
      const latestEnd = this.parsePeriod(latestMonth).periodEnd;
      // Corte parcial libre dentro de los meses elegidos (A7); default = fin del mes más nuevo elegido.
      until = opts.until ? new Date(opts.until) : latestEnd;
      if (until > latestEnd) until = latestEnd; // no barrer más allá de los meses seleccionados
      periodEnd = until;
      // Sin gate closedMonthKeys: entra TODO lo no facturado de los meses elegidos (cerrados o nunca cerrados).
      inScope = (w: Date | null): boolean => !!w && monthSet.has(this.workedMonthKey(w));
    }

    const untilDate = this.asuncionDateOnly(until);

    // Guard R11 (SUPPORT sin tarifar) como FLAG — no lanza acá; closeCycle lo re-evalúa y lanza (§3.3).
    const sinTarifaRows = await this.prisma.hoursTransaction.findMany({
      where: {
        clientId, deletedAt: null, billedCycleId: null,
        type: { in: BILLABLE_TYPES }, task: { type: 'SUPPORT' },
        priceAmount: null, workedOn: { lte: untilDate },
      },
      select: { workedOn: true },
    });
    const sinTarifaRate = sinTarifaRows.some((r) => inScope(r.workedOn));

    // Guard integridad (SUPPORT priced con workedOn NULL) como FLAG — global (un null no se atribuye a un mes).
    const sinFecha = await this.prisma.hoursTransaction.findMany({
      where: {
        clientId, deletedAt: null, billedCycleId: null,
        type: { in: BILLABLE_TYPES }, priceAmount: { not: null }, task: { type: 'SUPPORT' },
        workedOn: null,
      },
      select: { id: true },
    });

    // Candidatos: buildFacturableWhere trae todo ≤ untilDate sin estampar; inScope acota el borde inferior.
    const candidatos = await this.prisma.hoursTransaction.findMany({
      where: this.buildFacturableWhere(clientId, untilDate),
      select: {
        id: true, type: true, hours: true, note: true, createdAt: true, workedOn: true,
        priceAmount: true, priceRate: true, priceCurrency: true,
        task: { select: { id: true, title: true, type: true } },
      },
      orderBy: { workedOn: 'asc' },
    });
    const rows = candidatos.filter((r) => inScope(r.workedOn));
    const facturableIds = rows.map((r) => r.id);

    // H9a guard fail-closed: post-neteo una carga revertida está tombstoneada y NUNCA llega a
    // candidatos. Si un REFUND vivo referencia un candidato facturable = regresión del neteo (o
    // data re-corrompida) → se bloquea la emisión ANTES de cobrar plata de más. Flag acá; lanza
    // closeCycle (mismo patrón que sinTarifaRate/sinFechaTrabajo).
    const revertidasVivas = facturableIds.length
      ? await this.prisma.hoursTransaction.findMany({
          where: { type: 'REFUND', deletedAt: null, reversesTransactionId: { in: facturableIds } },
          select: { reversesTransactionId: true },
        })
      : [];

    // A4: en acumulado, periodStart = 1º del mes más viejo REALMENTE incluido en el set (no un rango teórico).
    if (opts.mode === 'ACUMULADO' && rows.length > 0) {
      const oldestWorked = rows.reduce<Date>(
        (min, r) => (r.workedOn! < min ? r.workedOn! : min),
        rows[0].workedOn!,
      );
      periodStart = this.parsePeriod(this.workedMonthKey(oldestWorked)).periodStart;
    }

    return {
      facturableIds,
      rows,
      periodStart,
      periodEnd,
      cutoffDate: until,
      currency: client.currency,
      bloqueos: {
        sinTarifaRate,
        sinFechaTrabajo: { count: sinFecha.length, ids: sinFecha.map((r) => r.id) },
        revertidasVivas: {
          count: revertidasVivas.length,
          ids: revertidasVivas.map((r) => r.reversesTransactionId!),
        },
      },
    };
  }

  /**
   * H8d Capa 1: PREVIEW dry-run. computeFacturable + agrupación por mes-de-trabajo (workedMonth);
   * subtotales/total calculados en BACKEND con Decimal → string (nunca aritmética en el cliente).
   * CERO escrituras. Los bloqueos se exponen como flags accionables (no llegan como sorpresa post-submit).
   * No predice invoiceNumber (se numera dentro del tx de emisión).
   */
  async previewCycle(orgId: string, clientId: string, dto: PreviewCycleDto) {
    const mode: FacturableMode = dto.mode ?? 'MES';
    const comp = await this.computeFacturable(orgId, clientId, {
      mode, period: dto.period, months: dto.months, until: dto.until,
    });

    // Agrupación por workedMonth (Map<string,Bucket>, patrón idéntico a listCycles).
    const buckets = new Map<string, { rows: FacturableRawRow[]; subtotal: Prisma.Decimal; horas: number }>();
    for (const r of comp.rows) {
      const key = this.workedMonthKey(r.workedOn!); // rows garantizan workedOn no-null (inScope)
      const b = buckets.get(key) ?? { rows: [], subtotal: new Prisma.Decimal(0), horas: 0 };
      b.rows.push(r);
      b.subtotal = b.subtotal.plus(r.priceAmount ?? 0);
      b.horas += r.hours ?? 0;
      buckets.set(key, b);
    }

    const grupos = [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) // cronológico ascendente: abril, mayo, junio…
      .map(([workedMonth, b]) => ({
        workedMonth,
        label: this.monthLabel(workedMonth),
        rows: b.rows.map((r) =>
          this.toRowDto(r, {
            billable: r.priceAmount != null,
            fueraCupo: r.type === 'LOAN',
            sinTarifa: r.priceAmount == null,
            atrasada: false,
          }),
        ),
        subtotalMes: b.subtotal.toString(),
        horasMes: b.horas,
      }));

    const total = grupos.reduce((acc, g) => acc.plus(g.subtotalMes), new Prisma.Decimal(0)).toString();

    const puedeEmitir =
      comp.facturableIds.length > 0 &&
      !comp.bloqueos.sinTarifaRate &&
      comp.bloqueos.sinFechaTrabajo.count === 0 &&
      comp.bloqueos.revertidasVivas.count === 0;

    const issueYear = this.asuncionYear(new Date());

    return {
      mode,
      periodStart: comp.periodStart,
      periodEnd: comp.periodEnd,
      cutoffDate: comp.cutoffDate,
      grupos,
      total,
      currency: comp.currency,
      bloqueos: comp.bloqueos,
      puedeEmitir,
      motivo: comp.facturableIds.length === 0 ? 'NOTHING_TO_BILL' : null, // empty state anticipado
      nextInvoiceHint: `FAC-${issueYear}-…`,
    };
  }

  /**
   * H8d Capa 2 (R4/R5/R6/R11/R12/R14): emite la factura (MES o ACUMULADO). Read+compute compartido
   * FUERA del tx (computeFacturable); writes acoplados DENTRO (create ciclo → estampa por lista de ids →
   * snapshot Decimal); audit DESPUÉS. Retry P2002 del invoice_number POR FUERA del tx (§1.1/§1.3).
   * `period` posicional = mes nominal del modo MES (viaja por path en la ruta legacy :period/close).
   */
  async closeCycle(orgId: string, clientId: string, period: string, dto: CloseCycleDto, user: AuthenticatedUser) {
    const mode: FacturableMode = dto.mode ?? 'MES';
    const comp = await this.computeFacturable(orgId, clientId, {
      mode, period, months: dto.months, until: dto.until,
    });

    // Defensa en profundidad: los flags que el preview solo exponía, acá SÍ lanzan (por si el estado cambió
    // entre preview y emit). Orden idéntico al previo: primero tarifa, después fecha de trabajo.
    if (comp.bloqueos.sinTarifaRate) {
      throw new AppException(
        'El cliente no tiene tarifa de soporte configurada para horas sin tarifar',
        'SUPPORT_RATE_NOT_CONFIGURED',
        409,
      );
    }
    if (comp.bloqueos.sinFechaTrabajo.count > 0) {
      throw new AppException(
        'Hay movimientos facturables sin fecha de trabajo; corregí el dato antes de facturar',
        'BILLABLE_WITHOUT_WORKED_ON',
        409,
        { ids: comp.bloqueos.sinFechaTrabajo.ids },
      );
    }
    if (comp.bloqueos.revertidasVivas.count > 0) {
      throw new AppException(
        'Hay cargas revertidas sin neutralizar en el conjunto facturable',
        'BILLABLE_INTEGRITY_VIOLATION',
        409,
        { ids: comp.bloqueos.revertidasVivas.ids },
      );
    }

    const kind = mode === 'ACUMULADO' ? 'ACCUMULATED' : 'MONTH';
    const facturableIds = comp.facturableIds;
    const scopeLabel = mode === 'ACUMULADO' ? (dto.months ?? []).join(',') : period;

    const issueYear = this.asuncionYear(new Date());
    const yearStart = this.asuncionInstant(issueYear, 0, 1, 0, 0, 0, 0);
    const yearEnd = this.asuncionInstant(issueYear + 1, 0, 1, 0, 0, 0, 0);

    let result: { cycleId: string; invoiceNumber: string; movementCount: number; totalAmount: Prisma.Decimal; totalHours: number } | undefined;

    for (let attempt = 0; attempt < MAX_INVOICE_RETRIES; attempt++) {
      try {
        result = await this.prisma.$transaction(
          async (tx) => {
            // Numeración POR-ORG, status-agnóstica, año de emisión (§6.1). Se mantiene tal cual (A3):
            // la anulada CONSUME su número (fiscalmente correcto es-PY); ningún número se reutiliza.
            const count = await tx.clientBillingCycle.count({
              where: { organizationId: orgId, createdAt: { gte: yearStart, lt: yearEnd } },
            });
            const invoiceNumber = `FAC-${issueYear}-${String(count + 1).padStart(5, '0')}`;

            const cycle = await tx.clientBillingCycle.create({
              data: {
                organizationId: orgId,
                clientId,
                kind, // H8d: MONTH | ACCUMULATED
                periodStart: comp.periodStart, // ACUMULADO: 1º del mes más viejo realmente incluido
                periodEnd: comp.periodEnd,
                cutoffDate: comp.cutoffDate, // instante efectivo del corte (= periodEnd si completo)
                status: 'DRAFT',
                invoiceNumber,
                currency: comp.currency,
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
        mode,
        kind,
        period: mode === 'MES' ? period : null,
        months: mode === 'ACUMULADO' ? (dto.months ?? null) : null,
        totalAmount: result.totalAmount.toString(),
        totalHours: result.totalHours,
        currency: comp.currency,
        movementCount: result.movementCount,
      },
    });

    this.logger.log(
      `Emitido ciclo ${result.cycleId} (${result.invoiceNumber}, ${kind}) cliente ${clientId} [${scopeLabel}]: ` +
        `${result.movementCount} movimientos, ${result.totalAmount.toString()} ${comp.currency}`,
    );

    return {
      id: result.cycleId,
      invoiceNumber: result.invoiceNumber,
      kind,
      period: mode === 'MES' ? period : null,
      status: 'DRAFT',
      totalAmount: result.totalAmount.toString(),
      totalHours: result.totalHours,
      movementCount: result.movementCount,
      currency: comp.currency,
    };
  }

  /**
   * R8/R12 + H8d/A3: anula (reabre) un ciclo DRAFT/SENT → libera estampados (billedCycleId=null) y marca
   * el ciclo CANCELLED con MOTIVO obligatorio + trazabilidad (quién/cuándo). Keep-data: la factura anulada
   * queda como registro contable permanente, visible en el listado marcada "Anulada". PAID → 409 sin liberar.
   */
  async reopenCycle(
    orgId: string,
    clientId: string,
    cycleId: string,
    dto: ReopenCycleDto,
    user: AuthenticatedUser,
  ) {
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

    const cancelReason = dto.cancelReason.trim();
    const released = await this.prisma.$transaction(
      async (tx) => {
        const freed = await tx.hoursTransaction.updateMany({
          where: { billedCycleId: cycleId },
          data: { billedCycleId: null },
        });
        await tx.clientBillingCycle.update({
          where: { id: cycleId },
          data: { status: 'CANCELLED', cancelReason, cancelledAt: new Date(), cancelledById: user.id },
        });
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
        cancelReason,
      },
    });

    this.logger.log(
      `Anulado ciclo ${cycleId} (${cycle.invoiceNumber}) cliente ${clientId}: liberados ${released} movimientos — motivo: ${cancelReason}`,
    );

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
