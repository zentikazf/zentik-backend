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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { ChannelService, MessageService } from './chat.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateMessageDto } from './dto/update-message.dto';

@ApiTags('Chat')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Permissions('read:chat')
@Controller()
export class ChatController {
  constructor(
    private readonly channelService: ChannelService,
    private readonly messageService: MessageService,
  ) {}

  // ============================================
  // Canales — Org-level
  // ============================================

  @Get('organizations/:orgId/channels')
  @ApiOperation({ summary: 'Listar mis canales en la organizacion' })
  async listChannels(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
  ) {
    return this.channelService.findByOrganization(orgId, user.id);
  }

  @Post('organizations/:orgId/channels')
  @ApiOperation({ summary: 'Crear canal (DM/GROUP/PROJECT)' })
  @HttpCode(HttpStatus.CREATED)
  async createChannel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() dto: CreateChannelDto,
  ) {
    return this.channelService.create(orgId, user.id, dto);
  }

  // Legacy: project-level channel listing
  @Get('projects/:projectId/channels')
  @ApiOperation({ summary: 'Listar canales de un proyecto' })
  async listProjectChannels(@Param('projectId') projectId: string) {
    return this.channelService.findByProject(projectId);
  }

  // ============================================
  // Miembros
  // ============================================

  @Get('channels/:channelId/members')
  @ApiOperation({ summary: 'Listar miembros de un canal' })
  async listMembers(@Param('channelId') channelId: string) {
    return this.channelService.getMembers(channelId);
  }

  @Post('channels/:channelId/members')
  @ApiOperation({ summary: 'Agregar miembro a un canal' })
  async addMember(
    @Param('channelId') channelId: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.channelService.addMember(channelId, dto.userId);
  }

  @Delete('channels/:channelId/members/:userId')
  @ApiOperation({ summary: 'Quitar miembro de un canal' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('channelId') channelId: string,
    @Param('userId') userId: string,
  ) {
    return this.channelService.removeMember(channelId, userId);
  }

  // ============================================
  // Mensajes
  // ============================================

  @Get('channels/:channelId/messages')
  @ApiOperation({ summary: 'Listar mensajes de un canal (paginacion por cursor)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'ID del cursor para paginacion' })
  @ApiQuery({ name: 'limit', required: false, description: 'Cantidad de mensajes por pagina' })
  async listMessages(
    @Param('channelId') channelId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messageService.findByChannel(
      channelId,
      cursor,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Post('channels/:channelId/messages')
  @ApiOperation({ summary: 'Enviar mensaje en un canal' })
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('channelId') channelId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messageService.create(channelId, user.id, dto);
  }

  @Patch('messages/:messageId')
  @ApiOperation({ summary: 'Editar mensaje' })
  async editMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('messageId') messageId: string,
    @Body() dto: UpdateMessageDto,
  ) {
    return this.messageService.update(messageId, user.id, dto);
  }

  @Delete('messages/:messageId')
  @ApiOperation({ summary: 'Eliminar mensaje' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('messageId') messageId: string,
  ) {
    return this.messageService.delete(messageId, user.id);
  }
}
