import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AppConfigModule } from '../../config/config.module';
import { AuditModule } from '../audit/audit.module';
import { ClientBillingController } from './client-billing.controller';
import { ClientBillingService } from './client-billing.service';
import { ClientBillingPdfService } from './client-billing-pdf.service';

@Module({
  imports: [PrismaModule, AppConfigModule, AuditModule],
  controllers: [ClientBillingController],
  providers: [ClientBillingService, ClientBillingPdfService],
})
export class ClientBillingModule {}
