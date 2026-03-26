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
import { BoardService } from './board.service';
import {
  CreateBoardDto,
  UpdateBoardDto,
  CreateColumnDto,
  UpdateColumnDto,
  ReorderColumnsDto,
  MoveTaskDto,
} from './dto';

@ApiTags('Boards')
@ApiCookieAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Permissions('read:boards')
@Controller()
export class BoardController {
  constructor(private readonly boardService: BoardService) {}

  // ============================================
  // BOARD ENDPOINTS
  // ============================================

  @Post('projects/:projectId/boards')
  @ApiOperation({ summary: 'Crear un tablero en un proyecto' })
  @ApiResponse({ status: 201, description: 'Tablero creado exitosamente' })
  async createBoard(
    @Param('projectId') projectId: string,
    @Body() dto: CreateBoardDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.boardService.createBoard(projectId, dto, user.id);
  }

  @Get('projects/:projectId/boards')
  @ApiOperation({ summary: 'Listar tableros de un proyecto' })
  @ApiResponse({ status: 200, description: 'Lista de tableros' })
  async getBoards(
    @Param('projectId') projectId: string,
  ) {
    return this.boardService.getBoards(projectId);
  }

  @Get('projects/:projectId/boards/:boardId')
  @ApiOperation({ summary: 'Obtener tablero con columnas y tareas' })
  @ApiResponse({ status: 200, description: 'Detalle del tablero con columnas y tareas' })
  async getBoardWithDetails(
    @Param('projectId') projectId: string,
    @Param('boardId') boardId: string,
  ) {
    return this.boardService.getBoardWithDetails(projectId, boardId);
  }

  @Patch('projects/:projectId/boards/:boardId')
  @ApiOperation({ summary: 'Actualizar un tablero' })
  @ApiResponse({ status: 200, description: 'Tablero actualizado' })
  async updateBoard(
    @Param('projectId') projectId: string,
    @Param('boardId') boardId: string,
    @Body() dto: UpdateBoardDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.boardService.updateBoard(projectId, boardId, dto, user.id);
  }

  @Delete('projects/:projectId/boards/:boardId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un tablero' })
  @ApiResponse({ status: 204, description: 'Tablero eliminado' })
  async deleteBoard(
    @Param('projectId') projectId: string,
    @Param('boardId') boardId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.boardService.deleteBoard(projectId, boardId, user.id);
  }

  // ============================================
  // COLUMN ENDPOINTS
  // ============================================

  @Post('boards/:boardId/columns')
  @ApiOperation({ summary: 'Crear una columna en un tablero' })
  @ApiResponse({ status: 201, description: 'Columna creada exitosamente' })
  async createColumn(
    @Param('boardId') boardId: string,
    @Body() dto: CreateColumnDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.boardService.createColumn(boardId, dto, user.id);
  }

  @Patch('boards/:boardId/columns/:columnId')
  @ApiOperation({ summary: 'Actualizar una columna' })
  @ApiResponse({ status: 200, description: 'Columna actualizada' })
  async updateColumn(
    @Param('boardId') boardId: string,
    @Param('columnId') columnId: string,
    @Body() dto: UpdateColumnDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.boardService.updateColumn(boardId, columnId, dto, user.id);
  }

  @Delete('boards/:boardId/columns/:columnId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar una columna' })
  @ApiResponse({ status: 204, description: 'Columna eliminada' })
  async deleteColumn(
    @Param('boardId') boardId: string,
    @Param('columnId') columnId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.boardService.deleteColumn(boardId, columnId, user.id);
  }

  @Patch('boards/:boardId/columns/reorder')
  @ApiOperation({ summary: 'Reordenar columnas de un tablero' })
  @ApiResponse({ status: 200, description: 'Columnas reordenadas' })
  async reorderColumns(
    @Param('boardId') boardId: string,
    @Body() dto: ReorderColumnsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.boardService.reorderColumns(boardId, dto, user.id);
  }

  @Patch('boards/:boardId/tasks/move')
  @ApiOperation({ summary: 'Mover una tarea entre columnas' })
  @ApiResponse({ status: 200, description: 'Tarea movida exitosamente' })
  async moveTask(
    @Param('boardId') boardId: string,
    @Body() dto: MoveTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.boardService.moveTask(boardId, dto, user.id);
  }
}
