import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AppConfigService } from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { BotmakerClientService } from './botmaker-client.service';
import {
  BotmakerConsumptionsResponse,
  BotmakerMoney,
  BotmakerRawAccount,
  NormalizedAccount,
  NormalizedProduct,
} from './types/botmaker.types';

const CACHE_PREFIX = 'botmaker:billing:';

/** Ítem de variable prellenado desde Botmaker (no persistido; alimenta el editor). */
export interface ImportedVariableItem {
  label: string;
  rawValue: number; // USD crudo del GET
  commercialValue: number; // 0 — el admin lo edita
  source: 'BOTMAKER';
}

/** Cuenta normalizada para el select de mapeo, con marca de si ya está mapeada a un cliente. */
export interface AccountOption {
  accountId: string;
  accountName: string;
  accountAlias: string;
  totalSpend: number;
  mappedTo: { clientId: string; clientName: string } | null;
}

/**
 * Normalización + cache del consumo Botmaker (feature #23) — SOLO camino admin.
 *
 * Endurece el payload crudo (arrays multi-moneda + productId duplicado → suma) a un tipado interno.
 * Cachea el consumo por período en Redis (TTL configurable) con fallback in-memory. El crudo (todas las
 * cuentas + balance madre) NUNCA sale del admin: el portal lee solo `client_billing_statements`.
 */
@Injectable()
export class BotmakerBillingService {
  private readonly logger = new Logger(BotmakerBillingService.name);
  /** Fallback in-memory del consumo normalizado si Redis no está disponible. */
  private memCache = new Map<string, { value: NormalizedAccount[]; expiresAt: number }>();

