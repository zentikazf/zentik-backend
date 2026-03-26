import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { ClientController } from './client.controller';
import { ClientService } from './client.service';

@Module({
  imports: [PrismaModule],
  controllers: [ClientController],
  providers: [ClientService],
  exports: [ClientService],
})
export class ClientModule {}
