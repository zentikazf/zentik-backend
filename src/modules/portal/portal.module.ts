import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { FileModule } from '../file/file.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { OutboxModule } from '../sync/outbox.module';

@Module({
  imports: [PrismaModule, AuditModule, FileModule, StorageModule, OutboxModule],
  controllers: [PortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
