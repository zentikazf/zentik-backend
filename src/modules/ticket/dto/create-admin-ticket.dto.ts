import { IsString, IsEnum, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketCategoryDto, TicketCriticalityDto, TicketPriorityDto } from './create-ticket.dto';

export class CreateAdminTicketDto {
  @ApiProperty({ example: 'Error al cargar la factura', description: 'Titulo del ticket' })
  @IsString()
  @MinLength(3, { message: 'El titulo debe tener al menos 3 caracteres' })
  @MaxLength(200, { message: 'El titulo no puede exceder 200 caracteres' })
  title: string;

  @ApiPropertyOptional({ description: 'Descripcion detallada' })
  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: 'La descripcion no puede exceder 5000 caracteres' })
  description?: string;

  @ApiProperty({ enum: TicketCategoryDto, description: 'Categoria del ticket' })
  @IsEnum(TicketCategoryDto, { message: 'La categoria no es valida' })
  category: TicketCategoryDto;

  @ApiPropertyOptional({ enum: TicketPriorityDto, default: TicketPriorityDto.MEDIUM })
  @IsOptional()
  @IsEnum(TicketPriorityDto, { message: 'La prioridad no es valida' })
  priority?: TicketPriorityDto;

  @ApiProperty({ description: 'ID del cliente' })
  @IsString()
  clientId: string;

  @ApiProperty({ description: 'ID del proyecto' })
  @IsString()
  projectId: string;

  @ApiPropertyOptional({ description: 'ID de la categoría configurable' })
  @IsOptional()
  @IsString()
  categoryConfigId?: string;

  @ApiPropertyOptional({ description: 'ID del ticket relacionado (follow-up de un ticket previo del mismo cliente)' })
  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'relatedTicketId inválido' })
  relatedTicketId?: string;

  @ApiPropertyOptional({
    description:
      'ID del tipo de solicitud (feature #42). Es CLASIFICACIÓN, no salida del motor de SLA: ' +
      'se persiste SIEMPRE, con `SLA_CASCADE_ENABLED` prendido o apagado (#48 T10). ' +
      'Además es la clave del paso 1 de la cascada (contrato proyecto+tipo) cuando el flag está ON.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'ticketTypeId inválido' })
  ticketTypeId?: string;

  /**
   * Criticidad REAL del ticket, elegida por el equipo (#48 T10 / R8.2).
   *
   * Antes el staff no podía fijarla ni por API: la única fuente era
   * `categoryConfig.criticality`, así que un alta sin "Categoría SLA" nacía sin
   * criticidad. El campo "Criticidad" del modal en realidad escribía `priority`
   * (otra columna, otro dominio).
   *
   * NO se valida contra `clientVisible`: eso es una regla del PORTAL (qué puede
   * elegir el cliente). El staff ve y elige todas — misma regla que el ojito de
   * los tipos (#48 R2.1: el flag solo filtra la lectura del cliente).
   */
  @ApiPropertyOptional({
    enum: TicketCriticalityDto,
    description:
      'Criticidad determinada por el equipo. Si no viene, se usa la de `categoryConfigId` (comportamiento previo).',
  })
  @IsOptional()
  @IsEnum(TicketCriticalityDto, { message: 'La criticidad no es valida' })
  criticality?: TicketCriticalityDto;
}
