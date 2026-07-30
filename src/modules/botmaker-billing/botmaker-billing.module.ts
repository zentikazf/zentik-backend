import { Module } from '@nestjs/common';
import { BotmakerBillingController } from './botmaker-billing.controller';
import { BotmakerClientService } from './botmaker-client.service';
import { BotmakerBillingService } from './botmaker-billing.service';
import { BillingVariablesService } from './billing-variables.service';
import { EXCHANGE_RATE_PROVIDER } from './exchange-rate/exchange-rate.provider';
import { SimulatedExchangeRateProvider } from './exchange-rate/simulated-exchange-rate.provider';

/**
 * Feature #23 — Variables de facturación (Botmaker) + tasa de cambio pluggable.
 * PrismaModule / RedisModule / AppConfigModule son @Global → no se importan.
 * Exporta `BillingVariablesService` + `EXCHANGE_RATE_PROVIDER` para que el motor de ciclos
 * (ClientBillingModule) combine las variables con Soporte y convierta al emitir.
 */
@Module({
  controllers: [BotmakerBillingController],
  providers: [
    BotmakerClientService,
    BotmakerBillingService,
    BillingVariablesService,
    { provide: EXCHANGE_RATE_PROVIDER, useClass: SimulatedExchangeRateProvider },
  ],
  exports: [BillingVariablesService, EXCHANGE_RATE_PROVIDER],
})
export class BotmakerBillingModule {}
