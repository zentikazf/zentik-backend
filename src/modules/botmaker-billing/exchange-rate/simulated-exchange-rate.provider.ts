import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../config/app.config';
import { ExchangeRateProvider } from './exchange-rate.provider';

/**
 * Impl SIMULADA v1 (D2): devuelve la tasa de `EXCHANGE_RATE_SIMULATED` como sugerencia. La integración
 * real con DNIT (auto-fetch de la tasa del día) es fase 2 — se implementa otra clase con esta misma
 * interfaz y se cambia el `useClass` del token `EXCHANGE_RATE_PROVIDER`, sin tocar nada más.
 *
 * ponytail: sin auto-fetch FX en v1 (dep/red/failure modes que no aportan mientras la tasa la revisa el
 * admin a mano en el preview). Se agrega en fase 2 junto con DNIT.
 */
@Injectable()
export class SimulatedExchangeRateProvider implements ExchangeRateProvider {
  constructor(private readonly config: AppConfigService) {}

  async getRate(_date: Date, from = 'USD', to = 'PYG'): Promise<number | null> {
    if (from === to) return 1;
    return this.config.exchangeRateSimulated ?? null;
  }
}
