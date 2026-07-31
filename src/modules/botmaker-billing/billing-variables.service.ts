import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { UpsertVariablesDto } from './dto/upsert-variables.dto';

/** Modo de precio de una variable (contrato del cliente). */
export type PricingMode = 'DIRECTO' | 'CALCULO' | 'MANUAL';

/** Operación del modo CALCULO: multiplicar por precio unitario o dividir por un divisor (unidades/USD). */
export type PricingOp = 'MULT' | 'DIV';

/** Ítem del statement (JSON) — montos en USD. `rawValue` nullable para variables manuales. */
export interface StatementItem {
  label: string;
  usage?: number | null; // #23: cantidad del API (base del cálculo por unidad)
  rawValue?: number | null;
  commercialValue: number;
  source: 'BOTMAKER' | 'MANUAL';
  // #23: regla de precio persistida. DIRECTO = crudo; CALCULO = op(usage−incluidas, unitPrice); MANUAL = a mano.
  mode?: PricingMode | null;
  incluidas?: number | null; // solo CALCULO
  unitPrice?: number | null; // solo CALCULO (precio unitario en MULT; divisor unidades/USD en DIV)
  op?: PricingOp | null; // solo CALCULO (default MULT)
}

/** Ítem crudo importado de Botmaker (antes de aplicar el contrato). */
export interface ImportedItem {
  label: string;
  usage: number;
  rawValue: number;
  commercialValue: number;
  source: 'BOTMAKER';
}

/** Línea comercial mínima que consume el motor de ciclos (nunca expone rawValue). */
export interface CommercialLine {
  label: string;
  commercialValue: number; // USD
}

/**
 * CRUD del statement de variables por cliente+período (feature #23). Scopeado por org (assertClient).
 * El **total comercial se calcula SIEMPRE en el backend** (nunca se confía en el cliente). Los montos son
 * USD; la conversión a Gs y el cobro ocurren en la factura del ciclo.
 */
