import { Prisma } from '@prisma/client';
import { computeTax, parseTaxMode, formatTaxRatePercent } from '../client-billing-tax.util';

/**
 * #63 — Tests del cálculo del IVA. Función pura: sin Prisma, sin DB, sin mocks.
 *
 * La aserción que se repite en TODOS los casos es `net + tax === total` EXACTO. No es ceremonia: es
 * la invariante que hace que el PDF cierre. Se cumple porque cada modo redondea UN solo término y
 * saca el otro por resta; si alguien "prolijea" el código redondeando los dos, estos tests caen.
 */
describe('computeTax (#63)', () => {
  const D = (s: string) => new Prisma.Decimal(s);
  const IVA_10 = D('0.1000');

  /** La invariante del spec, en un helper para que ningún caso se olvide de chequearla. */
  function esperaIdentidad(r: { netAmount: Prisma.Decimal | null; taxAmount: Prisma.Decimal | null; totalAmount: Prisma.Decimal }) {
    expect(r.netAmount).not.toBeNull();
    expect(r.taxAmount).not.toBeNull();
    expect(r.netAmount!.plus(r.taxAmount!).toString()).toBe(r.totalAmount.toString());
  }

  describe('EXCLUDED — la tarifa es neta, el IVA se suma', () => {
    it('net = la base de hoy · total = net × 1,1 · net + tax = total exacto', () => {
      const r = computeTax(D('1000000'), IVA_10, 'EXCLUDED');

      expect(r.netAmount!.toString()).toBe('1000000'); // la base NO se toca
      expect(r.taxAmount!.toString()).toBe('100000');
      expect(r.totalAmount.toString()).toBe('1100000'); // EL TOTAL CRECE 10%
      esperaIdentidad(r);
    });

    it('la tarifa del ejemplo del dueño: 90.000 + 9.000 = 99.000', () => {
      const r = computeTax(D('90000'), IVA_10, 'EXCLUDED');
      expect(r.netAmount!.toString()).toBe('90000');
      expect(r.taxAmount!.toString()).toBe('9000');
      expect(r.totalAmount.toString()).toBe('99000');
      esperaIdentidad(r);
    });

    it('con base que no divide exacto, el IVA se redondea y el total sale por SUMA (sigue cerrando)', () => {
      // 333.333,33 × 0,10 = 33.333,333 → 33.333,33 (HALF_UP a 2 decimales)
      const r = computeTax(D('333333.33'), IVA_10, 'EXCLUDED');
      expect(r.taxAmount!.toString()).toBe('33333.33');
      expect(r.totalAmount.toString()).toBe('366666.66');
      esperaIdentidad(r);
    });
  });

  describe('INCLUDED — la tarifa ya trae el IVA adentro', () => {
    it('NO-REGRESIÓN: el total es IDÉNTICO al que da el sistema sin IVA', () => {
      const base = D('1000000');
      const sinIva = computeTax(base, null, null);
      const included = computeTax(base, IVA_10, 'INCLUDED');

      // Éste es el punto del modo: prenderlo NO mueve un guaraní de lo que el cliente paga.
      expect(included.totalAmount.toString()).toBe(sinIva.totalAmount.toString());
      expect(included.totalAmount.toString()).toBe('1000000');
      esperaIdentidad(included);
    });

    it('REDONDEO (el caso del spec): 1.000.000 al 10% → 909.090,91 + 90.909,09', () => {
      const r = computeTax(D('1000000'), IVA_10, 'INCLUDED');

      // 1.000.000 / 1,1 = 909.090,9090… → HALF_UP a 2 decimales
      expect(r.netAmount!.toString()).toBe('909090.91');
      // …y el IVA sale POR RESTA, no de un segundo redondeo: 1.000.000 − 909.090,91
      expect(r.taxAmount!.toString()).toBe('90909.09');
      expect(r.totalAmount.toString()).toBe('1000000');
      esperaIdentidad(r);
    });

    it('la tarifa del ejemplo del dueño: 90.000 → 81.818,18 + 8.181,82', () => {
      const r = computeTax(D('90000'), IVA_10, 'INCLUDED');
      expect(r.netAmount!.toString()).toBe('81818.18');
      expect(r.taxAmount!.toString()).toBe('8181.82');
      expect(r.totalAmount.toString()).toBe('90000');
      esperaIdentidad(r);
    });
  });

  describe('sin IVA — el NULL es el apagado', () => {
    it('taxRate null → los tres campos nuevos en null y el total IDÉNTICO a la base', () => {
      const r = computeTax(D('1234567.89'), null, null);
      expect(r.netAmount).toBeNull();
      expect(r.taxAmount).toBeNull();
      expect(r.totalAmount.toString()).toBe('1234567.89');
    });

    it('taxRate cargado pero modo null o desconocido → sin IVA (fail-safe, no se inventa un modo)', () => {
      for (const modo of [null, undefined, '', 'INCLUIDO', 'excluded']) {
        const r = computeTax(D('1000000'), IVA_10, modo);
        expect(r.netAmount).toBeNull();
        expect(r.totalAmount.toString()).toBe('1000000');
      }
    });

    it('tasa 0 → sin IVA, no un desglose de IVA cero (que ensuciaría el PDF con "IVA (0%)")', () => {
      const r = computeTax(D('1000000'), D('0'), 'EXCLUDED');
      expect(r.netAmount).toBeNull();
      expect(r.taxAmount).toBeNull();
      expect(r.totalAmount.toString()).toBe('1000000');
    });

    it('base 0 con IVA prendido → sigue cerrando (factura de solo variables aún sin convertir)', () => {
      const r = computeTax(D('0'), IVA_10, 'EXCLUDED');
      expect(r.totalAmount.toString()).toBe('0');
      esperaIdentidad(r);
    });
  });

  it('la identidad net + tax = total se cumple en un barrido de bases y tasas', () => {
    // Barrido deliberadamente feo: bases con centavos, tasas que no son 10%. Si algún día alguien
    // redondea los dos términos, acá aparecen las diferencias de 1 Gs que no cierran contra el PDF.
    for (const base of ['1', '7', '99.99', '100000.01', '333333.33', '987654321.12']) {
      for (const rate of ['0.1000', '0.0500', '0.1050']) {
        for (const mode of ['EXCLUDED', 'INCLUDED'] as const) {
          const r = computeTax(D(base), D(rate), mode);
          expect(r.netAmount!.plus(r.taxAmount!).toString()).toBe(r.totalAmount.toString());
          // Y el término autoritativo de cada modo queda intacto (no se redondea "de rebote").
          if (mode === 'EXCLUDED') expect(r.netAmount!.toString()).toBe(D(base).toString());
          else expect(r.totalAmount.toString()).toBe(D(base).toString());
        }
      }
    }
  });

  describe('helpers', () => {
    it('parseTaxMode acepta los dos modos y descarta cualquier otra cosa', () => {
      expect(parseTaxMode('EXCLUDED')).toBe('EXCLUDED');
      expect(parseTaxMode('INCLUDED')).toBe('INCLUDED');
      expect(parseTaxMode('OTRO')).toBeNull();
      expect(parseTaxMode(null)).toBeNull();
      expect(parseTaxMode(undefined)).toBeNull();
    });

    it('formatTaxRatePercent: fracción → porcentaje sin ceros de relleno', () => {
      expect(formatTaxRatePercent(D('0.1000'))).toBe('10');
      expect(formatTaxRatePercent(D('0.0500'))).toBe('5');
      expect(formatTaxRatePercent(D('0.1050'))).toBe('10,5');
    });
  });
});
