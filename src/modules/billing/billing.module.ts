import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { InvoiceService, InvoiceGeneratorService } from './billing.service';

@Module({
  controllers: [BillingController],
  providers: [InvoiceService, InvoiceGeneratorService],
  exports: [InvoiceService, InvoiceGeneratorService],
})
export class BillingModule {}
