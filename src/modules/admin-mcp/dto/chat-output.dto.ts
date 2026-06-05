import { ApiProperty } from '@nestjs/swagger';

/**
 * Resumen por tool call ejecutada dentro del turno. Incluye latencia
 * medida en el backend para que el frontend pueda mostrar feedback
 * y para auditoria minima.
 *
 * NUNCA exponemos los `args` raw del LLM al frontend cuando son sensibles;
 * sin embargo, las tools del MCP de Zentik son read-only y los args son
 * tipicamente nombres de entidades (Client, Project), asi que se incluyen
 * tal cual para UX.
 */
export class ToolCallSummary {
  @ApiProperty({ description: 'Nombre de la tool ejecutada (ej. count_entity).' })
  tool!: string;

  @ApiProperty({ description: 'Argumentos pasados a la tool.' })
  args!: Record<string, unknown>;

  @ApiProperty({ description: 'Latencia medida en backend (ms).' })
  latencyMs!: number;

  @ApiProperty({ description: 'true si la tool ejecuto sin error.' })
  ok!: boolean;
}

/**
 * Response del POST /admin/mcp/chat. Batch JSON (sin streaming en v1).
 */
export class ChatOutputDto {
  @ApiProperty({
    description:
      'Respuesta final del asistente en lenguaje natural (puede contener markdown).',
  })
  reply!: string;

  @ApiProperty({ type: [ToolCallSummary], description: 'Tools ejecutadas durante el turno.' })
  toolCalls!: ToolCallSummary[];

  @ApiProperty({
    description: 'CorrelationId / traceId reutilizado del middleware (X-Correlation-ID).',
  })
  traceId!: string;

  @ApiProperty({ description: 'Cantidad de iteraciones LLM <-> MCP ejecutadas.' })
  iterations!: number;
}
