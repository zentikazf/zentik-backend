import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { FileModule } from '../file/file.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { OutboxModule } from '../sync/outbox.module';
import { ClientBillingModule } from '../client-billing/client-billing.module';

@Module({
  imports: [PrismaModule, AuditModule, FileModule, StorageModule, OutboxModule, ClientBillingModule],
  controllers: [PortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
