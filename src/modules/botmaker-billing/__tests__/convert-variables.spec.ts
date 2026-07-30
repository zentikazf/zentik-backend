import { buildVariablesStamp } from '../exchange-rate/convert-variables';

/**
 * #23 — Conversión USD→PYG + estampado inmutable. Pura y determinística (Decimal.js). El total es la suma
 * de las líneas YA redondeadas → siempre cuadra con el desglose (no se redondea el total aparte).
 */
describe('buildVariablesStamp (#23)', () => {
  const date = new Date('2026-07-28T10:00:00.000Z');

  it('convierte cada línea (USD × tasa → Gs sin decimales) y suma exacto', () => {
    const { stamp, amountPyg } = buildVariablesStamp(
      [
        { label: 'SESSIONS', commercialValue: 875.17 },
        { label: 'FEE', commercialValue: 299 },
      ],
      7300,
      date,
      'PYG',
    );

    expect(stamp.lines).toEqual([
      { label: 'SESSIONS', commercialUsd: '875.17', convertedPyg: '6388741' }, // 875.17 * 7300
      { label: 'FEE', commercialUsd: '299', convertedPyg: '2182700' }, // 299 * 7300
    ]);
    expect(stamp.amountPyg).toBe('8571441'); // 6388741 + 2182700
    expect(amountPyg.toString()).toBe('8571441');
    expect(stamp.rate).toBe('7300');
    expect(stamp.currency).toBe('PYG');
    expect(stamp.rateDate).toBe('2026-07-28T10:00:00.000Z');
  });

  it('sin líneas → total 0 y lines vacío', () => {
    const { stamp, amountPyg } = buildVariablesStamp([], 7300, date, 'PYG');
    expect(stamp.amountPyg).toBe('0');
    expect(amountPyg.toString()).toBe('0');
    expect(stamp.lines).toEqual([]);
  });

  it('redondea a Gs sin decimales por línea', () => {
    const { stamp } = buildVariablesStamp([{ label: 'X', commercialValue: 1.005 }], 7000.5, date, 'PYG');
    // 1.005 * 7000.5 = 7035.5025 → 7036 (redondeo a 0 decimales)
    expect(stamp.lines[0].convertedPyg).toBe('7036');
  });
});
