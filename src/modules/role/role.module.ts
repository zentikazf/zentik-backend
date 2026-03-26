import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { RoleController } from './role.controller';
import { RoleService } from './role.service';
import { PermissionService } from './permission.service';

@Module({
  imports: [PrismaModule],
  controllers: [RoleController],
  providers: [RoleService, PermissionService],
  exports: [RoleService, PermissionService],
})
export class RoleModule {}
