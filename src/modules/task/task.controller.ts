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
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { CurrentUser, ApiPaginated } from '../../common/decorators';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { TaskService } from './task.service';
import { TaskRelationService } from './task-relation.service';
import { TaskApprovalService } from './task-approval.service';
import {
  CreateTaskDto,
  UpdateTaskDto,
  TaskFilterDto,
  BulkUpdateTaskDto,
  AssignTaskDto,
  RejectTaskDto,
} from './dto';

@ApiTags('Tasks')
@ApiCookieAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller()
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly taskRelationService: TaskRelationService,
    private readonly taskApprovalService: TaskApprovalService,
  ) {}

  // ============================================
  // TASK CRUD
  // ============================================

  @Post('projects/:projectId/tasks')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage:tasks')
  @ApiOperation({ summary: 'Crear una tarea en un proyecto' })
  @ApiResponse({ status: 201, description: 'Tarea creada exitosamente' })
  async createTask(
    @Param('projectId') projectId: string,
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskService.createTask(projectId, dto, user.id);
  }

  @Get('projects/:projectId/tasks')
  @Permissions('read:tasks')
  @ApiPaginated()
  @ApiOperation({ summary: 'Listar tareas de un proyecto (paginado, filtrable, ordenable)' })
  @ApiResponse({ status: 200, description: 'Lista paginada de tareas' })
  async getTasks(
    @Param('projectId') projectId: string,
    @Query() filters: TaskFilterDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskService.getTasks(projectId, filters, {
      userId: user.id,
      roleId: user.roleId,
      roleName: user.roleName,
    });
  }

  @Get('tasks/:taskId')
  @ApiOperation({ summary: 'Obtener detalle de una tarea' })
  @ApiResponse({ status: 200, description: 'Detalle de la tarea' })
  async getTask(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskService.getTaskById(taskId, user.organizationId);
  }

  @Patch('tasks/:taskId')
  @Permissions('manage:tasks')
  @ApiOperation({ summary: 'Actualizar una tarea' })
  @ApiResponse({ status: 200, description: 'Tarea actualizada' })
  async updateTask(
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskService.updateTask(taskId, dto, user.id, user.organizationId);
  }

  @Delete('tasks/:taskId')
  @Permissions('manage:tasks')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar una tarea (soft delete)' })
  @ApiResponse({ status: 204, description: 'Tarea eliminada' })
  async deleteTask(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.taskService.deleteTask(taskId, user.id, user.organizationId);
  }

  // ============================================
  // SUBTASKS
  // ============================================

  @Post('tasks/:taskId/subtasks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear una subtarea' })
  @ApiResponse({ status: 201, description: 'Subtarea creada' })
  async createSubtask(
    @Param('taskId') taskId: string,
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskService.createSubtask(taskId, dto, user.id);
  }

  @Get('tasks/:taskId/subtasks')
  @ApiOperation({ summary: 'Listar subtareas de una tarea' })
  @ApiResponse({ status: 200, description: 'Lista de subtareas' })
  async getSubtasks(
    @Param('taskId') taskId: string,
  ) {
    return this.taskService.getSubtasks(taskId);
  }

  // ============================================
  // ASSIGNMENTS
  // ============================================

  @Post('tasks/:taskId/assign')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Asignar un usuario a una tarea' })
  @ApiResponse({ status: 201, description: 'Usuario asignado' })
  async assignTask(
    @Param('taskId') taskId: string,
    @Body() dto: AssignTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskRelationService.assignTask(taskId, dto.userId, user.id);
  }

  @Delete('tasks/:taskId/assign/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Desasignar un usuario de una tarea' })
  @ApiResponse({ status: 204, description: 'Usuario desasignado' })
  async unassignTask(
    @Param('taskId') taskId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.taskRelationService.unassignTask(taskId, userId, user.id);
  }

  // ============================================
  // LABELS
  // ============================================

  @Post('tasks/:taskId/labels')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Agregar una etiqueta a una tarea' })
  @ApiResponse({ status: 201, description: 'Etiqueta agregada' })
  async addLabel(
    @Param('taskId') taskId: string,
    @Body('labelId') labelId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskRelationService.addLabel(taskId, labelId, user.id);
  }

  @Delete('tasks/:taskId/labels/:labelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover una etiqueta de una tarea' })
  @ApiResponse({ status: 204, description: 'Etiqueta removida' })
  async removeLabel(
    @Param('taskId') taskId: string,
    @Param('labelId') labelId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.taskRelationService.removeLabel(taskId, labelId, user.id);
  }

  // ============================================
  // BULK OPERATIONS
  // ============================================

  @Patch('projects/:projectId/tasks/bulk')
  @Permissions('manage:tasks')
  @ApiOperation({ summary: 'Actualizar tareas en lote' })
  @ApiResponse({ status: 200, description: 'Tareas actualizadas en lote' })
  async bulkUpdate(
    @Param('projectId') projectId: string,
    @Body() dto: BulkUpdateTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskRelationService.bulkUpdate(projectId, dto, user.id);
  }

  // ============================================
  // APPROVALS
  // ============================================

  @Post('tasks/:taskId/approve')
  @ApiOperation({ summary: 'Aprobar una tarea en revisión (moverla a Deploy)' })
  @ApiResponse({ status: 200, description: 'Tarea aprobada y movida a Deploy' })
  async approveTask(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskApprovalService.approveTask(taskId, user.id);
  }

  @Post('tasks/:taskId/reject')
  @ApiOperation({ summary: 'Rechazar una tarea en revisión (vuelve a Desarrollo)' })
  @ApiResponse({ status: 200, description: 'Tarea rechazada y devuelta a Desarrollo' })
  async rejectTask(
    @Param('taskId') taskId: string,
    @Body() dto: RejectTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskApprovalService.rejectTask(taskId, dto.reason, user.id);
  }

  @Get('organizations/:orgId/approvals')
  @ApiOperation({ summary: 'Listar tareas pendientes de aprobación en la organización' })
  @ApiResponse({ status: 200, description: 'Lista de tareas pendientes de aprobación' })
  async getPendingApprovals(
    @Param('orgId') orgId: string,
  ) {
    return this.taskApprovalService.findPendingApprovals(orgId);
  }

  @Get('projects/:projectId/approvals')
  @ApiOperation({ summary: 'Listar tareas pendientes de aprobación en el proyecto' })
  @ApiResponse({ status: 200, description: 'Lista de tareas pendientes de aprobación del proyecto' })
  async getProjectApprovals(
    @Param('projectId') projectId: string,
  ) {
    return this.taskApprovalService.findPendingApprovalsByProject(projectId);
  }

  // ============================================
  // MY TASKS
  // ============================================

  @Get('users/me/tasks')
  @ApiPaginated()
  @ApiOperation({ summary: 'Mis tareas asignadas (cross-project)' })
  @ApiResponse({ status: 200, description: 'Lista paginada de mis tareas' })
  async getMyTasks(
    @CurrentUser() user: AuthenticatedUser,
    @Query() filters: TaskFilterDto,
  ) {
    return this.taskService.getMyTasks(user.id, user.organizationId || '', filters);
  }
}
