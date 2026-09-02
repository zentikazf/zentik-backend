import { cursorPaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * #67 — Query de `GET channels/:channelId/messages`.
 *
 * Paginacion por CURSOR, no por offset: el service filtra con `where.id = { lt: cursor }`
 * (chat.service.ts:379-380). Por eso no lleva `page` — declararlo seria invitar al frontend a
 * mandar algo que nadie lee.
 *
 * Lo que habia: `limit ? parseInt(limit, 10) : 50` (chat.controller.ts:117) ⇒ `?limit=abc`
 * propagaba NaN hasta `take` y reventaba con 500.
 *
 * ⚠️ EL TECHO NO PUEDE BAJAR DE 100. El portal pide exactamente `?limit=100`
 * (portal/tickets/[ticketId]/page.tsx:129) para traer el hilo del ticket; con un techo de 50 esa
 * pantalla se caeria con 400. Es el unico endpoint de #67 donde un consumidor real roza el techo.
 * El otro (chat-window.tsx:52) pide 50.
 */
export class ListMessagesQueryDto extends cursorPaginationQueryDto({
  defaultLimit: 50,
  maxLimit: 100,
}) {}
