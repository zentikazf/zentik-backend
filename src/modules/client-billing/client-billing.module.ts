import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AppConfigModule } from '../../config/config.module';
import { AuditModule } from '../audit/audit.module';
import { BotmakerBillingModule } from '../botmaker-billing/botmaker-billing.module';
import { ClientBillingController } from './client-billing.controller';
import { ClientBillingService } from './client-billing.service';
import { ClientBillingPdfService } from './client-billing-pdf.service';

@Module({
  // #23: BotmakerBillingModule exporta BillingVariablesService + EXCHANGE_RATE_PROVIDER para combinar las
  //   variables con Soporte y convertir al emitir. Dependencia unidireccional (Botmaker no importa acá) → sin ciclo.
  imports: [PrismaModule, AppConfigModule, AuditModule, BotmakerBillingModule],
  controllers: [ClientBillingController],
  providers: [ClientBillingService, ClientBillingPdfService],
  exports: [ClientBillingPdfService],
})
export class ClientBillingModule {}
