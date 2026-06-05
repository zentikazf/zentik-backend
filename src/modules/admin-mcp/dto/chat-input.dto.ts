import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Cada mensaje del historial. SOLO `user` o `assistant` aceptados.
 * R13: rechazamos `system` explicitamente — el system prompt se construye
 * server-side. Permitir system desde cliente = prompt injection trivial.
 */
export class ChatMessageDto {
  @ApiProperty({
    enum: ['user', 'assistant'],
    description:
      'Rol del autor del mensaje. Solo "user" o "assistant". El system prompt lo arma el backend.',
  })
  @IsIn(['user', 'assistant'], {
    message: 'El campo "role" debe ser "user" o "assistant". No se acepta "system".',
  })
  role!: 'user' | 'assistant';

  @ApiProperty({
    minLength: 1,
    maxLength: 8000,
    description: 'Contenido del mensaje. Maximo 8000 caracteres.',
  })
  @IsString({ message: 'El campo "content" debe ser un string.' })
  @MinLength(1, { message: 'El contenido no puede estar vacio.' })
  @MaxLength(8000, { message: 'El contenido excede el limite de 8000 caracteres.' })
  content!: string;
}

/**
 * Body del POST /admin/mcp/chat. Backend stateless: el frontend manda
 * historial completo cada turno (Decision 3 de design.md).
 *
 * Limites:
 *   - minimo 1 mensaje (debe haber al menos el turno actual del user).
 *   - maximo 50 mensajes (defensa contra abusos de contexto y costo del LLM).
 */
export class ChatInputDto {
  @ApiProperty({
    type: [ChatMessageDto],
    minItems: 1,
    maxItems: 50,
    description: 'Historial completo del turno. El backend NO persiste mensajes.',
  })
  @IsArray({ message: 'El campo "messages" debe ser un array.' })
  @ArrayMinSize(1, { message: 'Debe enviarse al menos 1 mensaje.' })
  @ArrayMaxSize(50, { message: 'Maximo 50 mensajes por turno.' })
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages!: ChatMessageDto[];
}
