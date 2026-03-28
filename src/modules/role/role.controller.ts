import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { RoleService } from './role.service';
import { PermissionService } from './permission.service';
import { CreateRoleDto, UpdateRoleDto, UpdatePermissionsDto } from './dto';

@ApiTags('Roles')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Permissions('manage:members')
@Controller()
export class RoleController {
  constructor(
    private readonly roleService: RoleService,
    private readonly permissionService: PermissionService,
  ) {}

  // ============================================
  // ROLES
  // ============================================

  @Get('organizations/:orgId/roles')
  @ApiOperation({ summary: 'Listar roles de la organizacion' })
  findAll(@Param('orgId') orgId: string) {
    return this.roleService.findAll(orgId);
  }

  @Post('organizations/:orgId/roles')
  @ApiOperation({ summary: 'Crear un nuevo rol en la organizacion' })
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('orgId') orgId: string,
    @Body() dto: CreateRoleDto,
  ) {
    return this.roleService.create(orgId, dto);
  }

  @Patch('organizations/:orgId/roles/:roleId')
  @ApiOperation({ summary: 'Actualizar un rol' })
  update(
    @Param('orgId') orgId: string,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.roleService.update(orgId, roleId, dto);
  }

  @Delete('organizations/:orgId/roles/:roleId')
  @ApiOperation({ summary: 'Eliminar un rol' })
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(
    @Param('orgId') orgId: string,
    @Param('roleId') roleId: string,
  ) {
    return this.roleService.delete(orgId, roleId);
  }

  // ============================================
  // ROLE PERMISSIONS
  // ============================================

  @Get('organizations/:orgId/roles/:roleId/perms')
  @ApiOperation({ summary: 'Obtener permisos de un rol' })
  getRolePermissions(
    @Param('orgId') orgId: string,
    @Param('roleId') roleId: string,
  ) {
    return this.roleService.getRolePermissions(orgId, roleId);
  }

  @Patch('organizations/:orgId/roles/:roleId/perms')
  @ApiOperation({ summary: 'Actualizar permisos de un rol' })
  updateRolePermissions(
    @Param('orgId') orgId: string,
    @Param('roleId') roleId: string,
    @Body() dto: UpdatePermissionsDto,
  ) {
    return this.roleService.updateRolePermissions(orgId, roleId, dto.permissionIds);
  }

  // ============================================
  // PERMISSIONS CATALOG
  // ============================================

  @Get('permissions')
  @ApiOperation({ summary: 'Listar todos los permisos disponibles del sistema' })
  getAllPermissions() {
    return this.permissionService.findAll();
  }
}
