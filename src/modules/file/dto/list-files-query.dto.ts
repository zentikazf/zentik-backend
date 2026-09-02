import { paginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * #67 — Query de los TRES listados de archivos: `projects/:projectId/files`,
 * `tasks/:taskId/files` y `clients/:clientId/documents`.
 *
 * Lo que habia: `page ? parseInt(page, 10) : 1` en los tres (file.controller.ts:233-234,
 * :250-251, :491-492). `?page=abc` propagaba NaN hasta `take` y reventaba con 500, porque
 * ninguno de los tres metodos del service (file.service.ts:138, :175, :486) tiene clamp.
 *
 * defaultLimit 20 = el de hoy. Techo 100 —y no 200 como auditoria— porque cada fila de archivo
 * arrastra un `include` del uploader y hasta 5 relaciones (file.service.ts:161, :503): pesan
 * mucho mas que un renglon de audit-log.
 *
 * ⚠️ ESTE DTO ES SOLO PARA LOS TRES LISTADOS. `file.controller.ts` tiene 15 `@Query` y la
 * mayoria NO son de paginacion: `taskId`/`messageId`/`projectId`/`category` en el upload (:87-90)
 * y `title`/`description`/`clientVisible` en los POST de documentos (:276-277, :452-454). Esos
 * NO se convirtieron: con `forbidNonWhitelisted` (main.ts:74) un DTO que no declare cada uno los
 * volveria 400 y romperia el upload. Quedan fuera del alcance de #67, a proposito.
 */
export class ListFilesQueryDto extends paginationQueryDto({
  defaultLimit: 20,
  maxLimit: 100,
}) {}
