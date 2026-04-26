import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum DocumentCategoryDto {
  SCOPE = 'SCOPE',
  BUDGET = 'BUDGET',
  MOCKUP = 'MOCKUP',
  DOCUMENTATION = 'DOCUMENTATION',
  OTHER = 'OTHER',
}

export class UpdateDocumentVisibilityDto {
  @ApiProperty({ description: 'Si el documento es visible para el cliente en su portal' })
  @IsBoolean()
  clientVisible!: boolean;
}

export class UpdateDocumentCategoryDto {
  @ApiProperty({ enum: DocumentCategoryDto })
  @IsEnum(DocumentCategoryDto)
  documentCategory!: DocumentCategoryDto;
}

export class UploadDocumentDto {
  @ApiPropertyOptional({ enum: DocumentCategoryDto, description: 'Categoria del documento' })
  @IsOptional()
  @IsEnum(DocumentCategoryDto)
  documentCategory?: DocumentCategoryDto;
}
