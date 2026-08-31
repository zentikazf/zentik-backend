import { Prisma } from '@prisma/client';

/**
 * #63 — El cálculo del IVA de una factura, en UN SOLO LUGAR.
 *
 * Función pura (sin Prisma, sin I/O, testeable sola) compartida por las TRES bocas que hoy
 * necesitan el número: el preview (`previewCycle`), la emisión (`closeCycle`) y la nota de
 * crédito (`emitCreditNote`). Que sea una sola no es prolijidad: si el preview y la emisión lo
 * calcularan por su cuenta, en algún redondeo se separarían y el admin leería un total y
 * firmaría otro.
 *
 * ⚠️ EL IVA VIVE EN LA FACTURA, NO EN LA HORA. `HoursTransaction.priceAmount` no se toca nunca —
 * es neto siempre, en toda la historia, y está congelado en todo el histórico de producción. El
 * IVA es propiedad del DOCUMENTO fiscal: la misma hora facturada a dos clientes con régimen
 * distinto lleva IVA distinto. Por eso esto recibe una BASE ya sumada y devuelve tres montos de
 * factura; no hay ningún camino por el que un IVA termine escrito en una transacción de horas.
 */

/** Modos de precio. `EXCLUDED` = la tarifa es neta y el IVA se suma; `INCLUDED` = la tarifa ya lo trae. */
export const TAX_MODES = ['EXCLUDED', 'INCLUDED'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

/** Precisión de las columnas de plata (`Decimal(15,2)`). Se redondea a esto, ni más ni menos. */
const MONEY_DP = 2;

/**
 * Los tres montos de un documento. Los tres NULL cuando no hay IVA (`taxRate == null`), que es el
 * estado de todo lo emitido antes de #63 y de todo cliente que no haya prendido el toggle:
 * `null` es el apagado, y con él `totalAmount` sale idéntico a lo que salía siempre.
 */
export interface TaxBreakdown {
  netAmount: Prisma.Decimal | null;
  taxAmount: Prisma.Decimal | null;
  /** Lo que el cliente paga. SIEMPRE viene con valor: sin IVA es la base tal cual. */
  totalAmount: Prisma.Decimal;
}

/** `'EXCLUDED' | 'INCLUDED'` o null — cualquier otro string se trata como sin IVA (fail-safe). */
export function parseTaxMode(mode: string | null | undefined): TaxMode | null {
  return mode != null && (TAX_MODES as readonly string[]).includes(mode) ? (mode as TaxMode) : null;
}

/**
 * Descompone una base imponible en neto + IVA + total según el modo del documento.
 *
 * `base` = lo que hoy es `totalAmount` al emitir: `Σ priceAmount` (soporte) + `variablesAmountPyg`
 * (#23, YA convertido USD→PYG con la tasa estampada). El orden importa y queda escrito: primero se
 * convierte el USD, después se aplica el IVA. Al revés daría un IVA calculado sobre dólares y
 * después convertido — que con una sola tasa da el mismo número por casualidad y se rompe apenas
 * haya un redondeo intermedio distinto.
 *
 *   EXCLUDED  net = base            tax = round(net × rate)      total = net + tax   ← el total CRECE
 *   INCLUDED  total = base          net = round(total / (1+rate)) tax = total − net   ← el total NO se mueve
 *
 * ⚠️ SE REDONDEA UN SOLO TÉRMINO POR MODO; el otro sale POR RESTA. Así la identidad
 * `total === net + tax` se cumple POR CONSTRUCCIÓN, no por chequeo. Redondear los dos "por
 * prolijidad" es exactamente de donde salen las diferencias de 1 Gs que después no cierran contra
 * el PDF. Toda la aritmética con `Prisma.Decimal`: ni un `number` en el camino.
 *
 * Sin IVA (`taxRate` null, `taxMode` inválido o rate ≤ 0) devuelve `total = base` y los otros dos
 * en null — el comportamiento previo a #63, byte a byte.
 */
export function computeTax(
  base: Prisma.Decimal,
  taxRate: Prisma.Decimal | null | undefined,
  taxMode: string | null | undefined,
): TaxBreakdown {
  const mode = parseTaxMode(taxMode);
  // Fail-safe deliberado: sin tasa, sin modo reconocido o con tasa no positiva, NO se inventa IVA.
  // El caso `rate <= 0` no debería llegar (la UI no lo ofrece), pero un 0 guardado a mano tiene que
  // significar "sin IVA" y no un desglose de IVA cero, que ensuciaría el PDF con una línea "IVA (0%)".
  if (taxRate == null || mode == null || taxRate.lte(0)) {
    return { netAmount: null, taxAmount: null, totalAmount: base };
  }

  if (mode === 'EXCLUDED') {
    // La tarifa cargada es NETA: el IVA se suma encima y el total sube.
    const netAmount = base;
    const taxAmount = netAmount.times(taxRate).toDecimalPlaces(MONEY_DP, Prisma.Decimal.ROUND_HALF_UP);
    return { netAmount, taxAmount, totalAmount: netAmount.plus(taxAmount) }; // total por SUMA
  }

  // INCLUDED — la tarifa cargada YA trae el IVA adentro: el total es autoritativo y no se mueve.
  const totalAmount = base;
  const netAmount = totalAmount
    .dividedBy(new Prisma.Decimal(1).plus(taxRate))
    .toDecimalPlaces(MONEY_DP, Prisma.Decimal.ROUND_HALF_UP);
  return { netAmount, taxAmount: totalAmount.minus(netAmount), totalAmount }; // tax por RESTA
}

/** `0.1000` → `'10'` para la etiqueta "IVA (10%)". Sin ceros de relleno: 0.1050 → '10,5'. */
export function formatTaxRatePercent(taxRate: Prisma.Decimal): string {
  return taxRate.times(100).toDecimalPlaces(2).toString().replace('.', ',');
}
