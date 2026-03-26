import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { InviteService } from './invite.service';

@Module({
  imports: [PrismaModule],
  controllers: [OrganizationController],
  providers: [OrganizationService, InviteService],
  exports: [OrganizationService, InviteService],
})
export class OrganizationModule {}