@Injectable()
export class BillingVariablesService {
  private readonly logger = new Logger(BillingVariablesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** R13: resuelve el cliente dentro de la org o 404. Toda ruta admin lo llama primero. */
  private async assertClient(orgId: string, clientId: string): Promise<{ id: string; botmakerAccountId: string | null }> {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId },
      select: { id: true, botmakerAccountId: true },
    });
    if (!client) {
      throw new AppException('El cliente no existe', 'CLIENT_NOT_FOUND', 404, { clientId });
    }
    return client;
  }

  /** Resuelve el cliente (org scope) y devuelve su cuenta Botmaker mapeada — para el import prefill. */
  async resolveClientAccount(orgId: string, clientId: string): Promise<{ botmakerAccountId: string | null }> {
    const client = await this.assertClient(orgId, clientId);
    return { botmakerAccountId: client.botmakerAccountId };
  }

  /**
   * #23: aplica el CONTRATO del cliente a los ítems recién importados de Botmaker. Toma la última statement
   * guardada (mes más reciente), matchea por label y ARRASTRA la regla (mode + incluidas + unitPrice),
   * recalculando el comercial con el usage/crudo NUEVOS. Ítem sin regla previa → comercial 0 (a definir).
   * Así, seteada la regla una vez, los meses siguientes se calculan solos al abrirlos.
   */
  async applyContractRules(clientId: string, imported: ImportedItem[]): Promise<StatementItem[]> {
    const latest = await this.prisma.clientBillingStatement.findFirst({
      where: { clientId },
      orderBy: { period: 'desc' },
      select: { items: true },
    });
    const prior = new Map<string, StatementItem>();
    for (const it of this.toItems(latest?.items)) prior.set(it.label, it);

    return imported.map((imp) => {
      const rule = prior.get(imp.label);
      const base: StatementItem = {
        label: imp.label,
        usage: imp.usage,
        rawValue: imp.rawValue,
        commercialValue: 0,
        source: 'BOTMAKER',
      };
      if (!rule || !rule.mode) return base; // sin contrato previo → el admin define la regla
      const item: StatementItem = {
        ...base,
        mode: rule.mode,
        incluidas: rule.incluidas ?? null,
        unitPrice: rule.unitPrice ?? null,
        op: rule.op ?? null,
      };
      // MANUAL arrastra el valor previo (fee fijo); DIRECTO/CALCULO recalculan con el usage/crudo nuevos.
      item.commercialValue = computeCommercial({ ...item, commercialValue: rule.commercialValue });
      return item;
    });
  }

  private assertPeriod(period: string): void {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new AppException('El período debe tener formato YYYY-MM', 'INVALID_PERIOD', 400, { period });
    }
  }

  private toItems(raw: Prisma.JsonValue | null | undefined): StatementItem[] {
    if (!Array.isArray(raw)) return [];
    return raw as unknown as StatementItem[];
  }

  private totalCommercial(items: StatementItem[]): number {
    return round2(items.reduce((s, i) => s + (Number(i.commercialValue) || 0), 0));
  }

  /** R3 AC4: meses con statement (para la lista de meses del editor). */
  async list(orgId: string, clientId: string) {
    await this.assertClient(orgId, clientId);
    const statements = await this.prisma.clientBillingStatement.findMany({
      where: { clientId },
      orderBy: { period: 'desc' },
      select: { period: true, items: true, note: true, billedCycleId: true, updatedAt: true },
    });
    return statements.map((s) => {
      const items = this.toItems(s.items);
      return {
        period: s.period,
        itemCount: items.length,
        totalCommercial: this.totalCommercial(items),
        note: s.note,
        billed: !!s.billedCycleId, // #23: ya facturado (candado) → editor read-only, no re-cobra
        billedCycleId: s.billedCycleId, // link directo a la factura que lo incluyó
        updatedAt: s.updatedAt,
      };
    });
  }

  /** R3 AC4: statement de un período (o vacío si no existe todavía). Total comercial server-side. */
  async get(orgId: string, clientId: string, period: string) {
    await this.assertClient(orgId, clientId);
    this.assertPeriod(period);
    const statement = await this.prisma.clientBillingStatement.findUnique({
      where: { clientId_period: { clientId, period } },
    });
    const items = this.toItems(statement?.items);
    return {
      period,
      items,
      note: statement?.note ?? null,
      totalCommercial: this.totalCommercial(items),
      billed: !!statement?.billedCycleId, // #23: candado — si ya se facturó, el editor es read-only
      billedCycleId: statement?.billedCycleId ?? null, // link directo a la factura que lo incluyó
      exists: !!statement,
    };
  }

  /** R3 AC4: upsert de items + note. Valida (DTO) y recalcula el total comercial en el backend. */
  async upsert(orgId: string, clientId: string, period: string, dto: UpsertVariablesDto) {
    await this.assertClient(orgId, clientId);
    this.assertPeriod(period);

    // #23: candado anti-doble-cobro — un statement ya facturado es inmutable (como las horas facturadas).
    //   Reabrir el ciclo lo libera. Check-then-act (fallback §1.7 aceptado: acción manual del admin).
    const existing = await this.prisma.clientBillingStatement.findUnique({
      where: { clientId_period: { clientId, period } },
      select: { billedCycleId: true },
    });
    if (existing?.billedCycleId) {
      throw new AppException(
        'Las variables de este período ya se facturaron. Reabrí el ciclo para editarlas.',
        'VARIABLES_ALREADY_BILLED',
        409,
        { period, billedCycleId: existing.billedCycleId },
      );
    }

    // #23: el valor comercial se RECALCULA en el backend según la regla (DIRECTO/CALCULO); MANUAL se respeta.
    //   Nunca se confía en el número que manda el cliente para las reglas automáticas.
    const items: StatementItem[] = dto.items.map((i) => {
      const item: StatementItem = {
        label: i.label.trim(),
        usage: i.usage ?? null,
        rawValue: i.rawValue ?? null,
        commercialValue: i.commercialValue,
        source: i.source,
        mode: i.mode ?? null,
        incluidas: i.incluidas ?? null,
        unitPrice: i.unitPrice ?? null,
        op: i.op ?? null,
      };
      item.commercialValue = computeCommercial(item);
      return item;
    });
    const note = dto.note?.trim() || null;

    const statement = await this.prisma.clientBillingStatement.upsert({
      where: { clientId_period: { clientId, period } },
      create: { clientId, period, items: items as unknown as Prisma.InputJsonValue, note },
      update: { items: items as unknown as Prisma.InputJsonValue, note },
    });

    this.logger.log(`Statement upsert cliente ${clientId} período ${period}: ${items.length} items`);
    return {
      period,
      items,
      note: statement.note,
      totalCommercial: this.totalCommercial(items),
      exists: true,
    };
  }

  /** R3 AC4: elimina el statement de un período (bloqueado si ya se facturó — reabrir el ciclo lo libera). */
  async remove(orgId: string, clientId: string, period: string) {
    await this.assertClient(orgId, clientId);
    this.assertPeriod(period);
    const existing = await this.prisma.clientBillingStatement.findUnique({
      where: { clientId_period: { clientId, period } },
      select: { billedCycleId: true },
    });
    if (existing?.billedCycleId) {
      throw new AppException(
        'Las variables de este período ya se facturaron y no se pueden eliminar. Reabrí el ciclo primero.',
        'VARIABLES_ALREADY_BILLED',
        409,
        { period, billedCycleId: existing.billedCycleId },
      );
    }
    await this.prisma.clientBillingStatement.deleteMany({ where: { clientId, period } });
    this.logger.log(`Statement eliminado cliente ${clientId} período ${period}`);
    return { period, deleted: true };
  }

  /**
   * R4/R5: líneas comerciales (USD) del cliente para los períodos dados — las que el motor de ciclos
   * combina con Soporte y convierte a Gs al emitir. Devuelve solo `{label, commercialValue}` (nunca crudo).
   * El caller ya scopeó el cliente (assertClient del motor); acá no re-scopea.
   */
  async collectCommercial(
    clientId: string,
    periods: string[],
  ): Promise<{ lines: CommercialLine[]; subtotalUsd: number; contributingPeriods: string[] }> {
    if (periods.length === 0) return { lines: [], subtotalUsd: 0, contributingPeriods: [] };
    const statements = await this.prisma.clientBillingStatement.findMany({
      // #23: solo variables NO facturadas (billedCycleId null) → evita doble-cobro al re-facturar un mes.
      where: { clientId, period: { in: periods }, billedCycleId: null },
      select: { period: true, items: true },
    });
    const lines: CommercialLine[] = [];
    const contributing = new Set<string>();
    for (const s of statements) {
      for (const item of this.toItems(s.items)) {
        if (Number(item.commercialValue) > 0) {
          lines.push({ label: item.label, commercialValue: item.commercialValue });
          contributing.add(s.period);
        }
      }
    }
    const subtotalUsd = round2(lines.reduce((s, l) => s + l.commercialValue, 0));
    return { lines, subtotalUsd, contributingPeriods: [...contributing] };
  }

  /**
   * R4: total comercial (USD) NO facturado por período, para el listado de meses del generador. Solo períodos
   * con variables pendientes (billedCycleId null, commercial > 0) → así un mes solo-variables (sin soporte)
   * también se ofrece a facturar. El caller ya scopeó el cliente.
   */
  async unbilledByPeriod(clientId: string): Promise<Map<string, number>> {
    const statements = await this.prisma.clientBillingStatement.findMany({
      where: { clientId, billedCycleId: null },
      select: { period: true, items: true },
    });
    const map = new Map<string, number>();
    for (const s of statements) {
      const total = this.totalCommercial(this.toItems(s.items));
      if (total > 0) map.set(s.period, total);
    }
    return map;
  }
}

