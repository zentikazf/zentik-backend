import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateDocumentVisibilityDto {
  @ApiProperty({ description: 'Si el documento es visible para el cliente en su portal' })
  @IsBoolean()
  clientVisible!: boolean;
}
