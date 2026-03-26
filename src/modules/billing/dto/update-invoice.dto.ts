import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

enum InvoiceStatusDto {
  DRAFT = 'DRAFT',
  SENT = 'SENT',
  PAID = 'PAID',
  OVERDUE = 'OVERDUE',
  CANCELLED = 'CANCELLED',
}

export class UpdateInvoiceDto {
  @ApiPropertyOptional({
    example: 'SENT',
    description: 'Estado de la factura',
    enum: InvoiceStatusDto,
  })
  @IsOptional()
  @IsEnum(InvoiceStatusDto, { message: 'El estado de la factura no es valido' })
  status?: InvoiceStatusDto;

  @ApiPropertyOptional({
    example: 'Factura actualizada con nuevos terminos',
    description: 'Notas adicionales',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Las notas no pueden exceder 1000 caracteres' })
  notes?: string;

  @ApiPropertyOptional({
    example: '2026-02-28T23:59:59.000Z',
    description: 'Fecha de vencimiento',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de vencimiento no es valida' })
  dueDate?: string;
}