/** Redondeo monetario a 2 decimales (USD) evitando el ruido binario. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * #23 — Fórmula ÚNICA del valor comercial según la regla de la variable (fuente de verdad server-side):
 *  - DIRECTO: comercial = crudo (traspaso directo del costo de Botmaker).
 *  - CALCULO: cobrables = max(0, usage − incluidas); MULT (default) → cobrables × unitPrice;
 *    DIV → cobrables ÷ unitPrice (unitPrice = divisor en unidades por USD, p. ej. tokens por dólar).
 *    DIV con divisor 0 → 0 (nunca división por cero).
 *  - MANUAL / sin regla: se respeta el comercial tipeado (fee fijo, override).
 * (El frontend replica esta fórmula para el cálculo en vivo; el backend la re-aplica al guardar/importar.)
 */
export function computeCommercial(item: {
  mode?: PricingMode | null;
  rawValue?: number | null;
  usage?: number | null;
  incluidas?: number | null;
  unitPrice?: number | null;
  op?: PricingOp | null;
  commercialValue?: number | null;
}): number {
  if (item.mode === 'DIRECTO') return round2(Number(item.rawValue) || 0);
  if (item.mode === 'CALCULO') {
    const cobrable = Math.max(0, (Number(item.usage) || 0) - (Number(item.incluidas) || 0));
    const factor = Number(item.unitPrice) || 0;
    if (item.op === 'DIV') return factor > 0 ? round2(cobrable / factor) : 0;
    return round2(cobrable * factor);
  }
  return round2(Number(item.commercialValue) || 0); // MANUAL / sin regla
}
