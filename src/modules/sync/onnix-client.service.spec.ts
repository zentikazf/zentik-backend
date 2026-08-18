import { Logger } from '@nestjs/common';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { OnnixClientService } from './onnix-client.service';
import { AppConfigService } from '../../config/app.config';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { OnnixUpstreamError } from './errors';

// Los getters de AppConfigService son read-only; el mock los hace asignables en
// runtime pero TS sigue viendo el tipo real. Cast puntual, mismo molde que
// outbox.service.spec.ts.
type WritableConfig = { -readonly [K in keyof AppConfigService]: AppConfigService[K] };

const CODE = 'TK-2026-000123';
const TRACE = 'trace_1';
const ROW_ID = 'row_cuid_1';

/**
 * Tests de OnnixClientService (#51 FIX 8/9/10).
 *
 * `fetch` MOCKEADO: estos tests NUNCA salen a la red ni tocan Onnix real. Redis
 * tambien mockeado, con el token ya cacheado para que ninguna prueba pase por el
 * login (no es lo que se esta probando aca).
 *
 * El foco son los tres modos de fallo SILENCIOSOS del cliente HTTP, que es donde
 * duele: el OpenAPI de Onnix esta escrito a mano y no se puede tomar como contrato
 * firme. Los tres se detectan de este lado o no se detectan nunca.
 */
