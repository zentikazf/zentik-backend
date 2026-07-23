import { IsNumber, IsOptional, IsBoolean, IsString, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveTaskDto {
  @ApiPropertyOptional({
    description:
      'Horas confirmadas en el modal OTP de aprobacion. Si no se envia, se usa la duracion del TimeEntry DRAFT actual.',
    example: 5.5,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  confirmedHours?: number;

  // ── H6: escape "cerrar sin horas" al aprobar (task 0h legítima) ────────────
  @ApiPropertyOptional({
    example: false,
    description:
      'H6: aprobar (→DONE) una tarea sin horas reales. Requiere ser asignado o tener manage:projects, más closeWithoutHoursReason. No descuenta cupo (0 h) y queda auditado.',
  })
  @IsOptional()
  @IsBoolean({ message: 'closeWithoutHours debe ser un booleano' })
  closeWithoutHours?: boolean;

  @ApiPropertyOptional({
    example: 'Trabajo trivial sin horas imputables.',
    description: 'Motivo obligatorio cuando closeWithoutHours=true.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'El motivo no puede exceder 500 caracteres' })
  closeWithoutHoursReason?: string;
}
