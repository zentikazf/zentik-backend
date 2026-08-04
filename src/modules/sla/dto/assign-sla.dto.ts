import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * Asignación de política SLA a un cliente (paso 3 de la cascada) o a un proyecto
 * (paso 2). `null`/ausente desasigna: la cascada sigue al paso siguiente.
 */
export class AssignSlaDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'ID de la política SLA. null (o ausente) desasigna.',
  })
  @IsOptional() // class-validator saltea la validación con null Y con undefined → ambos = desasignar
  @IsString()
  slaPolicyId?: string | null;
}
