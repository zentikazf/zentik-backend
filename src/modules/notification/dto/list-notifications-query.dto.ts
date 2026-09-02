import { paginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * #67 — Query de `GET /notifications`.
 *
 * Lo que habia: `page ? parseInt(page, 10) : 1` (notification.controller.ts:38-39). Con
 * `?page=abc` el ternario ve un string truthy, entra al parseInt y propaga NaN; el service
 * (notification.service.ts:80-90) no tiene clamp y Prisma recibia `take: NaN` ⇒ 500.
 *
 * defaultLimit 20 = el de hoy (notification.service.ts:81). Techo 100: el panel pide 30
 * (notification-panel.tsx:68) y el portal 15 (portal/notifications/page.tsx:58), asi que deja
 * margen de sobra. Los cuatro consumidores mandan solo page/limit — importa por
 * `forbidNonWhitelisted` (main.ts:74), que convierte cualquier param no declarado en 400.
 */
export class ListNotificationsQueryDto extends paginationQueryDto({
  defaultLimit: 20,
  maxLimit: 100,
}) {}
