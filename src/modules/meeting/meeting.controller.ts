import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { MeetingService } from './meeting.service';
import { CreateMeetingDto, UpdateMeetingDto } from './dto';

@ApiTags('Meetings')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Permissions('read:projects')
@Controller()
export class MeetingController {
  constructor(private readonly meetingService: MeetingService) {}

  @Post('projects/:projectId/meetings')
  @ApiOperation({ summary: 'Crear reunión en un proyecto' })
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateMeetingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingService.create(projectId, dto, user.id);
  }

  @Get('projects/:projectId/meetings')
  @ApiOperation({ summary: 'Listar reuniones de un proyecto' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async findByProject(
    @Param('projectId') projectId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.meetingService.findByProject(projectId, startDate, endDate);
  }

  @Get('meetings/:meetingId')
  @ApiOperation({ summary: 'Obtener detalle de una reunión' })
  async findById(@Param('meetingId') meetingId: string) {
    return this.meetingService.findById(meetingId);
  }

  @Patch('meetings/:meetingId')
  @ApiOperation({ summary: 'Actualizar reunión' })
  async update(
    @Param('meetingId') meetingId: string,
    @Body() dto: UpdateMeetingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingService.update(meetingId, dto, user.id);
  }

  @Delete('meetings/:meetingId')
  @ApiOperation({ summary: 'Eliminar reunión' })
  async delete(
    @Param('meetingId') meetingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingService.delete(meetingId, user.id);
  }
}
