import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { InvoiceService } from './billing.service';

@Module({
  controllers: [BillingController],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class BillingModule {}
