import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Una fila de la matriz tipo → política del proyecto. */
export class ProjectContractItemDto {
  @ApiProperty({ description: 'ID del tipo de solicitud' })
  @IsString()
  ticketTypeId: string;

  @ApiProperty({ description: 'ID de la política SLA que se aplica a ese tipo en este proyecto' })
  @IsString()
  slaPolicyId: string;

  @ApiPropertyOptional({ description: 'Nota del contrato comercial (referencia interna)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  contractNotes?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'false desactiva el contrato sin borrarlo (la cascada lo ignora)',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpsertProjectContractDto {
  @ApiProperty({ type: [ProjectContractItemDto], description: 'Matriz completa a persistir (upsert por tipo)' })
  @IsArray()
  @ArrayMaxSize(200, { message: 'No se pueden enviar más de 200 contratos por request' })
  @ValidateNested({ each: true })
  @Type(() => ProjectContractItemDto)
  items: ProjectContractItemDto[];
}
