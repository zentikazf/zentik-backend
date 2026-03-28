import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { OrgMembershipService } from './org-membership.service';
import { InviteService } from './invite.service';

@Module({
  imports: [PrismaModule],
  controllers: [OrganizationController],
  providers: [OrganizationService, OrgMembershipService, InviteService],
  exports: [OrganizationService, OrgMembershipService, InviteService],
})
export class OrganizationModule {}
