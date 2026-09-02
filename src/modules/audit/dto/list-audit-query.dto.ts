import { paginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * #67 — Query de los tres listados de auditoria: `organizations/:orgId/audit-log`,
 * `projects/:projectId/activity` y `tasks/:taskId/activity`.
 *
 * Lo que habia: `page ? parseInt(page, 10) : 1` en los tres (audit.controller.ts:32-33, :48-49,
 * :64-65). `?page=abc` propagaba NaN, y los tres metodos del service (audit.service.ts:48, :67,
 * :98) hacen `skip = (page - 1) * limit` / `take: limit` sin ningun clamp ⇒ 500.
 *
 * defaultLimit 50 = el de hoy. Techo 200 y no mas: las filas son chicas, pero `?limit=1000000`
 * devolvia el registro de auditoria ENTERO de la organizacion en una sola respuesta — y es
 * justamente la tabla que mas crece con el uso.
 *
 * Consumidores: settings/audit-log/page.tsx:164 (`?page=&limit=`) y activity-feed.tsx:127/:146
 * (`?page=1&limit=<maxItems>`, maxItems 15 en el detalle de tarea). Ninguno manda otro param —
 * importa por `forbidNonWhitelisted` (main.ts:74).
 */
export class ListAuditQueryDto extends paginationQueryDto({
  defaultLimit: 50,
  maxLimit: 200,
}) {}
