import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { NotificationPushService } from './notification-push.service';
import { SubscribePushDto, UnsubscribePushDto } from './dto/subscribe-push.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

@ApiTags('Notifications Push')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('notifications/push')
export class NotificationPushController {
  constructor(private readonly pushService: NotificationPushService) {}

  @Get('vapid-public-key')
  @ApiOperation({ summary: 'Obtener la clave publica VAPID para suscribirse desde el navegador' })
  getVapidPublicKey() {
    return { publicKey: this.pushService.getPublicKey() };
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Guardar suscripcion push del navegador' })
  subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubscribePushDto,
  ) {
    return this.pushService.subscribe(user.id, dto);
  }

  @Delete('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar una suscripcion push especifica' })
  unsubscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UnsubscribePushDto,
  ) {
    return this.pushService.unsubscribe(user.id, dto);
  }

  @Delete('unsubscribe-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar todas las suscripciones push del usuario' })
  unsubscribeAll(@CurrentUser() user: AuthenticatedUser) {
    return this.pushService.unsubscribeAll(user.id);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Obtener las preferencias granulares del usuario' })
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.pushService.getPreferences(user.id);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Actualizar preferencias granulares del usuario' })
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.pushService.updatePreferences(user.id, dto);
  }
}
