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
import { CurrentUser } from '../../common/decorators';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { OrganizationService } from './organization.service';
import { OrgMembershipService } from './org-membership.service';
import { InviteService } from './invite.service';
import { CreateOrganizationDto, UpdateOrganizationDto, CreateInviteDto, CreateMemberDto } from './dto';

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller('organizations')
export class OrganizationController {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly membershipService: OrgMembershipService,
    private readonly inviteService: InviteService,
  ) {}

  // ============================================
  // ORGANIZATION CRUD
  // ============================================

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear una nueva organizacion' })
  create(
    @Body() dto: CreateOrganizationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.organizationService.create(dto, user.id);
  }

  @Get()
  @ApiOperation({ summary: 'Listar organizaciones del usuario autenticado' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.organizationService.findAll(user.id);
  }

  @Get(':orgId')
  @ApiOperation({ summary: 'Obtener detalles de una organizacion' })
  findById(@Param('orgId') orgId: string) {
    return this.organizationService.findById(orgId);
  }

  @Patch(':orgId')
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Actualizar una organizacion' })
  update(
    @Param('orgId') orgId: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationService.update(orgId, dto);
  }

  @Delete(':orgId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar una organizacion (soft delete)' })
  softDelete(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.organizationService.softDelete(orgId, user.id);
  }

  // ============================================
  // MEMBERS
  // ============================================

  @Get(':orgId/members')
  @ApiOperation({ summary: 'Listar miembros de la organizacion' })
  listMembers(@Param('orgId') orgId: string) {
    return this.membershipService.listMembers(orgId);
  }

  @Patch(':orgId/members/:id')
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Actualizar el rol de un miembro' })
  updateMemberRole(
    @Param('orgId') orgId: string,
    @Param('id') memberId: string,
    @Body('roleId') roleId: string,
  ) {
    return this.membershipService.updateMemberRole(orgId, memberId, roleId);
  }

  @Post(':orgId/backfill-roles')
  @ApiOperation({ summary: 'Agregar roles SaaS faltantes a una organizacion existente' })
  backfillRoles(@Param('orgId') orgId: string) {
    return this.membershipService.ensureSaaSRoles(orgId);
  }

  @Delete(':orgId/members/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Remover un miembro de la organizacion' })
  removeMember(
    @Param('orgId') orgId: string,
    @Param('id') memberId: string,
  ) {
    return this.membershipService.removeMember(orgId, memberId);
  }

  @Post(':orgId/members')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Crear un usuario y agregarlo como miembro' })
  createMember(
    @Param('orgId') orgId: string,
    @Body() dto: CreateMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.membershipService.createMember(orgId, dto, user.id);
  }

  // ============================================
  // INVITES
  // ============================================

  @Post(':orgId/invites')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Crear un enlace de invitacion' })
  createInvite(
    @Param('orgId') orgId: string,
    @Body() dto: CreateInviteDto,
  ) {
    return this.inviteService.createInvite(orgId, dto);
  }

  @Get(':orgId/invites')
  @ApiOperation({ summary: 'Listar enlaces de invitacion de la organizacion' })
  listInvites(@Param('orgId') orgId: string) {
    return this.inviteService.listInvites(orgId);
  }

  @Post('join/:code')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Unirse a una organizacion mediante codigo de invitacion' })
  joinByCode(
    @Param('code') code: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inviteService.joinByCode(code, user.id);
  }
}
