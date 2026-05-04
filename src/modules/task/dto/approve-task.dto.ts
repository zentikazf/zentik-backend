import { IsNumber, IsOptional, Min } from 'class-validator';
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
}
