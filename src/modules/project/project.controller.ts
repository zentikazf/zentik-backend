import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { CurrentUser, ApiPaginated } from '../../common/decorators';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { ProjectService } from './project.service';
import { ProjectBudgetService } from './project-budget.service';
import { CreateProjectDto, UpdateProjectDto, ProjectFilterDto, CreateBudgetItemDto, UpdateBudgetItemDto } from './dto';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller()
export class ProjectController {
  constructor(
    private readonly projectService: ProjectService,
    private readonly projectBudgetService: ProjectBudgetService,
  ) {}

  // ============================================
  // PROJECTS UNDER ORGANIZATION
  // ============================================

  @Post('organizations/:orgId/projects')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Crear un nuevo proyecto en la organizacion' })
  create(
    @Param('orgId') orgId: string,
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectService.create(orgId, dto, user.id);
  }

  @Get('organizations/:orgId/projects')
  @Permissions('read:projects')
  @ApiPaginated()
  @ApiOperation({ summary: 'Listar proyectos de la organizacion (paginado y filtrable)' })
  findAll(
    @Param('orgId') orgId: string,
    @Query() filters: ProjectFilterDto,
  ) {
    return this.projectService.findAll(orgId, filters);
  }

  // ============================================
  // PROJECT CRUD
  // ============================================

  @Get('projects/:projectId')
  @Permissions('read:projects')
  @ApiOperation({ summary: 'Obtener detalles de un proyecto' })
  findById(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectService.findById(projectId, user.organizationId);
  }

  @Patch('projects/:projectId')
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Actualizar un proyecto' })
  update(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectService.update(projectId, dto, user.organizationId);
  }

  @Post('projects/:projectId/accept')
  @HttpCode(HttpStatus.OK)
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Aceptar proyecto solicitado por cliente' })
  acceptClientProject(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectService.acceptClientProject(projectId, user.id, user.organizationId);
  }

  @Patch('projects/:projectId/lifecycle-status')
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Cambiar estado de ciclo de vida del proyecto (ACTIVE, DISABLED, ARCHIVED)' })
  changeLifecycleStatus(
    @Param('projectId') projectId: string,
    @Body() body: { status: 'ACTIVE' | 'DISABLED' | 'ARCHIVED' },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectService.changeLifecycleStatus(projectId, body.status, user.id, user.organizationId);
  }

  @Delete('projects/:projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Eliminar un proyecto (soft delete)' })
  softDelete(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectService.softDelete(projectId, user.id, user.organizationId);
  }

  // ============================================
  // PROJECT MEMBERS
  // ============================================

  @Get('projects/:projectId/members')
  @ApiOperation({ summary: 'Listar miembros del proyecto' })
  listMembers(@Param('projectId') projectId: string) {
    return this.projectService.listMembers(projectId);
  }

  @Post('projects/:projectId/members')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Agregar un miembro al proyecto' })
  addMember(
    @Param('projectId') projectId: string,
    @Body('userId') userId: string,
  ) {
    return this.projectService.addMember(projectId, userId);
  }

  @Delete('projects/:projectId/members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Remover un miembro del proyecto' })
  removeMember(
    @Param('projectId') projectId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.projectService.removeMember(projectId, memberId);
  }

  // ============================================
  // PROJECT STATS
  // ============================================

  @Get('projects/:projectId/stats')
  @ApiOperation({ summary: 'Obtener estadisticas del proyecto' })
  getStats(@Param('projectId') projectId: string) {
    return this.projectService.getStats(projectId);
  }

  // ============================================
  // BUDGET ITEMS (Presupuestador)
  // ============================================

  @Get('projects/:projectId/budget')
  @ApiOperation({ summary: 'Listar items del presupuesto del proyecto' })
  getBudgetItems(@Param('projectId') projectId: string) {
    return this.projectBudgetService.getBudgetItems(projectId);
  }

  @Post('projects/:projectId/budget')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Crear un item de presupuesto' })
  createBudgetItem(
    @Param('projectId') projectId: string,
    @Body() dto: CreateBudgetItemDto,
  ) {
    return this.projectBudgetService.createBudgetItem(projectId, dto);
  }

  @Patch('projects/:projectId/budget/:itemId')
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Actualizar un item de presupuesto' })
  updateBudgetItem(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateBudgetItemDto,
  ) {
    return this.projectBudgetService.updateBudgetItem(projectId, itemId, dto);
  }

  @Delete('projects/:projectId/budget/:itemId')
  @Permissions('manage:projects')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un item de presupuesto' })
  deleteBudgetItem(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.projectBudgetService.deleteBudgetItem(projectId, itemId);
  }

  @Patch('projects/:projectId/budget-reorder')
  @ApiOperation({ summary: 'Reordenar items del presupuesto' })
  reorderBudgetItems(
    @Param('projectId') projectId: string,
    @Body('itemIds') itemIds: string[],
  ) {
    return this.projectBudgetService.reorderBudgetItems(projectId, itemIds);
  }

  // ============================================
  // ALCANCE (Organization-level financial view)
  // ============================================

  @Get('organizations/:orgId/alcance')
  @ApiOperation({ summary: 'Vista de alcance con datos financieros de todos los proyectos' })
  getAlcance(
    @Param('orgId') orgId: string,
    @Query('clientId') clientId?: string,
    @Query('status') status?: string,
    @Query('billingMonth') billingMonth?: string,
  ) {
    return this.projectBudgetService.getAlcance(orgId, { clientId, status, billingMonth });
  }
}
