import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { OUTBOX_EVENT_TYPES, OutboxEventType } from '../types/outbox.types';

/**
 * Body de `POST /admin/sync/onnix/requeue` (#51 R3.2, D4).
 *
 * Los TRES filtros son opcionales y COMBINABLES (se aplican con AND). La regla
 * que no esta acá es la importante: **sin ningun filtro el endpoint devuelve 400**
 * (`OutboxService.resolveFailedIdsForRequeue`). class-validator no puede expresar
 * "al menos uno de estos tres" sin un decorador custom, y ademas la regla tiene
 * que valer para CUALQUIER caller del service, no solo para este controller: por
 * eso vive en el repositorio y no en el DTO.
 *
 * `whitelist: true` + `forbidNonWhitelisted: true` (ValidationPipe global de
 * main.ts) hacen que cualquier campo de mas sea 400 — un typo tipo `eventTypes`
 * no se cuela silenciosamente y termina re-encolando mas de la cuenta.
 */
export class RequeueFailedDto {
  @ApiPropertyOptional({
    description:
      'Ids de outbox-rows a re-encolar. Solo se tocan las que esten en estado `failed`.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids?: string[];

  // La lista sale de `OUTBOX_EVENT_TYPES` y NO se escribe a mano (#52): la copia
  // literal que habia acá ya se habia quedado sin `ASSIGNEE_CHANGED`, y el sintoma
  // era un 400 justo en el camino de recuperacion del rollout (con
  // ONNIX_SYNC_DRY_RUN=true todas las filas caen a `failed` y se recuperan por acá).
  @ApiPropertyOptional({
    description: 'Re-encola todas las `failed` de este tipo de evento.',
    enum: [...OUTBOX_EVENT_TYPES],
  })
  @IsOptional()
  @IsIn([...OUTBOX_EVENT_TYPES])
  eventType?: OutboxEventType;

  @ApiPropertyOptional({
    description:
      'Solo las filas que cayeron por el simulacro (`lastError` empieza con DRY_RUN). ' +
      'Es el caso concreto del rollout de #50 R5.3: se valida en prod con ' +
      'ONNIX_SYNC_DRY_RUN=true, se apaga el flag, y con esto se recupera todo lo ' +
      'que quedo en la DLQ durante la ventana. `false` NO es un filtro (no restringe ' +
      'nada): mandarlo solo, sin `ids` ni `eventType`, sigue siendo 400.',
  })
  @IsOptional()
  @IsBoolean()
  onlyDryRun?: boolean;
}
