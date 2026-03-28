import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { CalendarService, GoogleCalendarService } from './calendar.service';

@ApiTags('Calendar')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('calendar')
export class CalendarController {
  constructor(
    private readonly calendarService: CalendarService,
    private readonly googleCalendarService: GoogleCalendarService,
  ) {}

  @Get('events')
  @ApiOperation({ summary: 'Obtener eventos del calendario (tareas con fechas, sprints)' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiQuery({ name: 'projectId', required: false, type: String })
  async getEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.calendarService.getEvents(user.id, startDate, endDate, projectId);
  }

  @Post('google/connect')
  @ApiOperation({ summary: 'Conectar Google Calendar' })
  async connectGoogle(
    @CurrentUser() user: AuthenticatedUser,
    @Body('authCode') authCode: string,
  ) {
    return this.googleCalendarService.connect(user.id, authCode);
  }

  @Delete('google/disconnect')
  @ApiOperation({ summary: 'Desconectar Google Calendar' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnectGoogle(@CurrentUser() user: AuthenticatedUser) {
    return this.googleCalendarService.disconnect(user.id);
  }

  @Post('google/sync')
  @ApiOperation({ summary: 'Forzar sincronizacion con Google Calendar' })
  async syncGoogle(@CurrentUser() user: AuthenticatedUser) {
    return this.googleCalendarService.sync(user.id);
  }

  @Get('google/status')
  @ApiOperation({ summary: 'Estado de sincronizacion con Google Calendar' })
  async getGoogleStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.googleCalendarService.getStatus(user.id);
  }
}
