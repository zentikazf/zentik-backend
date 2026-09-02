import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * #67 — DTOs de paginacion para los listados que leian `page`/`limit` como string suelto.
 *
 * EL BUG QUE CIERRAN. Ocho endpoints hacian `page ? parseInt(page, 10) : 1`. El ternario evalua
 * el STRING, que es truthy, asi que `?page=abc` entraba a la rama del parseInt — y
 * `parseInt('abc', 10)` es NaN. El default de la firma del service (`page = 1`) NO protege: solo
 * cubre `undefined`, y lo que llega es NaN. Prisma terminaba recibiendo `take: NaN`
 * ("Argument `take` is missing") ⇒ HTTP 500. Ninguno de los cinco services tenia clamp: todos
 * hacen `skip = (page - 1) * limit` y `take: limit` directo. Es el mismo bug que #57 cerro en
 * client.controller.ts, replicado ocho veces.
 *
 * Ademas de NaN, sin techo ni piso: `?limit=1000000` devolvia el registro de auditoria entero de
 * la organizacion en una respuesta, `?page=0` daba `skip: -50` (Prisma lo rechaza) y
 * `?page=99999999999999999999` desbordaba el int64 de Postgres.
 *
 * POR QUE UNA FACTORY Y NO UNA CLASE FIJA: el techo de `limit` no puede ser el mismo para todos.
 * Una fila de auditoria es un renglon; una de `file` arrastra el uploader y hasta 5 relaciones
 * por el `include`. Y el techo de chat NO PUEDE bajar de 100 porque el portal pide exactamente
 * `?limit=100` (portal/tickets/[ticketId]/page.tsx:129): con 50 esa pantalla se caeria con un
 * 400. Los numeros de cada endpoint estan en el spec (R6/D3).
 *
 * ⚠️ DUPLICACION DELIBERADA, no un olvido: `ListTicketsQueryDto` (ticket/dto), `ProjectFilterDto`
 * (project/dto) y `TaskFilterDto` (task/dto) repiten este mismo bloque y NO heredan de aca. Se
 * decidio no refactorizarlos (#67 D2): son tres modulos grandes, el cambio no aporta nada
 * funcional, y `ListTicketsQueryDto` tiene historia de 400s que voltearon el listado de tickets
 * (ver el comentario de list-tickets-query.dto.ts:88-92 — un `projectId` sin declarar tiraba 400
 * y el error sobrevivia al refresh porque el filtro se persiste en cookie 30 dias). Si algun dia
 * se unifican, ese es el orden de riesgo: task, project, ticket.
 *
 * ⚠️ OJO AL BORDE: `main.ts:72-79` corre el ValidationPipe global con
 * `forbidNonWhitelisted: true`. Un query param que el DTO NO declare pasa de "ignorado" a **400**.
 * Antes de poner uno de estos en un endpoint hay que mirar QUE manda cada consumidor.
 */

/**
 * Techo de `page`, comun a todos los endpoints.
 *
 * Con el `limit` maximo mas alto del repo (200, el de auditoria), el peor `skip` posible es
 * 10_000 * 200 = 2e6 — trece ordenes de magnitud por debajo del techo de un int64 con signo
 * (~9.2e18), que es lo que desbordaba con `?page=99999999999999999999`. No recorta nada real:
 * ninguna pantalla tiene 10.000 paginas, asi que capear solo cambia CUAL pagina vacia se pide.
 */
export const MAX_PAGE = 10_000;

interface OpcionesPaginacion {
  /** Valor que toma `limit` cuando el cliente no lo manda. Es el default de HOY de cada service. */
  defaultLimit: number;
  /** Techo de `limit`. Se elige por endpoint segun cuanto pesa una fila. */
  maxLimit: number;
}

/**
 * Devuelve una clase DTO de paginacion por offset (`page` + `limit`) con el techo pedido.
 *
 * Se usa como `class ListaDto extends paginationQueryDto({ defaultLimit: 50, maxLimit: 200 }) {}`,
 * que es lo que permite sumarle campos propios al endpoint que los necesite.
 */
export function paginationQueryDto({ defaultLimit, maxLimit }: OpcionesPaginacion) {
  class PaginationQuery {
    @ApiPropertyOptional({
      default: 1,
      minimum: 1,
      maximum: MAX_PAGE,
      description: 'Numero de pagina (1-based)',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: 'page tiene que ser un numero entero' })
    @Min(1, { message: 'page tiene que ser al menos 1' })
    @Max(MAX_PAGE, { message: `page no puede exceder ${MAX_PAGE}` })
    page?: number = 1;

    @ApiPropertyOptional({
      default: defaultLimit,
      minimum: 1,
      maximum: maxLimit,
      description: 'Cantidad de resultados por pagina',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: 'limit tiene que ser un numero entero' })
    @Min(1, { message: 'limit tiene que ser al menos 1' })
    @Max(maxLimit, { message: `limit no puede exceder ${maxLimit}` })
    limit?: number = defaultLimit;
  }

  return PaginationQuery;
}

/**
 * Idem para los listados que paginan por CURSOR y no por offset.
 *
 * El unico caso hoy es `GET channels/:channelId/messages`: el service filtra con
 * `where.id = { lt: cursor }` (chat.service.ts:379-380), no con `skip`. Meterle un `page` seria
 * declarar un parametro que nadie lee — y con `forbidNonWhitelisted` eso encima invitaria al
 * frontend a mandar algo que se ignora en silencio.
 */
export function cursorPaginationQueryDto({ defaultLimit, maxLimit }: OpcionesPaginacion) {
  class CursorPaginationQuery {
    @ApiPropertyOptional({ description: 'ID del ultimo elemento de la pagina anterior' })
    @IsOptional()
    @IsString()
    cursor?: string;

    @ApiPropertyOptional({ default: defaultLimit, minimum: 1, maximum: maxLimit })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: 'limit tiene que ser un numero entero' })
    @Min(1, { message: 'limit tiene que ser al menos 1' })
    @Max(maxLimit, { message: `limit no puede exceder ${maxLimit}` })
    limit?: number = defaultLimit;
  }

  return CursorPaginationQuery;
}
