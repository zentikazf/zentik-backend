import { IsOptional, IsDateString, IsString, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

// Prisma usa cuid() para los IDs, no UUIDs reales, por eso validamos con una
// expresión permisiva en vez de @IsUUID() (que rompía todos los filtros con 400).
const CUID_LIKE = /^[a-z0-9]{8,}$/i;

export class DashboardFilterDto {
  @ApiPropertyOptional({
    example: '2026-01-01T00:00:00.000Z',
    description: 'Fecha de inicio del rango',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-03-31T23:59:59.000Z',
    description: 'Fecha de fin del rango',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por cliente (cuid)',
  })
  @IsOptional()
  @IsString()
  @Matches(CUID_LIKE, { message: 'clientId inválido' })
  clientId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por miembro del equipo (cuid)',
  })
  @IsOptional()
  @IsString()
  @Matches(CUID_LIKE, { message: 'memberId inválido' })
  memberId?: string;
}
