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
import { AuthGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { CommentService } from './comment.service';
import { CreateCommentDto, UpdateCommentDto } from './dto';

@ApiTags('Comments')
@ApiCookieAuth()
@UseGuards(AuthGuard)
@Controller()
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Post('tasks/:taskId/comments')
  @ApiOperation({ summary: 'Crear un comentario en una tarea' })
  @ApiResponse({ status: 201, description: 'Comentario creado' })
  @HttpCode(HttpStatus.CREATED)
  async createComment(
    @Param('taskId') taskId: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.commentService.create(taskId, dto, user.id);
  }

  @Get('tasks/:taskId/comments')
  @ApiOperation({ summary: 'Listar comentarios de una tarea' })
  @ApiResponse({ status: 200, description: 'Lista de comentarios' })
  async getComments(
    @Param('taskId') taskId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.commentService.findByTask(taskId, Number(page) || 1, Number(limit) || 50);
  }

  @Patch('comments/:commentId')
  @ApiOperation({ summary: 'Editar un comentario' })
  @ApiResponse({ status: 200, description: 'Comentario actualizado' })
  async updateComment(
    @Param('commentId') commentId: string,
    @Body() dto: UpdateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.commentService.update(commentId, dto, user.id);
  }

  @Delete('comments/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un comentario' })
  @ApiResponse({ status: 204, description: 'Comentario eliminado' })
  async deleteComment(
    @Param('commentId') commentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.commentService.delete(commentId, user.id);
  }
}
