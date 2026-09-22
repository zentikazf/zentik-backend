import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { ClientBillingModule } from '../client-billing/client-billing.module';
import { ClientController } from './client.controller';
import { ClientService } from './client.service';
import { HoursListener } from './hours.listener';

@Module({
  // #72 A: ClientBillingModule aporta `getHoursBillingRollup` (las tres cards de tiempos). Va en
  //   esa direccion y no al reves: el motor de facturacion ya tiene `buildFacturableWhere`, los
  //   ciclos con sus notas de credito y `assertClient`, y no sabe nada de ClientModule.
  imports: [PrismaModule, AuditModule, ClientBillingModule],
  controllers: [ClientController],
  providers: [ClientService, HoursListener],
  exports: [ClientService],
})
export class ClientModule {}
