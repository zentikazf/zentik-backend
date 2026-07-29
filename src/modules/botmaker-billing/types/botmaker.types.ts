// #23 — Contrato del payload de Botmaker (GET /v2.0/billing/consumptions).
//
// El payload REAL difiere del doc oficial: `balance`/`totalSpend` son ARRAYS de
// `{ total, currency }` (multi-moneda), y `productUsage` REPITE el mismo `productId`
// (hay que sumar `usage` + `totalSpend` por producto). Los montos están en USD.
// `accountId` es la clave de mapeo (ej. Fortaleza `IC0XXEN8LOZW38EW2XP2`).
//
// Los tipos crudos son deliberadamente laxos (todo opcional) porque el upstream no
// garantiza la forma; el normalizador (botmaker-billing.service) es el que endurece.

export interface BotmakerMoney {
  total?: number | string;
  currency?: string;
}

export interface BotmakerRawProductUsage {
  productId?: string;
  usage?: number | string;
  // Puede venir como número plano o como array multi-moneda (defensivo).
  totalSpend?: number | string | BotmakerMoney[];
}

export interface BotmakerRawAccount {
  accountId?: string;
  accountName?: string;
  accountAlias?: string;
  balance?: BotmakerMoney[] | number | string;
  totalSpend?: BotmakerMoney[] | number | string;
  productUsage?: BotmakerRawProductUsage[];
}

/**
 * Respuesta cruda. Botmaker puede devolver una cuenta "madre" con sub-cuentas anidadas
 * bajo distintas claves según versión. Se contemplan las variantes conocidas; el
 * normalizador aplana todo a una lista de cuentas.
 */
export interface BotmakerConsumptionsResponse extends BotmakerRawAccount {
  accounts?: BotmakerRawAccount[];
  childAccounts?: BotmakerRawAccount[];
  subAccounts?: BotmakerRawAccount[];
}

// ── Tipado interno normalizado (lo único que sale del service) ──────────────

export interface NormalizedProduct {
  productId: string;
  usage: number;
  totalSpend: number; // USD
}

export interface NormalizedAccount {
  accountId: string;
  accountName: string;
  accountAlias: string;
  totalSpend: number; // USD (suma de productos)
  products: NormalizedProduct[];
}
