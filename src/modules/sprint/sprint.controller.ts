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
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { SprintService } from './sprint.service';
import { CreateSprintDto, UpdateSprintDto, AddTasksToSprintDto } from './dto';

@ApiTags('Sprints')
@ApiCookieAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller()
export class SprintController {
  constructor(private readonly sprintService: SprintService) {}

  // ============================================
  // SPRINT CRUD
  // ============================================

  @Post('projects/:projectId/sprints')
  @Permissions('manage:sprints')
  @ApiOperation({ summary: 'Crear un sprint en un proyecto' })
  @ApiResponse({ status: 201, description: 'Sprint creado exitosamente' })
  @HttpCode(HttpStatus.CREATED)
  async createSprint(
    @Param('projectId') projectId: string,
    @Body() dto: CreateSprintDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sprintService.createSprint(projectId, dto, user.id);
  }

  @Get('projects/:projectId/sprints')
  @Permissions('read:sprints')
  @ApiOperation({ summary: 'Listar sprints de un proyecto' })
  @ApiResponse({ status: 200, description: 'Lista de sprints' })
  async getSprints(
    @Param('projectId') projectId: string,
  ) {
    return this.sprintService.getSprints(projectId);
  }

  @Get('projects/:projectId/sprints/active')
  @ApiOperation({ summary: 'Obtener el sprint activo del proyecto' })
  @ApiResponse({ status: 200, description: 'Sprint activo con sus tareas' })
  async getActiveSprint(
    @Param('projectId') projectId: string,
  ) {
    return this.sprintService.getActiveSprint(projectId);
  }

  @Get('sprints/:sprintId')
  @ApiOperation({ summary: 'Obtener detalle de un sprint' })
  @ApiResponse({ status: 200, description: 'Detalle del sprint con tareas' })
  async getSprint(
    @Param('sprintId') sprintId: string,
  ) {
    return this.sprintService.getSprintById(sprintId);
  }

  @Patch('sprints/:sprintId')
  @Permissions('manage:sprints')
  @ApiOperation({ summary: 'Actualizar un sprint' })
  @ApiResponse({ status: 200, description: 'Sprint actualizado' })
  async updateSprint(
    @Param('sprintId') sprintId: string,
    @Body() dto: UpdateSprintDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sprintService.updateSprint(sprintId, dto, user.id);
  }

  // ============================================
  // SPRINT LIFECYCLE
  // ============================================

  @Post('sprints/:sprintId/start')
  @Permissions('manage:sprints')
  @ApiOperation({ summary: 'Iniciar un sprint' })
  @ApiResponse({ status: 200, description: 'Sprint iniciado' })
  async startSprint(
    @Param('sprintId') sprintId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sprintService.startSprint(sprintId, user.id);
  }

  @Post('sprints/:sprintId/complete')
  @Permissions('manage:sprints')
  @ApiOperation({ summary: 'Completar un sprint' })
  @ApiResponse({ status: 200, description: 'Sprint completado con resumen' })
  async completeSprint(
    @Param('sprintId') sprintId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sprintService.completeSprint(sprintId, user.id);
  }

  // ============================================
  // TASKS IN SPRINT
  // ============================================

  @Post('sprints/:sprintId/tasks')
  @ApiOperation({ summary: 'Agregar tareas a un sprint' })
  @ApiResponse({ status: 200, description: 'Tareas agregadas al sprint' })
  async addTasksToSprint(
    @Param('sprintId') sprintId: string,
    @Body() dto: AddTasksToSprintDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sprintService.addTasksToSprint(sprintId, dto, user.id);
  }

  @Delete('sprints/:sprintId/tasks/:taskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover una tarea de un sprint' })
  @ApiResponse({ status: 204, description: 'Tarea removida del sprint' })
  async removeTaskFromSprint(
    @Param('sprintId') sprintId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.sprintService.removeTaskFromSprint(sprintId, taskId, user.id);
  }

  // ============================================
  // BURNDOWN & BACKLOG
  // ============================================

  @Get('sprints/:sprintId/burndown')
  @ApiOperation({ summary: 'Obtener datos del burndown chart' })
  @ApiResponse({ status: 200, description: 'Datos de burndown del sprint' })
  async getBurndownData(
    @Param('sprintId') sprintId: string,
  ) {
    return this.sprintService.getBurndownData(sprintId);
  }

  @Get('projects/:projectId/backlog')
  @ApiOperation({ summary: 'Obtener el backlog del proyecto (tareas sin sprint)' })
  @ApiResponse({ status: 200, description: 'Lista de tareas en el backlog' })
  async getBacklog(
    @Param('projectId') projectId: string,
  ) {
    return this.sprintService.getBacklog(projectId);
  }
}
