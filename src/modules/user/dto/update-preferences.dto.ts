import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePreferencesDto {
  @ApiPropertyOptional({
    example: 'es',
    description: 'Idioma preferido del usuario',
    enum: ['es', 'en', 'pt'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['es', 'en', 'pt'], { message: 'El idioma debe ser es, en o pt' })
  language?: string;

  @ApiPropertyOptional({
    example: 'America/Mexico_City',
    description: 'Zona horaria del usuario',
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({
    example: 'dark',
    description: 'Tema de la interfaz',
    enum: ['light', 'dark', 'system'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['light', 'dark', 'system'], { message: 'El tema debe ser light, dark o system' })
  theme?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Recibir notificaciones por correo electronico',
  })
  @IsOptional()
  @IsBoolean({ message: 'emailNotifications debe ser un valor booleano' })
  emailNotifications?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Recibir notificaciones push en el navegador',
  })
  @IsOptional()
  @IsBoolean({ message: 'pushNotifications debe ser un valor booleano' })
  pushNotifications?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Recibir resumen semanal por correo',
  })
  @IsOptional()
  @IsBoolean({ message: 'weeklyDigest debe ser un valor booleano' })
  weeklyDigest?: boolean;
}