describe('OnnixClientService — contrato de comentarios (#51)', () => {
  let service: OnnixClientService;
  let config: DeepMockProxy<AppConfigService> & WritableConfig;
  let redis: DeepMockProxy<RedisService>;
  let fetchMock: jest.Mock;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & WritableConfig;
    config.onnixBaseUrl = 'https://osd.test/api';
    config.onnixHttpTimeoutMs = 15000;
    redis = mockDeep<RedisService>();
    // Token ya cacheado: ninguna prueba de abajo depende del login.
    redis.get.mockResolvedValue('token_cacheado');

    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    // El service instancia su propio Logger; se espia el prototipo.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    service = new OnnixClientService(config, redis);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Response minima: el cliente solo usa `status`, `ok` y `text()`. */
  function respond(status: number, body: unknown): void {
    fetchMock.mockResolvedValueOnce({
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
    });
  }

  /**
   * #51 FIX 8 — el ancla del dedup puede no existir nunca.
   *
   * El OpenAPI documenta el 201 de `POST /tickets/{code}/comentarios` como un
   * `TicketComentario` PELADO, mientras el GET del MISMO path devuelve
   * `{ data: [...] }`. Si OSD en realidad responde `{ data: { id } }`, mirar solo
   * `body.id` deja `externalId` en undefined SIEMPRE: ninguna fila queda anclada y
   * el dedup se queda ciego para siempre. Su modo de fallo no es duplicar, es
   * PERDER. Por eso aceptamos los dos envoltorios.
   */
  describe('addComment — FIX 8: el id se extrae de los DOS envoltorios', () => {
    it('201 con el objeto PELADO (lo que dice el OpenAPI) -> devuelve el id', async () => {
      respond(201, { id: 987, is_internal: false });

      const outcome = await service.addComment(CODE, 'hola', false, TRACE, ROW_ID);

      expect(outcome.ok).toBe(true);
      expect(outcome.data?.id).toBe(987);
      expect(warn).not.toHaveBeenCalled();
    });

    it('201 envuelto en `{ data: { id } }` (Resource de Laravel) -> TAMBIEN devuelve el id', async () => {
      respond(201, { data: { id: 654, is_internal: false } });

      const outcome = await service.addComment(CODE, 'hola', false, TRACE, ROW_ID);

      // Este es el caso que rompia el dedup entero en silencio.
      expect(outcome.data?.id).toBe(654);
      expect(warn).not.toHaveBeenCalled();
    });

    it('id como string numerico (cast del modelo) -> se normaliza a number', async () => {
      // El dispatcher lo persiste como externalId y el dedup compara `String(id)`:
      // si dejaramos el string crudo, un '654' vs 654 seguiria funcionando, pero un
      // ' 654' no. Se normaliza una sola vez, aca.
      respond(201, { data: { id: '654' } });

      const outcome = await service.addComment(CODE, 'hola', false, TRACE, ROW_ID);

      expect(outcome.data?.id).toBe(654);
    });

    it('201 SIN id usable -> WARN explicito, nunca silencioso, y la fila igual queda synced', async () => {
      respond(201, { created_at: '2026-08-11T10:00:00Z' });

      const outcome = await service.addComment(CODE, 'hola', false, TRACE, ROW_ID);

      // No se falla la fila: el comentario YA esta en OSD y OSD no tiene delete ni
      // update. Reintentar solo agregaria un duplicado.
      expect(outcome.ok).toBe(true);
      expect(outcome.data?.id).toBeUndefined();
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain('sin id');
      expect(msg).toContain('ancla');
      // Trazable hasta la fila concreta para poder auditarlo a mano.
      expect(msg).toContain(ROW_ID);
      expect(msg).toContain(CODE);
    });

    it('200 con body vacio -> WARN, sin romper (parseJson devuelve null)', async () => {
      respond(200, undefined);

      const outcome = await service.addComment(CODE, 'hola', false, TRACE, ROW_ID);

      expect(outcome.ok).toBe(true);
      expect(outcome.data?.id).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });

    it('el WARN NUNCA incluye el cuerpo del comentario (es conversacion del cliente)', async () => {
      const secreto = 'el cliente no paga hace 3 meses';
      respond(201, {});

      await service.addComment(CODE, secreto, true, TRACE, ROW_ID);

      for (const call of [...warn.mock.calls, ...error.mock.calls]) {
        expect(String(call[0])).not.toContain(secreto);
      }
    });
  });

  /**
   * #51 FIX 9 — la nota interna puede publicarse como PUBLICA.
   *
   * El OpenAPI de OSD dice textual que `is_internal=true` requiere el permiso
   * `tickets.internal_note`, y que si el usuario NO lo tiene el comentario se guarda
   * como PUBLICO — con 201, no con 403. Sin este chequeo, cada nota interna del
   * staff quedaria visible para el cliente y de nuestro lado la fila `synced` sin
   * una sola alerta.
   */
  describe('addComment — FIX 9: nota interna degradada a publica', () => {
    it('pedimos is_internal=true y OSD devuelve false -> ERROR de alta severidad', async () => {
      respond(201, { id: 1, is_internal: false });

      await service.addComment(CODE, 'nota interna', true, TRACE, ROW_ID);

      expect(error).toHaveBeenCalledTimes(1);
      const msg = String(error.mock.calls[0][0]);
      // El mensaje tiene que nombrar la consecuencia, no solo el mismatch: quien lo
      // lee en un log a las 3am tiene que entender que hay una fuga.
      expect(msg).toContain('VISIBLE PARA EL CLIENTE');
      expect(msg).toContain('tickets.internal_note');
      expect(msg).toContain(ROW_ID);
      expect(msg).toContain(CODE);
    });

    it('la fila NO se falla: el comentario ya esta en OSD (reintentar duplica)', async () => {
      respond(201, { id: 1, is_internal: false });

      const outcome = await service.addComment(CODE, 'nota interna', true, TRACE, ROW_ID);

      expect(outcome.ok).toBe(true);
      expect(outcome.data?.id).toBe(1);
    });

    it('coincide con lo pedido -> ni un log (no se grita en el camino feliz)', async () => {
      respond(201, { id: 2, is_internal: true });

      await service.addComment(CODE, 'nota interna', true, TRACE, ROW_ID);

      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('OSD no devuelve is_internal -> no se asume nada (no gritamos por una respuesta escueta)', async () => {
      respond(201, { id: 3 });

      await service.addComment(CODE, 'nota interna', true, TRACE, ROW_ID);

      expect(error).not.toHaveBeenCalled();
    });

    it('detecta el mismatch tambien con el envoltorio `{ data: ... }`', async () => {
      respond(201, { data: { id: 4, is_internal: false } });

      await service.addComment(CODE, 'nota interna', true, TRACE, ROW_ID);

      expect(error).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * #51 FIX 10 — `GET /comentarios` puede venir paginado.
   *
   * `{ data: [...] }` es el envoltorio de un `LengthAwarePaginator` de Laravel, que
   * pagina por default las colecciones grandes. Si pagina, el dedup compara contra
   * una vista PARCIAL del hilo: no encuentra su POST perdido y re-postea. La
   * direccion del fallo es la buena (duplicar, no perder), pero tiene que ser
   * visible o parece un bug del dedup.
   */
  describe('listComments — FIX 10: paginacion', () => {
    it('respuesta sin meta/links -> devuelve los comentarios sin ruido', async () => {
      respond(200, { data: [{ id: 1 }, { id: 2 }] });

      const comments = await service.listComments(CODE, TRACE);

      expect(comments).toHaveLength(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it('`links.next` no-null -> WARN "pagina parcial"', async () => {
      respond(200, {
        data: [{ id: 1 }],
        links: { next: 'https://osd.test/api/tickets/X/comentarios?page=2' },
      });

      await service.listComments(CODE, TRACE);

      expect(String(warn.mock.calls[0][0])).toContain('pagina parcial');
    });

    it('`meta.last_page > 1` -> WARN aunque links no venga', async () => {
      respond(200, { data: [{ id: 1 }], meta: { current_page: 1, last_page: 3, total: 45 } });

      await service.listComments(CODE, TRACE);

      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain('PAGINADOS');
      expect(msg).toContain('lastPage=3');
      expect(msg).toContain(CODE);
    });

    it('`meta.total` mayor que lo recibido -> WARN (red de seguridad si el paginator cambia de forma)', async () => {
      respond(200, { data: [{ id: 1 }, { id: 2 }], meta: { total: 40 } });

      await service.listComments(CODE, TRACE);

      expect(warn).toHaveBeenCalled();
    });

    it('una sola pagina completa (`last_page: 1`, total == recibidos) -> sin WARN', async () => {
      respond(200, { data: [{ id: 1 }, { id: 2 }], meta: { current_page: 1, last_page: 1, total: 2 } });

      await service.listComments(CODE, TRACE);

      expect(warn).not.toHaveBeenCalled();
    });

    it('body sin `data` -> [] y sin WARN de paginacion (el dedup simplemente postea)', async () => {
      respond(200, {});

      expect(await service.listComments(CODE, TRACE)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('el WARN NO incluye los comentarios, solo metadata (R27)', async () => {
      const texto = 'datos sensibles del ticket';
      respond(200, { data: [{ id: 1, comment: texto }], meta: { last_page: 2 } });

      await service.listComments(CODE, TRACE);

      expect(String(warn.mock.calls[0][0])).not.toContain(texto);
    });

    it('status != 2xx -> OnnixUpstreamError (si NO podemos preguntar, NO se postea a ciegas)', async () => {
      respond(500, { message: 'boom' });

      await expect(service.listComments(CODE, TRACE)).rejects.toBeInstanceOf(
        OnnixUpstreamError,
      );
    });
  });

  // ── #52 T1 — getTeamMembers + assignTicket ─────────────────────────────────

  describe('getTeamMembers — #52 R4.1', () => {
    const MIEMBROS = [
      { id: 10, name: 'Ada', email: 'amereles@onnix.com.py', is_active: true },
      { id: 14, name: 'Josue', email: 'cfarias@onnix.com.py', is_active: true },
    ];

    it('pega a GET /equipos/{id}/usuarios y devuelve el array pelado', async () => {
      respond(200, MIEMBROS);

      const res = await service.getTeamMembers(2, TRACE);

      expect(res).toEqual(MIEMBROS);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://osd.test/api/equipos/2/usuarios');
      expect(init.method).toBe('GET');
    });

    it('⚠️ FIX 8 aplicado: tambien acepta el `{ data: [...] }` de Laravel', async () => {
      // Dentro del MISMO OpenAPI de OSD conviven colecciones peladas (`/catalogos/*`)
      // y envueltas (`/tickets/{code}/comentarios`), porque las anotaciones estan
      // escritas a mano sobre `JsonResource`. Adivinar mal aca no explota: el seed
      // mapea CERO usuarios y todo el equipo cae en el skip+warn del dispatcher —
      // el modo de fallo mas caro de diagnosticar que hay.
      respond(200, { data: MIEMBROS });

      expect(await service.getTeamMembers(2, TRACE)).toEqual(MIEMBROS);
    });

    it('body inesperado -> array vacio, nunca una excepcion de forma', async () => {
      respond(200, { algo: 'raro' });

      expect(await service.getTeamMembers(2, TRACE)).toEqual([]);
    });

    it('status != 2xx -> OnnixUpstreamError (mejor un error visible que un reporte con ceros)', async () => {
      respond(403, { message: 'sin permiso' });

      await expect(service.getTeamMembers(2, TRACE)).rejects.toBeInstanceOf(
        OnnixUpstreamError,
      );
    });
  });

  describe('assignTicket — #52 R4.2', () => {
    const BODY = { assigned_to: 10, reason: 'Sincronizado desde Zentik' };

    it('200 -> outcome ok, con el body en POST /tickets/{code}/asignar', async () => {
      respond(200, { id: 1, code: CODE });

      const res = await service.assignTicket(CODE, BODY, TRACE);

      expect(res.ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://osd.test/api/tickets/${CODE}/asignar`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual(BODY);
    });

    it('⚠️ 422 NO lanza: vuelve como outcome para que el dispatcher lo skipee sin DLQ', async () => {
      // La clasificacion del cerco vive en `processAssign`, no aca. Si el cliente
      // lanzara, el 422 entraria por `handleUpstreamFailure` y terminaria en la DLQ
      // tras quemar el cap de intentos — justo lo que R3.3 prohibe.
      respond(422, { message: 'El usuario no pertenece a tu equipo' });

      const res = await service.assignTicket(CODE, BODY, TRACE);

      expect(res).toEqual({
        ok: false,
        status: 422,
        message: 'El usuario no pertenece a tu equipo',
      });
    });

    it('403 (permiso faltante) SI lanza: es configuracion rota, tiene que doler', async () => {
      // R0.3: `tickets.assign` y `tickets.reassign` son permisos distintos. Un 403
      // no puede degradar en silencio como el 422 del cerco.
      respond(403, { message: 'sin permiso' });

      await expect(service.assignTicket(CODE, BODY, TRACE)).rejects.toBeInstanceOf(
        OnnixUpstreamError,
      );
    });

    it('5xx -> OnnixUpstreamError (reintentable, mismo molde que setEstado)', async () => {
      respond(503, { message: 'boom' });

      await expect(service.assignTicket(CODE, BODY, TRACE)).rejects.toBeInstanceOf(
        OnnixUpstreamError,
      );
    });

    it('el code va URL-encodeado (molde de setEstado/addComment)', async () => {
      respond(200, { id: 1, code: 'TK/2026' });

      await service.assignTicket('TK/2026', BODY, TRACE);

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://osd.test/api/tickets/TK%2F2026/asignar',
      );
    });
  });
});
