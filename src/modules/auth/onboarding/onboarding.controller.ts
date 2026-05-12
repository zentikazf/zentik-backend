import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OnboardingService } from './onboarding.service';
import { ActivateAccountDto } from './dto/activate.dto';

@ApiTags('Onboarding')
@Controller('auth/activate')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('check')
  @Throttle({ short: { ttl: 60_000, limit: 30 } })
  @ApiOperation({
    summary: 'Verificar validez de un token de activacion antes de mostrar form',
  })
  @ApiQuery({ name: 'token', required: true })
  async check(@Query('token') token: string) {
    if (!token) return { valid: false, reason: 'MISSING_TOKEN' };
    return this.onboardingService.checkToken(token);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 5 } })
  @ApiOperation({
    summary: 'Activar cuenta: consume token + setea contrasena + marca email verificado',
  })
  async activate(@Body() dto: ActivateAccountDto) {
    return this.onboardingService.activate(dto.token, dto.password);
  }
}
