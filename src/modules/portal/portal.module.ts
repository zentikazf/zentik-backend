import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AppConfigModule } from '../../config/config.module';
import { AuditModule } from '../audit/audit.module';
import { FileModule } from '../file/file.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { OutboxModule } from '../sync/outbox.module';
import { ClientBillingModule } from '../client-billing/client-billing.module';
import { SlaModule } from '../sla/sla.module';

@Module({
  // SlaModule (#42 Fase 1): expone SlaResolverService. Unidireccional (sla NO importa
  // portal) → sin ciclo. AppConfigModule: el feature flag `slaCascadeEnabled`.
  imports: [
    PrismaModule,
    AppConfigModule,
    AuditModule,
    FileModule,
    StorageModule,
    OutboxModule,
    ClientBillingModule,
    SlaModule,
  ],
  controllers: [PortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
