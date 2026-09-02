import { paginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * #67 — Query de `GET tasks/:taskId/comments`.
 *
 * Lo que habia: `Number(page) || 1, Number(limit) || 50` (comment.controller.ts:48). Ese `|| 1`
 * SI atrapaba el NaN de `?page=abc` — este era el unico de los nueve endpoints del spec que no
 * tiraba 500 — pero NO atrapa el negativo: `Number('-5') || 1` es `-5`, y con eso el service
 * calculaba `skip: -5`, un valor que Prisma rechaza. Estaba a medio arreglar.
 *
 * defaultLimit 50 = el default de hoy (comment.service.ts:53). El unico consumidor
 * (task-detail-content.tsx:143) llama sin ningun query param, asi que ese default es lo que
 * realmente se usa en pantalla.
 */
export class ListCommentsQueryDto extends paginationQueryDto({
  defaultLimit: 50,
  maxLimit: 100,
}) {}