  constructor(
    private readonly client: BotmakerClientService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // ── API pública ──────────────────────────────────────────────────────────

  /**
   * R3 AC1: cuentas normalizadas para el select de mapeo, marcando cuáles ya están mapeadas a un cliente
   * de la org. Con el flag off devuelve `{ enabled:false, accounts:[] }` (no llama a Botmaker).
   */
  async listAccounts(orgId: string, period: string): Promise<{ enabled: boolean; accounts: AccountOption[] }> {
    if (!this.config.botmakerBillingEnabled) return { enabled: false, accounts: [] };
    this.assertPeriod(period);
    const normalized = await this.getNormalized(period);

    // Marca de mapeo: clientes de la org cuyo botmakerAccountId ∈ las cuentas traídas.
    const accountIds = normalized.map((a) => a.accountId);
    const mapped = accountIds.length
      ? await this.prisma.client.findMany({
          where: { organizationId: orgId, botmakerAccountId: { in: accountIds } },
          select: { id: true, name: true, botmakerAccountId: true },
        })
      : [];
    const byAccount = new Map(mapped.map((c) => [c.botmakerAccountId!, { clientId: c.id, clientName: c.name }]));

    const accounts = normalized
      .map((a) => ({
        accountId: a.accountId,
        accountName: a.accountName,
        accountAlias: a.accountAlias,
        totalSpend: a.totalSpend,
        mappedTo: byAccount.get(a.accountId) ?? null,
      }))
      .sort((x, y) => y.totalSpend - x.totalSpend);

    return { enabled: true, accounts };
  }

  /**
   * R3 AC3: prellena el editor con las variables de la cuenta mapeada (crudo del GET). NO persiste.
   * Cada producto con gasto → item `{label, rawValue, commercialValue:0, source:'BOTMAKER'}`.
   */
  async importVariables(accountId: string, period: string): Promise<ImportedVariableItem[]> {
    if (!this.config.botmakerBillingEnabled) {
      throw new AppException(
        'La facturación de Botmaker está deshabilitada',
        'BOTMAKER_DISABLED',
        409,
      );
    }
    this.assertPeriod(period);
    if (!accountId) {
      throw new AppException('El cliente no tiene una cuenta Botmaker mapeada', 'BOTMAKER_ACCOUNT_UNMAPPED', 400);
    }
    const normalized = await this.getNormalized(period);
    const account = normalized.find((a) => a.accountId === accountId);
    if (!account) {
      throw new AppException(
        'La cuenta mapeada no aparece en el consumo de Botmaker para este período',
        'BOTMAKER_ACCOUNT_NOT_FOUND',
        404,
        { accountId, period },
      );
    }
    return account.products
      .filter((p) => p.totalSpend > 0)
      .map((p) => ({
        label: p.productId,
        rawValue: p.totalSpend,
        commercialValue: 0,
        source: 'BOTMAKER' as const,
      }));
  }

  // ── Cache + normalización ─────────────────────────────────────────────────

  private async getNormalized(period: string): Promise<NormalizedAccount[]> {
    const cached = await this.readCache(period);
    if (cached) return cached;

    const raw = await this.client.fetchConsumptions(period);
    const normalized = this.normalize(raw);
    await this.writeCache(period, normalized);
    return normalized;
  }

  /** Aplana la cuenta madre + sub-cuentas anidadas y normaliza cada una (dedupe por accountId). */
  private normalize(payload: BotmakerConsumptionsResponse): NormalizedAccount[] {
    const nested = [
      ...(payload.accounts ?? []),
      ...(payload.childAccounts ?? []),
      ...(payload.subAccounts ?? []),
    ];
    // La cuenta "madre" (top-level) cuenta solo si trae accountId propio.
    const all: BotmakerRawAccount[] = payload.accountId ? [payload, ...nested] : nested;

    const byId = new Map<string, NormalizedAccount>();
    for (const rawAccount of all) {
      const norm = this.normalizeAccount(rawAccount);
      if (!norm) continue;
      // Dedupe: si el mismo accountId aparece dos veces, gana el de mayor gasto (defensivo).
      const existing = byId.get(norm.accountId);
      if (!existing || norm.totalSpend > existing.totalSpend) byId.set(norm.accountId, norm);
    }
    return [...byId.values()];
  }

  private normalizeAccount(raw: BotmakerRawAccount): NormalizedAccount | null {
    const accountId = typeof raw.accountId === 'string' ? raw.accountId : '';
    if (!accountId) return null;

    // productUsage REPITE productId → sumar usage + totalSpend por producto.
    const byProduct = new Map<string, NormalizedProduct>();
    for (const pu of raw.productUsage ?? []) {
      const productId = typeof pu.productId === 'string' ? pu.productId : '';
      if (!productId) continue;
      const acc = byProduct.get(productId) ?? { productId, usage: 0, totalSpend: 0 };
      acc.usage += this.toNumber(pu.usage);
      acc.totalSpend = round2(acc.totalSpend + this.moneyToUsd(pu.totalSpend));
      byProduct.set(productId, acc);
    }
    const products = [...byProduct.values()];
    // totalSpend de la cuenta: el del payload si viene, si no la suma de productos.
    const declared = this.moneyToUsd(raw.totalSpend);
    const totalSpend = declared > 0 ? declared : round2(products.reduce((s, p) => s + p.totalSpend, 0));

    return {
      accountId,
      accountName: typeof raw.accountName === 'string' ? raw.accountName : accountId,
      accountAlias: typeof raw.accountAlias === 'string' && raw.accountAlias ? raw.accountAlias : (raw.accountName ?? accountId),
      totalSpend,
      products,
    };
  }

  /**
   * Monto → total USD. El payload REAL usa DISTINTAS formas según el campo:
   *  - `accounts[].totalSpend` = ARRAY multi-moneda `[{total,currency}]` (suma las USD)
   *  - `productUsage[].totalSpend` = OBJETO ÚNICO `{total,currency}` (el que hacía dar 0)
   *  - a veces número/string plano
   * Se contemplan las tres.
   */
  private moneyToUsd(value: BotmakerMoney | BotmakerMoney[] | number | string | undefined): number {
    if (value == null) return 0;
    if (Array.isArray(value)) {
      const usd = value.filter((m) => (m.currency ?? 'USD').toUpperCase() === 'USD');
      const pool = usd.length > 0 ? usd : value; // sin marca de moneda → asumir USD
      return round2(pool.reduce((s, m) => s + this.toNumber(m.total), 0));
    }
    if (typeof value === 'object') {
      // Objeto único { total, currency } (productUsage[].totalSpend en el payload real).
      return round2(this.toNumber(value.total));
    }
    return round2(this.toNumber(value));
  }

  private toNumber(v: number | string | undefined | null): number {
    if (v == null) return 0;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  private assertPeriod(period: string): void {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new AppException('El período debe tener formato YYYY-MM', 'INVALID_PERIOD', 400, { period });
    }
  }

  private async readCache(period: string): Promise<NormalizedAccount[] | null> {
    try {
      const hit = await this.redis.get(CACHE_PREFIX + period);
      if (hit) return JSON.parse(hit) as NormalizedAccount[];
    } catch {
      // Redis caído → fallback in-memory.
    }
    const mem = this.memCache.get(period);
    if (mem && mem.expiresAt > Date.now()) return mem.value;
    return null;
  }

  private async writeCache(period: string, value: NormalizedAccount[]): Promise<void> {
    const ttl = this.config.botmakerCacheTtlSec;
    this.memCache.set(period, { value, expiresAt: Date.now() + ttl * 1000 });
    try {
      await this.redis.set(CACHE_PREFIX + period, JSON.stringify(value), 'EX', ttl);
    } catch {
      // Redis caído → ya quedó en memCache.
    }
  }
}

/** Redondeo monetario a 2 decimales (USD) evitando el ruido binario (0.1+0.2). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
