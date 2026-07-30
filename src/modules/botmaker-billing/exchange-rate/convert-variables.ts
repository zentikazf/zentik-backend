import { Prisma } from '@prisma/client';

/** Línea comercial mínima (USD) que se convierte a la moneda de la factura. */
export interface ConvertibleLine {
  label: string;
  commercialValue: number; // USD
}

/** Estampado inmutable de variables + tasa (montos como string). null-lines si no hay variables. */
export interface VariablesStamp {
  amountPyg: string;
  currency: string;
  rate: string;
  rateDate: string; // ISO
  lines: Array<{ label: string; commercialUsd: string; convertedPyg: string }>;
}

/**
 * #23 — Convierte líneas comerciales (USD) a la moneda de la factura con la tasa dada y arma el estampado.
 * Por línea: convertedPyg = redondeo(USD × tasa) a 0 decimales (Gs). El total es la suma EXACTA de las
 * líneas ya redondeadas (no redondea el total aparte → el total siempre cuadra con el desglose). Pura y
 * determinística (Decimal.js, sin I/O) → unit-testeable.
 */
export function buildVariablesStamp(
  lines: ConvertibleLine[],
  rate: number,
  rateDate: Date,
  currency: string,
): { stamp: VariablesStamp; amountPyg: Prisma.Decimal } {
  let amount = new Prisma.Decimal(0);
  const stampLines = lines.map((l) => {
    const converted = new Prisma.Decimal(l.commercialValue).mul(rate).toDecimalPlaces(0);
    amount = amount.plus(converted);
    return {
      label: l.label,
      commercialUsd: new Prisma.Decimal(l.commercialValue).toString(),
      convertedPyg: converted.toString(),
    };
  });
  return {
    stamp: {
      amountPyg: amount.toString(),
      currency,
      rate: String(rate),
      rateDate: rateDate.toISOString(),
      lines: stampLines,
    },
    amountPyg: amount,
  };
}
