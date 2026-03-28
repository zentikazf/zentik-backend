import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser, AuthenticatedRequest } from '../../common/interfaces/request.interface';
import { AppConfigService } from '../../config/app.config';

const SESSION_COOKIE = 'zentik.session_token';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: AppConfigService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Registrar nuevo usuario',
    description: 'Crea una nueva cuenta de usuario con email y contrasena. Retorna el usuario y un token de sesion.',
  })
  @ApiResponse({ status: 201, description: 'Usuario registrado exitosamente' })
  @ApiResponse({ status: 409, description: 'El email ya esta registrado' })
  @ApiResponse({ status: 422, description: 'Datos de entrada invalidos' })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.register(dto, ipAddress, userAgent);

    this.setSessionCookie(res, result.session.token);

    return result;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Iniciar sesion',
    description: 'Autentica un usuario con email y contrasena. Retorna el usuario y un token de sesion.',
  })
  @ApiResponse({ status: 200, description: 'Sesion iniciada exitosamente' })
  @ApiResponse({ status: 401, description: 'Credenciales invalidas' })
  @ApiResponse({ status: 422, description: 'Datos de entrada invalidos' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.login(dto, ipAddress, userAgent);

    this.setSessionCookie(res, result.session.token);

    return result;
  }

  @Post('logout')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cerrar sesion',
    description: 'Invalida la sesion actual del usuario.',
  })
  @ApiResponse({ status: 200, description: 'Sesion cerrada exitosamente' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const sessionToken = this.extractSessionToken(req);
    const result = await this.authService.logout(sessionToken);

    this.clearSessionCookie(res);

    return result;
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Solicitar restablecimiento de contrasena',
    description: 'Envia un correo con instrucciones para restablecer la contrasena. Siempre retorna exito para prevenir enumeracion de emails.',
  })
  @ApiResponse({ status: 200, description: 'Solicitud procesada' })
  @ApiResponse({ status: 422, description: 'Datos de entrada invalidos' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restablecer contrasena',
    description: 'Restablece la contrasena usando el token recibido por correo. Invalida todas las sesiones activas.',
  })
  @ApiResponse({ status: 200, description: 'Contrasena restablecida exitosamente' })
  @ApiResponse({ status: 400, description: 'Token invalido o expirado' })
  @ApiResponse({ status: 422, description: 'Datos de entrada invalidos' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verificar correo electronico',
    description: 'Verifica el correo electronico del usuario usando el token recibido.',
  })
  @ApiResponse({ status: 200, description: 'Correo verificado exitosamente' })
  @ApiResponse({ status: 400, description: 'Token de verificacion invalido' })
  @ApiResponse({ status: 422, description: 'Datos de entrada invalidos' })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto);
  }

  @Post('resend-verification')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reenviar correo de verificacion',
    description: 'Reenvia el correo de verificacion de email al usuario autenticado.',
  })
  @ApiResponse({ status: 200, description: 'Correo de verificacion reenviado' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  async resendVerification(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.resendVerification(user.id);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Obtener sesion actual',
    description: 'Retorna la informacion del usuario autenticado y sus organizaciones.',
  })
  @ApiResponse({ status: 200, description: 'Informacion de sesion obtenida' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getSession(user.id);
  }

  @Patch('onboarding-complete')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Marcar onboarding como completado' })
  @ApiResponse({ status: 200, description: 'Onboarding marcado como completado' })
  async completeOnboarding(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.completeOnboarding(user.id);
  }

  @Patch('change-password')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cambiar contraseña (primer inicio de sesión)' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user.id, dto.newPassword);
  }

  @Get('sessions')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Listar sesiones activas',
    description: 'Retorna todas las sesiones activas del usuario autenticado.',
  })
  @ApiResponse({ status: 200, description: 'Lista de sesiones activas' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  async listSessions(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.listSessions(user.id);
  }

  @Delete('sessions/:id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revocar sesion',
    description: 'Revoca una sesion activa especifica del usuario autenticado.',
  })
  @ApiParam({ name: 'id', description: 'ID de la sesion a revocar' })
  @ApiResponse({ status: 200, description: 'Sesion revocada exitosamente' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 404, description: 'Sesion no encontrada' })
  async revokeSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.authService.revokeSession(sessionId, user.id);
  }

  private extractSessionToken(req: Request): string {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return (
      req.cookies?.[SESSION_COOKIE] ||
      req.cookies?.['better-auth.session_token'] ||
      req.cookies?.['__Secure-better-auth.session_token'] ||
      ''
    );
  }

  private setSessionCookie(res: Response, token: string) {
    const isProduction = this.configService.isProduction;
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    });
  }

  private clearSessionCookie(res: Response) {
    const isProduction = this.configService.isProduction;
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      path: '/',
    });
  }
}
