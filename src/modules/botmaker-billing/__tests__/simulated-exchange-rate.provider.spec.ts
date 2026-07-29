import { SimulatedExchangeRateProvider } from '../exchange-rate/simulated-exchange-rate.provider';
import { AppConfigService } from '../../../config/app.config';

/** #23 — Provider de tasa simulado (v1): devuelve la config; 1 si from===to; null si no hay tasa. */
describe('SimulatedExchangeRateProvider (#23)', () => {
  const withRate = (rate: number | undefined) =>
    new SimulatedExchangeRateProvider({ exchangeRateSimulated: rate } as unknown as AppConfigService);
  const now = new Date('2026-07-28T00:00:00.000Z');

  it('devuelve la tasa configurada para USD→PYG', async () => {
    expect(await withRate(7300).getRate(now, 'USD', 'PYG')).toBe(7300);
  });

  it('devuelve 1 cuando la moneda origen y destino coinciden', async () => {
    expect(await withRate(7300).getRate(now, 'USD', 'USD')).toBe(1);
  });

  it('devuelve null si no hay tasa configurada (el admin la pega a mano)', async () => {
    expect(await withRate(undefined).getRate(now, 'USD', 'PYG')).toBeNull();
  });
});
