import {
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { NotificationPushService } from './notification-push.service';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

@ApiTags('Notification Preferences')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('notifications/preferences')
export class NotificationPreferencesController {
  constructor(private readonly pushService: NotificationPushService) {}

  @Get()
  @ApiOperation({
    summary: 'Obtener preferencias de notificacion del usuario para todos los canales (push y email)',
  })
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.pushService.getPreferencesMultiChannel(user.id);
  }

  @Patch()
  @ApiOperation({
    summary: 'Actualizar preferencias de notificacion (un canal a la vez por item)',
  })
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.pushService.updatePreferences(user.id, dto);
  }
}
