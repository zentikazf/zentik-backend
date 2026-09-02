import { ValidationPipe, BadRequestException, ArgumentMetadata } from '@nestjs/common';
import { ListAuditQueryDto } from '../../modules/audit/dto/list-audit-query.dto';
import { ListFilesQueryDto } from '../../modules/file/dto/list-files-query.dto';
import { ListNotificationsQueryDto } from '../../modules/notification/dto/list-notifications-query.dto';
import { ListMessagesQueryDto } from '../../modules/chat/dto/list-messages-query.dto';
import { ListCommentsQueryDto } from '../../modules/comment/dto/list-comments-query.dto';

/**
 * #67 — El eslabón entre "class-validator funciona" y "el endpoint devuelve 400".
 *
 * `pagination-query.dto.spec.ts` valida con `validateSync` directo, y
 * `pagination-endpoints.spec.ts` verifica el cableado por texto. Ninguno de los dos prueba lo
 * que realmente corre en producción: el **ValidationPipe global de Nest**, con la config exacta
 * de `main.ts:72-79`. Este archivo lo instancia con esos mismos flags y le pasa los DTOs reales.
 *
 * Es el lugar donde aparecerían dos cosas que los otros dos tests no pueden ver:
 *
 *   1. Que `transform: true` + `enableImplicitConversion` conviertan de verdad los strings de
 *      `req.query` (y no dejen `page` como `'2'`, que despues rompe el `skip` de Prisma).
 *   2. Que `forbidNonWhitelisted: true` convierta un query param NO DECLARADO en 400. Ese es el
 *      unico modo en que este spec podia romper una pantalla: hasta ahora esos params se
 *      IGNORABAN. Ya paso una vez — ver list-tickets-query.dto.ts:88-92, donde un `projectId`
 *      sin declarar volteo el listado de tickets con un 400 que sobrevivia al refresh.
 */
describe('ValidationPipe real sobre los DTOs de paginación (#67)', () => {
  // Exactamente main.ts:72-79. Si esa config cambia, este archivo tiene que cambiar con ella.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const meta = (metatype: unknown): ArgumentMetadata => ({
    type: 'query',
    metatype: metatype as ArgumentMetadata['metatype'],
    data: undefined,
  });

  const pasar = (Dto: unknown, query: Record<string, unknown>) =>
    pipe.transform(query, meta(Dto));

  const DTOS: Array<[string, unknown, number]> = [
    ['audit', ListAuditQueryDto, 50],
    ['file', ListFilesQueryDto, 20],
    ['notification', ListNotificationsQueryDto, 20],
    ['comment', ListCommentsQueryDto, 50],
  ];

  // ── El camino bueno, endpoint por endpoint ────────────────────────────

  it.each(DTOS)('%s: sin query params devuelve los defaults ya convertidos', async (_n, Dto, limit) => {
    const salida = (await pasar(Dto, {})) as { page: number; limit: number };

    expect([salida.page, salida.limit]).toEqual([1, limit]);
    expect(typeof salida.limit).toBe('number');
  });

  it.each(DTOS)('%s: ?page=2&limit=10 llega como NUMEROS, no como strings', async (_n, Dto) => {
    const salida = (await pasar(Dto, { page: '2', limit: '10' })) as { page: number; limit: number };

    // El `typeof` es el punto: un `'2'` que se cuela sin convertir hace `('2' - 1) * 10` = 10
    // por coerción, pero `('2' - 1)` con otro operador rompe. El DTO tiene que entregar números.
    expect([typeof salida.page, typeof salida.limit]).toEqual(['number', 'number']);
    expect([salida.page, salida.limit]).toEqual([2, 10]);
  });

  // ── El camino malo: 400, no 500 ───────────────────────────────────────

  it.each(DTOS)('%s: ?page=abc lanza BadRequest (antes era un 500 de Prisma)', async (_n, Dto) => {
    await expect(pasar(Dto, { page: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(DTOS)('%s: ?limit=abc lanza BadRequest', async (_n, Dto) => {
    await expect(pasar(Dto, { limit: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(DTOS)('%s: ?page=0 lanza BadRequest (skip negativo)', async (_n, Dto) => {
    await expect(pasar(Dto, { page: '0' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(DTOS)('%s: ?page=99999999999999999999 lanza BadRequest (desborde int64)', async (_n, Dto) => {
    await expect(pasar(Dto, { page: '99999999999999999999' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each(DTOS)('%s: ?limit=1000000 lanza BadRequest (devolvía la tabla entera)', async (_n, Dto) => {
    await expect(pasar(Dto, { limit: '1000000' })).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── forbidNonWhitelisted: el riesgo de romper una pantalla ────────────

  describe('forbidNonWhitelisted — el param de más ahora es 400, antes se ignoraba', () => {
    it('un param no declarado es rechazado', async () => {
      await expect(pasar(ListAuditQueryDto, { page: '1', inventado: 'x' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    /**
     * La contracara, y la razón por la que R3 del spec revisó los 8 consumidores uno por uno:
     * estos son los query strings EXACTOS que manda hoy el frontend. Si alguno fuera rechazado,
     * la pantalla se cae con un 400 y este test es el que lo tiene que decir — no el usuario.
     */
    it.each([
      ['settings/audit-log/page.tsx:164', ListAuditQueryDto, { page: '1', limit: '20' }],
      ['activity-feed.tsx:127', ListAuditQueryDto, { page: '1', limit: '15' }],
      ['notification-panel.tsx:68', ListNotificationsQueryDto, { page: '1', limit: '30' }],
      ['portal/notifications/page.tsx:58', ListNotificationsQueryDto, { page: '1', limit: '15' }],
      ['topbar.tsx:100', ListNotificationsQueryDto, { limit: '1' }],
      ['portal/page.tsx:39', ListNotificationsQueryDto, { limit: '5' }],
      ['projects/[projectId]/files/page.tsx:104', ListFilesQueryDto, {}],
      ['client-documents-section.tsx:101', ListFilesQueryDto, {}],
      ['task-detail-content.tsx:143', ListCommentsQueryDto, {}],
    ])('%s sigue pasando', async (_donde, Dto, query) => {
      await expect(pasar(Dto, query)).resolves.toBeDefined();
    });
  });

  // ── El de cursor, aparte ──────────────────────────────────────────────

  describe('chat — paginación por cursor', () => {
    it('sin params: limit 50 y cursor undefined', async () => {
      const salida = (await pasar(ListMessagesQueryDto, {})) as { limit: number; cursor?: string };

      expect([salida.limit, salida.cursor]).toEqual([50, undefined]);
    });

    it.each([
      ['chat-window.tsx:52', { limit: '50' }],
      ['portal/tickets/[ticketId]/page.tsx:129', { limit: '100' }],
    ])('%s sigue pasando', async (_donde, query) => {
      await expect(pasar(ListMessagesQueryDto, query)).resolves.toBeDefined();
    });

    it('acepta cursor y lo deja como string', async () => {
      const salida = (await pasar(ListMessagesQueryDto, { cursor: 'clx1', limit: '20' })) as {
        cursor: string;
        limit: number;
      };

      expect([salida.cursor, salida.limit]).toEqual(['clx1', 20]);
    });

    it('?page= es rechazado: acá no existe la paginación por offset', async () => {
      await expect(pasar(ListMessagesQueryDto, { page: '2' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('?limit=101 es rechazado (techo)', async () => {
      await expect(pasar(ListMessagesQueryDto, { limit: '101' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
