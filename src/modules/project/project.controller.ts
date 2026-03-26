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
import { CreateProjectDto, UpdateProjectDto, ProjectFilterDto } from './dto';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller()
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  // ============================================
  // PROJECTS UNDER ORGANIZATION
  // ============================================

  @Post('organizations/:orgId/projects')
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
  findById(@Param('projectId') projectId: string) {
    return this.projectService.findById(projectId);
  }

  @Patch('projects/:projectId')
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Actualizar un proyecto' })
  update(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.update(projectId, dto);
  }

  @Delete('projects/:projectId')
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Eliminar un proyecto (soft delete)' })
  softDelete(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectService.softDelete(projectId, user.id);
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
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Agregar un miembro al proyecto' })
  addMember(
    @Param('projectId') projectId: string,
    @Body('userId') userId: string,
  ) {
    return this.projectService.addMember(projectId, userId);
  }

  @Delete('projects/:projectId/members/:memberId')
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
    return this.projectService.getBudgetItems(projectId);
  }

  @Post('projects/:projectId/budget')
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Crear un item de presupuesto' })
  createBudgetItem(
    @Param('projectId') projectId: string,
    @Body() dto: { description: string; category?: string; hours?: number; hourlyRate?: number },
  ) {
    return this.projectService.createBudgetItem(projectId, dto);
  }

  @Patch('projects/:projectId/budget/:itemId')
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Actualizar un item de presupuesto' })
  updateBudgetItem(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: { description?: string; category?: string; hours?: number; hourlyRate?: number },
  ) {
    return this.projectService.updateBudgetItem(projectId, itemId, dto);
  }

  @Delete('projects/:projectId/budget/:itemId')
  @Permissions('manage:projects')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un item de presupuesto' })
  deleteBudgetItem(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.projectService.deleteBudgetItem(projectId, itemId);
  }

  @Patch('projects/:projectId/budget-reorder')
  @ApiOperation({ summary: 'Reordenar items del presupuesto' })
  reorderBudgetItems(
    @Param('projectId') projectId: string,
    @Body('itemIds') itemIds: string[],
  ) {
    return this.projectService.reorderBudgetItems(projectId, itemIds);
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
    return this.projectService.getAlcance(orgId, { clientId, status, billingMonth });
  }
}
