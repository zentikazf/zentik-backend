import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { ClientController } from './client.controller';
import { ClientService } from './client.service';
import { HoursListener } from './hours.listener';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ClientController],
  providers: [ClientService, HoursListener],
  exports: [ClientService],
})
export class ClientModule {}
