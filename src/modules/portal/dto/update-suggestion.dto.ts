import { IsString, IsOptional, IsEnum, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { SuggestionStatus } from '@prisma/client';

export class UpdateSuggestionDto {
  @ApiPropertyOptional({ enum: SuggestionStatus, description: 'Estado de la sugerencia' })
  @IsOptional()
  @IsEnum(SuggestionStatus)
  status?: SuggestionStatus;

  @ApiPropertyOptional({ description: 'Notas internas del admin' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;
}
