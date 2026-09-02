import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { ListAuditQueryDto } from '../../modules/audit/dto/list-audit-query.dto';
import { ListFilesQueryDto } from '../../modules/file/dto/list-files-query.dto';
import { ListNotificationsQueryDto } from '../../modules/notification/dto/list-notifications-query.dto';
import { ListMessagesQueryDto } from '../../modules/chat/dto/list-messages-query.dto';
import { ListCommentsQueryDto } from '../../modules/comment/dto/list-comments-query.dto';

/**
 * #67 T7.1 — el cerrojo: nadie vuelve a leer `page`/`limit` como string suelto.
 *
 * Es el equivalente de `permissions-catalog.spec.ts` (#66) para este bug. Aquel caza el
 * `@Permissions` que nombra un permiso inexistente; éste caza el `@Query('page') page?: string`.
 *
 * POR QUE HACE FALTA: el bug de este spec no era uno, eran nueve copias del mismo patrón,
 * sembradas de a una a lo largo de meses. Arreglar las nueve sin dejar un guard significa que la
 * décima vuelve en el próximo endpoint que alguien escriba — y el síntoma es un HTTP 500, que
 * sólo aparece cuando alguien manda un query param raro.
 *
 * El escaneo es de texto sobre el fuente, no de metadata en runtime: importar los 32 controllers
 * arrastraría el árbol entero de dependencias (Prisma, Redis, colas) a un test que sólo necesita
 * leer strings.
 */
describe('Paginación — ningún controller lee page/limit como string suelto (#67)', () => {
  const SRC = join(__dirname, '..', '..');

  /**
   * Excepciones declaradas. Cada una tiene que justificarse acá; agregar una obliga a tocar este
   * archivo, que es exactamente el punto de fricción que se busca.
   *
   * `client.controller.ts` — usa el helper `parsePaginationParam` (:57-60), la solución que
   * eligió #57, más los techos `CLIENT_LIST_MAX_PAGE` / `CLIENT_LIST_MAX_LIMIT` del service
   * (client.service.ts:72-77). Difiere de un DTO en el comportamiento ante basura (cae al
   * default en vez de devolver 400), pero está validado y acotado en los dos extremos. Migrarlo
   * al DTO es un cambio de contrato observable sin beneficio: quedó fuera de #67 a propósito.
   */
  const EXENTOS = new Set(['modules/client/client.controller.ts']);

  function archivos(dir: string, sufijo: string): string[] {
    const salida: string[] = [];
    for (const entrada of readdirSync(dir)) {
      if (entrada === 'node_modules' || entrada === 'dist') continue;
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta, sufijo));
      else if (entrada.endsWith(sufijo)) salida.push(ruta);
    }
    return salida;
  }

  /** `@Query('page')` / `@Query('limit')` / `@Query('offset')` declarados como string. */
  function crudos(): string[] {
    const salida: string[] = [];

    for (const archivo of archivos(SRC, '.controller.ts')) {
      const rel = relative(SRC, archivo).replace(/\\/g, '/');
      if (EXENTOS.has(rel)) continue;

      readFileSync(archivo, 'utf8')
        .split('\n')
        .forEach((linea, i) => {
          if (/^\s*(\*|\/\/)/.test(linea)) return; // los comentarios citan código en prosa
          if (/@Query\(\s*'(page|limit|offset)'\s*\)/.test(linea)) {
            salida.push(`${rel}:${i + 1} → ${linea.trim()}`);
          }
        });
    }

    return salida;
  }

  const CONTROLLERS = archivos(SRC, '.controller.ts');

  it('el escaneo encuentra los controllers (si no, todo lo de abajo es un falso verde)', () => {
    expect(CONTROLLERS.length).toBeGreaterThanOrEqual(30);
  });

  it('ningún @Query("page"|"limit"|"offset") suelto fuera de las excepciones declaradas', () => {
    expect(crudos()).toEqual([]);
  });

  it('la excepción declarada sigue existiendo y sigue usando el helper de #57', () => {
    // Si alguien migra `client.controller.ts` al DTO, esto se pone rojo y recuerda sacar la
    // excepción de la lista — que si no, queda tapando un controller que ya no la necesita.
    const contenido = readFileSync(join(SRC, 'modules/client/client.controller.ts'), 'utf8');

    expect(contenido).toContain('parsePaginationParam');
    expect(contenido).toMatch(/@Query\(\s*'page'\s*\)/);
  });

  /**
   * Los nueve endpoints que #67 convirtió. Se verifica que su controller importe un DTO de
   * paginación: sin esto, alguien podría "arreglar" el caso de arriba borrando el `@Query` y
   * dejando el endpoint sin paginar.
   */
  it.each([
    ['audit', 'modules/audit/audit.controller.ts', 'ListAuditQueryDto'],
    ['file', 'modules/file/file.controller.ts', 'ListFilesQueryDto'],
    ['notification', 'modules/notification/notification.controller.ts', 'ListNotificationsQueryDto'],
    ['chat', 'modules/chat/chat.controller.ts', 'ListMessagesQueryDto'],
    ['comment', 'modules/comment/comment.controller.ts', 'ListCommentsQueryDto'],
  ])('%s usa su DTO de paginación', (_modulo, ruta, dto) => {
    const contenido = readFileSync(join(SRC, ruta), 'utf8');

    expect(contenido).toContain(dto);
    expect(contenido).toContain(`@Query() query: ${dto}`);
  });

  it('los cinco DTOs salen de la factory común, no de un @Max copiado a mano', () => {
    for (const ruta of [
      'modules/audit/dto/list-audit-query.dto.ts',
      'modules/file/dto/list-files-query.dto.ts',
      'modules/notification/dto/list-notifications-query.dto.ts',
      'modules/chat/dto/list-messages-query.dto.ts',
      'modules/comment/dto/list-comments-query.dto.ts',
    ]) {
      const contenido = readFileSync(join(SRC, ruta), 'utf8');
      expect([ruta, /(cursorP|p)aginationQueryDto\(/.test(contenido)]).toEqual([ruta, true]);
    }
  });

  /**
   * El assert de presencia de R5.2, y el más importante del archivo.
   *
   * Todo lo demás verifica que la basura se RECHACE. Esto verifica que el camino bueno no se
   * movió: si un DTO cambiara su `defaultLimit`, la pantalla correspondiente empezaría a traer
   * otra cantidad de filas sin que falle nada y sin que nadie lo note. Los números son los que
   * tenían las firmas de los services ANTES de #67, con el archivo:línea de cada uno.
   */
  describe('los defaults no se movieron (R5.2)', () => {
    it.each([
      ['audit — audit.service.ts:48/:67/:98', ListAuditQueryDto, 1, 50],
      ['file — file.service.ts:138/:175/:486', ListFilesQueryDto, 1, 20],
      ['notification — notification.service.ts:81', ListNotificationsQueryDto, 1, 20],
      ['comment — comment.service.ts:53', ListCommentsQueryDto, 1, 50],
    ])('%s', (_caso, Dto, page, limit) => {
      const dto = new (Dto as new () => { page?: number; limit?: number })();

      expect([dto.page, dto.limit]).toEqual([page, limit]);
    });

    it('chat — chat.service.ts:357 (por cursor, sin page)', () => {
      const dto = new ListMessagesQueryDto();

      expect(dto.limit).toBe(50);
      expect(dto.cursor).toBeUndefined();
    });
  });
});
