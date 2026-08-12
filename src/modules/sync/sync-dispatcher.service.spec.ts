import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { TicketStatus } from '@prisma/client';
import { SyncDispatcherService } from './sync-dispatcher.service';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService } from './outbox.service';
import { OnnixClientService } from './onnix-client.service';
import { OnnixMappingService } from './onnix-mapping.service';
import { OnnixUpstreamError } from './errors';
import { OutboxEventType, OutboxRow } from './types/outbox.types';
import {
  OnnixCallOutcome,
  OnnixTicketComentario,
  OnnixTicketDetalle,
} from './types/onnix.types';

// Cast puntual documentado: getters read-only de AppConfigService.
type WritableConfig = { -readonly [K in keyof AppConfigService]: AppConfigService[K] };

/**
 * Tests de SyncDispatcherService (feature #13).
 *
 * Prisma MOCKEADO, Onnix MOCKEADO (OnnixClientService), mapping MOCKEADO. NUNCA
 * toca DATABASE_URL ni HTTP real. El backoff (retryWithJitter) se neutraliza
 * espiando el sleep privado para que los tests de 5xx no tarden.
 *
 * Cubre: T20 (happy path create+code), T21 (5xx/422/auth), T22 (idempotencia
 * external_id), T23 (estado SET idempotente + ordering gate).
 *
 * #50 suma: T6 (COMMENT_ADDED — gate de orden, prefijos, snapshot de nota interna,
 * truncado, dry-run, clasificacion de errores) y T7 (drain-on-enqueue con debounce
 * + el cron que sigue siendo la red de seguridad).
 */
describe('SyncDispatcherService', () => {
  let service: SyncDispatcherService;
  let prisma: DeepMockProxy<PrismaService>;
  let config: DeepMockProxy<AppConfigService> & WritableConfig;
  let outbox: DeepMockProxy<OutboxService>;
  let onnix: DeepMockProxy<OnnixClientService>;
  let mapping: DeepMockProxy<OnnixMappingService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & WritableConfig;
    outbox = mockDeep<OutboxService>();
    onnix = mockDeep<OnnixClientService>();
    mapping = mockDeep<OnnixMappingService>();

    config.onnixSyncEnabled = true;
    config.onnixSyncBatchSize = 50;
    config.onnixSyncMaxAttempts = 3;
    config.onnixDlqMaxAgeMin = 1440;
    // Default: simulacro APAGADO. mockDeep auto-stub-earia el getter a una funcion
    // (truthy); lo fijamos explicito para que el camino normal (POST real) corra en
    // todos los tests salvo los de dry-run.
    config.onnixSyncDryRun = false;
    // Debounce del drain-on-enqueue (#50 R4.1). Explicito y no auto-stub: mockDeep
    // devolveria una funcion y setTimeout la interpretaria como NaN → 1ms, lo que
    // haria pasar por accidente los tests de "no corre antes del debounce".
    config.onnixSyncDrainDebounceMs = 3000;

    service = new SyncDispatcherService(prisma, config, outbox, onnix, mapping);
    // Neutraliza los backoffs reales (retryWithJitter -> sleep) para tests rapidos.
    jest
      .spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    // checkDlqAge no es el foco de estos tests.
    prisma.outboxEvent.findFirst.mockResolvedValue(null);
  });

  /**
   * Espia el logger PRIVADO de la instancia (no Logger.prototype) para poder
   * afirmar sobre lo que se escribe. Critico en #50: el dry-run tiene que loggear
   * el prefijo y el largo pero NUNCA el cuerpo del mensaje (R5.3/D9).
   */
  function spyLog(level: 'log' | 'warn' | 'error'): jest.SpyInstance {
    const logger = (service as unknown as { logger: Logger }).logger;
    return jest.spyOn(logger, level).mockImplementation(() => undefined);
  }

  describe('flag maestro', () => {
    it('processPending con flag off no toca el outbox', async () => {
      config.onnixSyncEnabled = false;
      const res = await service.processPending();
      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.claim).not.toHaveBeenCalled();
    });
  });

  describe('TICKET_CREATED — T20 happy path (R13/R14/R37)', () => {
    it('R14: crea ticket, persiste external_id (code) y marca synced', async () => {
      const row = makeRow('row_1', 'TICKET_CREATED', { external_id: null });
      outbox.claim.mockResolvedValueOnce([row]);
      prisma.ticket.findUnique.mockResolvedValueOnce(makeTicket());
      mapping.resolveClientId.mockResolvedValueOnce(555);
      mapping.resolveProjectId.mockResolvedValueOnce(777);
      mapping.resolveCatalogIds.mockResolvedValueOnce({
        ticketTypeId: 10,
        ticketCategoryId: 20,
        ticketPriorityId: 30,
      });
      onnix.createTicket.mockResolvedValueOnce(okCreate('TK-2026-000123'));
      // El service guarda el code en el ticket (best-effort, .catch); el mock debe
      // devolver una promesa para que el .catch encadene.
      prisma.ticket.update.mockResolvedValueOnce({} as never);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.createTicket).toHaveBeenCalledTimes(1);
      // El mapeo se resuelve scoped por la org del ticket (multi-tenant).
      expect(mapping.resolveClientId).toHaveBeenCalledWith('org-test', 'client_1');
      expect(mapping.resolveProjectId).toHaveBeenCalledWith('org-test', 'project_1');
      // #50 R1.1: el 5º argumento es `ticket.ticketTypeId` (el tipo REAL del arbol).
      // Este fixture no lo trae → `undefined`, que es exactamente el caso R1.5
      // (ticket historico/sin tipo): la cascada cae al default de siempre y la fila
      // NUNCA falla por eso.
      expect(mapping.resolveCatalogIds).toHaveBeenCalledWith(
        'org-test',
        'SUPPORT_REQUEST',
        'MEDIUM',
        expect.any(String),
        undefined,
      );
      expect(outbox.markSynced).toHaveBeenCalledWith('row_1', 'TK-2026-000123');
      // Persiste el code en el ticket (best-effort).
      expect(prisma.ticket.update).toHaveBeenCalledWith({
        where: { id: 'ticket_1' },
        data: { onnixCode: 'TK-2026-000123' },
      });
    });

    it('#50 R1.1: reenvia el ticketTypeId REAL del arbol a la cascada de mapeo', async () => {
      // El cableado que hace posible T1: sin este 5º argumento la cascada nunca ve
      // el nodo del arbol y OSD sigue recibiendo el tipo derivado del enum.
      outbox.claim.mockResolvedValueOnce([
        makeRow('row_tt', 'TICKET_CREATED', { external_id: null }),
      ]);
      prisma.ticket.findUnique.mockResolvedValueOnce(
        makeTicket({ ticketTypeId: 'tt_nodo_hoja' }),
      );
      mapping.resolveClientId.mockResolvedValueOnce(555);
      mapping.resolveProjectId.mockResolvedValueOnce(777);
      mapping.resolveCatalogIds.mockResolvedValueOnce({
        ticketTypeId: 24,
        ticketCategoryId: 20,
        ticketPriorityId: 30,
      });
      onnix.createTicket.mockResolvedValueOnce(okCreate('TK-2026-000999'));
      prisma.ticket.update.mockResolvedValueOnce({} as never);

      await service.processPending();

      expect(mapping.resolveCatalogIds).toHaveBeenCalledWith(
        'org-test',
        'SUPPORT_REQUEST',
        'MEDIUM',
        expect.any(String),
        'tt_nodo_hoja',
      );
      // Y lo que resolvio la cascada es lo que viaja en el body, sin re-derivar.
      expect(onnix.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_type_id: 24 }),
        expect.any(String),
      );
    });

    it('R15/R16: cliente no mapeado -> failed terminal, sin POST', async () => {
      const row = makeRow('row_2', 'TICKET_CREATED', { external_id: null });
      outbox.claim.mockResolvedValueOnce([row]);
      prisma.ticket.findUnique.mockResolvedValueOnce(makeTicket());
      mapping.resolveClientId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(onnix.createTicket).not.toHaveBeenCalled();
      expect(outbox.markFailed).toHaveBeenCalledWith('row_2', expect.stringContaining('cliente no mapeado'), true);
    });
  });

  describe('TICKET_CREATED — T22 idempotencia (R13)', () => {
    it('R13: fila con external_id NO re-POSTea la creacion, marca synced', async () => {
      const row = makeRow('row_3', 'TICKET_CREATED', { external_id: 'TK-2026-000777' });
      outbox.claim.mockResolvedValueOnce([row]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.createTicket).not.toHaveBeenCalled();
      expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
      expect(outbox.markSynced).toHaveBeenCalledWith('row_3', 'TK-2026-000777');
    });
  });

  describe('TICKET_CREATED — T21 clasificacion de errores (R30/R31/R32)', () => {
    beforeEach(() => {
      prisma.ticket.findUnique.mockResolvedValue(makeTicket());
      mapping.resolveClientId.mockResolvedValue(555);
      mapping.resolveProjectId.mockResolvedValue(777);
      mapping.resolveCatalogIds.mockResolvedValue({
        ticketTypeId: 10,
        ticketCategoryId: 20,
        ticketPriorityId: 30,
      });
    });

    it('R30: 422 de validacion -> failed terminal (no reintentable)', async () => {
      outbox.claim.mockResolvedValueOnce([makeRow('row_422', 'TICKET_CREATED', { external_id: null })]);
      onnix.createTicket.mockResolvedValueOnce({
        ok: false,
        status: 422,
        message: 'client_id invalido',
      });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_422',
        expect.stringContaining('422'),
        true, // terminal
      );
    });

    it('R31: 5xx con attempts<cap -> reintentable (terminal=false, attempts++)', async () => {
      // attempts=0, cap=3 -> 0+1 < 3 -> NO capea, queda reintentable.
      outbox.claim.mockResolvedValueOnce([
        makeRow('row_5xx', 'TICKET_CREATED', { external_id: null, attempts: 0 }),
      ]);
      onnix.createTicket.mockRejectedValue(new OnnixUpstreamError(503, 'create-ticket'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith('row_5xx', expect.any(String), false);
    });

    it('R32: 5xx con attempts en el cap -> failed terminal', async () => {
      // attempts=2, cap=3 -> 2+1 >= 3 -> capea a failed terminal.
      outbox.claim.mockResolvedValueOnce([
        makeRow('row_cap', 'TICKET_CREATED', { external_id: null, attempts: 2 }),
      ]);
      onnix.createTicket.mockRejectedValue(new OnnixUpstreamError(500, 'create-ticket'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith('row_cap', expect.any(String), true);
    });

    it('R26: 401 de auth real (OnnixClientService ya intento re-login) -> reintentable', async () => {
      // El re-login lo hace OnnixClientService internamente sin contar intento;
      // si persiste 401 lanza OnnixUpstreamError(401) -> el dispatcher lo trata
      // como fallo (no se reintenta intra-drain porque <500), attempts++.
      outbox.claim.mockResolvedValueOnce([
        makeRow('row_401', 'TICKET_CREATED', { external_id: null, attempts: 0 }),
      ]);
      onnix.createTicket.mockRejectedValue(new OnnixUpstreamError(401, 'auth'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith('row_401', expect.stringContaining('401'), false);
    });
  });

  describe('STATUS_CHANGED — T23 estado SET idempotente + ordering (R21/R22/R23/R24)', () => {
    it('R23: STATUS_CHANGED sin code de creacion aun -> release (skipped, no cuenta)', async () => {
      outbox.claim.mockResolvedValueOnce([makeRow('row_st1', 'STATUS_CHANGED')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null); // creacion sin code todavia

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 }); // skipped no incrementa contadores
      expect(outbox.release).toHaveBeenCalledWith('row_st1');
      expect(onnix.setEstado).not.toHaveBeenCalled();
    });

    it('R21/R22: envia el estado ACTUAL del ticket via setEstado con slug, marca synced', async () => {
      outbox.claim.mockResolvedValueOnce([makeRow('row_st2', 'STATUS_CHANGED')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce({ status: TicketStatus.RESOLVED } as never);
      mapping.resolveStatusSlug.mockResolvedValueOnce('resuelto');
      onnix.setEstado.mockResolvedValueOnce({ ok: true, status: 200 });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      // Lee el estado ACTUAL (R22) -> resuelve slug -> setEstado(code, slug).
      expect(mapping.resolveStatusSlug).toHaveBeenCalledWith(TicketStatus.RESOLVED, expect.any(String));
      expect(onnix.setEstado).toHaveBeenCalledWith('TK-2026-000123', 'resuelto', expect.any(String));
      expect(outbox.markSynced).toHaveBeenCalledWith('row_st2');
    });

    it('R: 422 "ya esta en ese estado" = exito idempotente (synced, no failed)', async () => {
      outbox.claim.mockResolvedValueOnce([makeRow('row_st3', 'STATUS_CHANGED')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce({ status: TicketStatus.RESOLVED } as never);
      mapping.resolveStatusSlug.mockResolvedValueOnce('resuelto');
      onnix.setEstado.mockResolvedValueOnce({
        ok: false,
        status: 422,
        message: 'El ticket ya esta en ese estado',
      });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(outbox.markSynced).toHaveBeenCalledWith('row_st3');
      expect(outbox.markFailed).not.toHaveBeenCalled();
    });

    it('422 con slug inexistente (otro mensaje) -> failed terminal', async () => {
      outbox.claim.mockResolvedValueOnce([makeRow('row_st4', 'STATUS_CHANGED')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce({ status: TicketStatus.OPEN } as never);
      mapping.resolveStatusSlug.mockResolvedValueOnce('slug_inexistente');
      onnix.setEstado.mockResolvedValueOnce({
        ok: false,
        status: 422,
        message: 'status_slug no existe',
      });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith('row_st4', expect.stringContaining('422'), true);
    });
  });

  // ── #50 T6 — COMMENT_ADDED ─────────────────────────────────────────────────

  describe('COMMENT_ADDED — gate de orden (R2.4)', () => {
    it('sin code de creacion aun -> release SIN consumir intento (skipped, no cuenta)', async () => {
      outbox.claim.mockResolvedValueOnce([makeChatRow('row_c1', 'msg_1')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null); // el ticket aun no existe en OSD

      const res = await service.processPending();

      // Ni synced ni failed: la fila vuelve a pending intacta y el proximo ciclo
      // (post-creacion) la envia. Mismo mecanismo probado de STATUS_CHANGED.
      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.release).toHaveBeenCalledWith('row_c1');
      // Lo critico del gate: NO se consume intento. markFailed(terminal=false) es
      // lo que hace attempts++, asi que no puede haberse llamado en ninguna forma.
      expect(outbox.markFailed).not.toHaveBeenCalled();
      expect(outbox.markSynced).not.toHaveBeenCalled();
      expect(onnix.addComment).not.toHaveBeenCalled();
      // El gate corre ANTES de leer nada: no se toca el mensaje.
      expect(prisma.message.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('COMMENT_ADDED — chat (R2.2/R2.3)', () => {
    beforeEach(() => {
      outbox.getCreatedExternalId.mockResolvedValue('TK-2026-000123');
      onnix.addComment.mockResolvedValue(okComment());
    });

    it('R2.3: mensaje de un usuario CON clientId -> prefijo "[Cliente · Nombre] "', async () => {
      outbox.claim.mockResolvedValueOnce([makeChatRow('row_c2', 'msg_cli')]);
      prisma.message.findUnique.mockResolvedValueOnce(
        makeMessage('Hola, sigue el error', { name: 'Ana Lopez', clientId: 'client_1' }),
      );

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      const [code, comment, isInternal] = onnix.addComment.mock.calls[0];
      expect(code).toBe('TK-2026-000123');
      expect(comment).toBe('[Cliente · Ana Lopez] Hola, sigue el error');
      expect(isInternal).toBe(false);
      expect(outbox.markSynced).toHaveBeenCalledWith('row_c2');
    });

    it('R2.3: mensaje de STAFF (sin clientId) -> prefijo "[Nombre] " y is_internal=false', async () => {
      outbox.claim.mockResolvedValueOnce([makeChatRow('row_c3', 'msg_staff')]);
      prisma.message.findUnique.mockResolvedValueOnce(
        makeMessage('Ya lo estamos viendo', { name: 'Josu', clientId: null }),
      );

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      const [, comment, isInternal] = onnix.addComment.mock.calls[0];
      expect(comment).toBe('[Josu] Ya lo estamos viendo');
      // La conversacion del chat es PUBLICA en OSD (decision 2 del dueño): el
      // checkbox "solo equipo" es exclusivo de la nota interna.
      expect(isInternal).toBe(false);
    });

    it('autor sin nombre cargado -> cae al fallback "Usuario", no rompe', async () => {
      outbox.claim.mockResolvedValueOnce([makeChatRow('row_c4', 'msg_sin_nombre')]);
      prisma.message.findUnique.mockResolvedValueOnce(
        makeMessage('mensaje suelto', { name: null, clientId: null }),
      );

      await service.processPending();

      expect(onnix.addComment.mock.calls[0][1]).toBe('[Usuario] mensaje suelto');
    });

    it('R2.2: mensaje BORRADO antes del drenado -> skip con log, markSynced, sin POST ni DLQ', async () => {
      outbox.claim.mockResolvedValueOnce([makeChatRow('row_c5', 'msg_borrado')]);
      prisma.message.findUnique.mockResolvedValueOnce(null); // el usuario lo borro
      const logSpy = spyLog('log');

      const res = await service.processPending();

      // No es un defecto: el usuario deshizo algo a proposito. markSynced (no
      // markFailed) para no ensuciar la DLQ ni disparar la alerta de edad.
      expect(res).toEqual({ synced: 0, failed: 0 }); // 'skipped' no incrementa contadores
      expect(onnix.addComment).not.toHaveBeenCalled();
      expect(outbox.markFailed).not.toHaveBeenCalled();
      expect(outbox.markSynced).toHaveBeenCalledWith('row_c5');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mensaje inexistente'));
    });

    it('R2.3: cuerpo de 20.000 chars -> comment de EXACTAMENTE 10.000 conservando el prefijo', async () => {
      outbox.claim.mockResolvedValueOnce([makeChatRow('row_c6', 'msg_largo')]);
      prisma.message.findUnique.mockResolvedValueOnce(
        makeMessage('x'.repeat(20_000), { name: 'Josu', clientId: null }),
      );

      await service.processPending();

      const comment = onnix.addComment.mock.calls[0][1];
      // Limite duro de Onnix (maxLength 10000): un char de mas es un 422.
      expect(comment).toHaveLength(10_000);
      // Se recorta el CUERPO, nunca el prefijo: la atribucion del autor es lo que
      // hace trazable el comentario mientras OSD no exponga autor nativo.
      expect(comment.startsWith('[Josu] ')).toBe(true);
      expect(comment).toBe('[Josu] ' + 'x'.repeat(10_000 - '[Josu] '.length));
    });
  });

  describe('COMMENT_ADDED — nota interna (R3.2/R3.3)', () => {
    beforeEach(() => {
      outbox.getCreatedExternalId.mockResolvedValue('TK-2026-000123');
      onnix.addComment.mockResolvedValue(okComment());
      prisma.user.findUnique.mockResolvedValue({ name: 'Josu' } as never);
    });

    it('R3.3: manda el SNAPSHOT del payload tal cual, con is_internal=true, SIN releer el ticket', async () => {
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_n1', 'El cliente pidio prioridad', 'user_admin'),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      const [code, comment, isInternal] = onnix.addComment.mock.calls[0];
      expect(code).toBe('TK-2026-000123');
      expect(comment).toBe('[Josu] El cliente pidio prioridad');
      expect(isInternal).toBe(true);
      // ⚠️ El corazon de R3.2: el texto sale del payload, NO de la DB. Si alguien
      // "optimiza" esto releyendo `ticket.adminNotes`, este assert lo caza.
      expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
      // Del ticket no se lee nada; lo unico que se consulta es el autor del prefijo.
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user_admin' },
        select: { name: true },
      });
      expect(prisma.message.findUnique).not.toHaveBeenCalled();
    });

    it('R3.2: dos guardados rapidos -> DOS comentarios con los DOS textos distintos, en orden', async () => {
      // Este es EL test de R3.2. Con relectura ambas filas mandarian "version dos"
      // y OSD perderia la version intermedia: el historial dejaria de ser fiel.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_n2a', 'version uno', 'user_admin'),
        makeNoteRow('row_n2b', 'version dos', 'user_admin'),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 2, failed: 0 });
      expect(onnix.addComment).toHaveBeenCalledTimes(2);
      expect(onnix.addComment.mock.calls[0][1]).toBe('[Josu] version uno');
      expect(onnix.addComment.mock.calls[1][1]).toBe('[Josu] version dos');
      expect(onnix.addComment.mock.calls[0][2]).toBe(true);
      expect(onnix.addComment.mock.calls[1][2]).toBe(true);
      expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
    });

    it('autor inexistente -> fallback "Usuario", la nota igual viaja', async () => {
      outbox.claim.mockResolvedValueOnce([makeNoteRow('row_n3', 'nota huerfana', 'user_borrado')]);
      prisma.user.findUnique.mockResolvedValue(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment.mock.calls[0][1]).toBe('[Usuario] nota huerfana');
    });
  });

  describe('COMMENT_ADDED — payload corrupto y clasificacion de errores', () => {
    beforeEach(() => {
      outbox.getCreatedExternalId.mockResolvedValue('TK-2026-000123');
    });

    it('payload sin snapshot ni messageId -> failed TERMINAL (reintentar no lo arregla)', async () => {
      outbox.claim.mockResolvedValueOnce([
        makeRow('row_c7', 'COMMENT_ADDED', { payload: { ticketId: 'ticket_1' } }),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(onnix.addComment).not.toHaveBeenCalled();
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_c7',
        expect.stringContaining('sin adminNoteSnapshot ni messageId'),
        true,
      );
    });

    it('422 de Onnix -> failed terminal (DLQ), sin reintento', async () => {
      outbox.claim.mockResolvedValueOnce([makeNoteRow('row_c8', 'nota', 'user_admin')]);
      prisma.user.findUnique.mockResolvedValue({ name: 'Josu' } as never);
      onnix.addComment.mockResolvedValueOnce({
        ok: false,
        status: 422,
        message: 'El ticket esta cerrado',
      });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(onnix.addComment).toHaveBeenCalledTimes(1); // 422 no es transitorio
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_c8',
        expect.stringContaining('422'),
        true,
      );
      expect(outbox.markSynced).not.toHaveBeenCalled();
    });

    it('5xx -> retry intra-drain y despues handleUpstreamFailure (reintentable, attempts++)', async () => {
      // attempts=0, cap=3 -> 0+1 < 3 -> NO capea: vuelve a pending para el proximo ciclo.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_c9', 'nota', 'user_admin', { attempts: 0 }),
      ]);
      prisma.user.findUnique.mockResolvedValue({ name: 'Josu' } as never);
      onnix.addComment.mockRejectedValue(new OnnixUpstreamError(503, 'add-comment'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      // retryWithJitter(attempts=2): el 5xx se reintenta UNA vez dentro del drain.
      expect(onnix.addComment).toHaveBeenCalledTimes(2);
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_c9',
        expect.stringContaining('503'),
        false, // reintentable
      );
    });

    it('5xx con attempts en el cap -> failed terminal', async () => {
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_c10', 'nota', 'user_admin', { attempts: 2 }),
      ]);
      prisma.user.findUnique.mockResolvedValue({ name: 'Josu' } as never);
      onnix.addComment.mockRejectedValue(new OnnixUpstreamError(500, 'add-comment'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith('row_c10', expect.any(String), true);
    });
  });

  describe('DRY_RUN — modo simulacro (ONNIX_SYNC_DRY_RUN=true)', () => {
    beforeEach(() => {
      config.onnixSyncDryRun = true;
    });

    it('TICKET_CREATED: corre el pipeline pero NO llama createTicket (0) ni deja external_id real', async () => {
      const row = makeRow('row_dry1', 'TICKET_CREATED', { external_id: null });
      outbox.claim.mockResolvedValueOnce([row]);
      prisma.ticket.findUnique.mockResolvedValueOnce(makeTicket());
      mapping.resolveClientId.mockResolvedValueOnce(555);
      mapping.resolveProjectId.mockResolvedValueOnce(777);
      mapping.resolveCatalogIds.mockResolvedValueOnce({
        ticketTypeId: 10,
        ticketCategoryId: 20,
        ticketPriorityId: 30,
      });

      const res = await service.processPending();

      // El pipeline corrio (gate org -> mapeo) pero NO se hizo el POST a Onnix.
      expect(mapping.resolveClientId).toHaveBeenCalledWith('org-test', 'client_1');
      expect(onnix.createTicket).not.toHaveBeenCalled();
      // NO cuenta como synced ni como failed real; cuenta como dryRun.
      expect(res).toEqual({ synced: 0, failed: 0, dryRun: 1 });
      // La fila NO queda con external_id real: markSynced (que persistiria el code)
      // NO se llama; se marca terminal-no-loop con texto DRY_RUN.
      expect(outbox.markSynced).not.toHaveBeenCalled();
      expect(prisma.ticket.update).not.toHaveBeenCalled();
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_dry1',
        expect.stringContaining('DRY_RUN'),
        true,
      );
    });

    it('STATUS_CHANGED: resuelve slug pero NO llama setEstado, marca DRY_RUN terminal', async () => {
      outbox.claim.mockResolvedValueOnce([makeRow('row_dry2', 'STATUS_CHANGED')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce({ status: TicketStatus.RESOLVED } as never);
      mapping.resolveStatusSlug.mockResolvedValueOnce('resuelto');

      const res = await service.processPending();

      // Resolvio el slug (pipeline completo) pero NO hizo el POST de estado.
      expect(mapping.resolveStatusSlug).toHaveBeenCalledWith(TicketStatus.RESOLVED, expect.any(String));
      expect(onnix.setEstado).not.toHaveBeenCalled();
      expect(res).toEqual({ synced: 0, failed: 0, dryRun: 1 });
      expect(outbox.markSynced).not.toHaveBeenCalled();
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_dry2',
        expect.stringContaining('DRY_RUN'),
        true,
      );
    });

    it('COMMENT_ADDED: NO llama addComment, marca DRY_RUN terminal y el log NO trae el cuerpo', async () => {
      outbox.claim.mockResolvedValueOnce([makeChatRow('row_dry3', 'msg_dry')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.message.findUnique.mockResolvedValueOnce(
        makeMessage('datos confidenciales del cliente', {
          name: 'Ana Lopez',
          clientId: 'client_1',
        }),
      );
      const warnSpy = spyLog('warn');

      const res = await service.processPending();

      expect(onnix.addComment).not.toHaveBeenCalled();
      expect(res).toEqual({ synced: 0, failed: 0, dryRun: 1 });
      expect(outbox.markSynced).not.toHaveBeenCalled();
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_dry3',
        expect.stringContaining('DRY_RUN'),
        true,
      );
      // El dueño valida la atribucion y el is_internal en el QA manual (R5.3), asi
      // que el prefijo y el largo SI se loggean...
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('DRY_RUN');
      expect(logged).toContain('[Cliente · Ana Lopez]');
      expect(logged).toContain('is_internal=false');
      // ...pero el cuerpo NUNCA: es conversacion privada del cliente en un log que
      // termina en Railway/Sentry.
      expect(logged).not.toContain('datos confidenciales del cliente');
    });
  });

  // ── #50 T7 — drain-on-enqueue (R4) ─────────────────────────────────────────

  describe('drain-on-enqueue (R4.1/R4.2/R4.3)', () => {
    let drainSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      drainSpy = jest
        .spyOn(service, 'processPending')
        .mockResolvedValue({ synced: 0, failed: 0 });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('R4.1: el evento agenda UN drenado que corre recien despues del debounce', async () => {
      service.onOutboxEnqueued();

      // Nada inmediato: el debounce existe justamente para agrupar la rafaga.
      expect(drainSpy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2999);
      expect(drainSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('R4.1: una RAFAGA de N eventos produce UN SOLO processPending', async () => {
      // Caso real: alguien escribe 5 mensajes seguidos en el chat. Sin el timer
      // unico serian 5 drains compitiendo por las mismas filas.
      for (let i = 0; i < 5; i++) service.onOutboxEnqueued();
      jest.advanceTimersByTime(3000);

      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('la ventana se reabre: un evento posterior al drenado agenda uno nuevo', async () => {
      service.onOutboxEnqueued();
      jest.advanceTimersByTime(3000);
      expect(drainSpy).toHaveBeenCalledTimes(1);

      // El callback puso drainTimer=null, asi que la siguiente rafaga vuelve a agendar.
      service.onOutboxEnqueued();
      jest.advanceTimersByTime(3000);
      expect(drainSpy).toHaveBeenCalledTimes(2);
    });

    it('con el flag maestro apagado no agenda NADA (ni timer)', async () => {
      config.onnixSyncEnabled = false;

      service.onOutboxEnqueued();

      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(60_000);
      expect(drainSpy).not.toHaveBeenCalled();
    });

    it('onModuleDestroy limpia el timer pendiente (no drena durante el shutdown)', async () => {
      service.onOutboxEnqueued();
      expect(jest.getTimerCount()).toBe(1);

      await service.onModuleDestroy();

      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(60_000);
      expect(drainSpy).not.toHaveBeenCalled();
    });

    it('un drenado que explota no tumba el proceso (el cron lo recupera)', async () => {
      drainSpy.mockRejectedValue(new Error('boom'));
      const warnSpy = spyLog('warn');

      service.onOutboxEnqueued();
      jest.advanceTimersByTime(3000);
      await Promise.resolve(); // deja correr el .catch del void

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('drain-on-enqueue'));
    });

    it('R4.2: el cron SIGUE registrado, corre cada 20 min y sigue llamando processPending', async () => {
      // El drain-on-enqueue es best-effort; la red de seguridad (reintentos, filas
      // que quedaron colgadas) es el cron. Si alguien lo saca "porque ya hay evento",
      // este test lo caza.
      const cronMeta = Reflect.getMetadata(
        'SCHEDULE_CRON_OPTIONS', // @nestjs/schedule SCHEDULE_CRON_OPTIONS
        SyncDispatcherService.prototype.tick,
      ) as { cronTime?: string; name?: string; waitForCompletion?: boolean } | undefined;

      expect(cronMeta).toBeDefined();
      expect(cronMeta?.name).toBe('onnix-sync');
      // Anti-solapamiento del cron: ya existia, no se duplico en #50.
      expect(cronMeta?.waitForCompletion).toBe(true);
      // Cadencia FIJA en el codigo (SYNC_CRON), sin env var: cada 20 min (:00/:20/:40).
      // Con #50 el cron dejo de ser el camino de latencia y paso a ser el de
      // RECUPERACION; una hora es demasiado para levantar un mensaje cuya pista en
      // memoria se perdio. Si alguien lo devuelve a '0 0 * * * *' o lo vuelve a atar
      // a process.env (donde una variable olvidada en Railway le ganaria al codigo),
      // este assert lo caza.
      expect(cronMeta?.cronTime).toBe('0 */20 * * * *');

      await service.tick();
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── #50 FIX 1 — orden cronologico del claim, punta a punta ──────────────────

  /**
   * El resto del archivo mockea OutboxService, asi que el orden de las filas lo
   * decide el test. Aca NO: se arma un OutboxService REAL contra un `$queryRaw`
   * que emula la semantica de Postgres (el RETURNING emite en orden de plan; solo
   * un ORDER BY DESPUES del RETURNING garantiza el orden). Es la unica forma de
   * que el defecto real —una rafaga de chat apareciendo desordenada en el hilo de
   * OSD— se reproduzca sin una DB.
   */
  describe('#50 FIX 1 — el orden del claim llega hasta el POST a OSD', () => {
    it('una rafaga que Postgres emite fuera de orden se postea en OSD en orden CRONOLOGICO', async () => {
      const outboxPrisma = mockDeep<PrismaService>();
      const realOutbox = new OutboxService(outboxPrisma, config, mockDeep<EventEmitter2>());
      config.onnixSyncStaleLockMs = 120_000;
      // El ticket ya existe en OSD: el gate de orden deja pasar los 3 comentarios.
      outboxPrisma.outboxEvent.findFirst.mockResolvedValue({
        externalId: 'TK-2026-000123',
      } as never);

      const at = (min: number) => new Date(Date.UTC(2026, 7, 1, 10, min, 0));
      const r1 = makeChatRow('row_o1', 'msg_1', { created_at: at(1) });
      const r2 = makeChatRow('row_o2', 'msg_2', { created_at: at(2) });
      const r3 = makeChatRow('row_o3', 'msg_3', { created_at: at(3) });
      // Orden de heap/plan devuelto por el RETURNING: 3, 1, 2.
      (outboxPrisma.$queryRaw as unknown as jest.Mock).mockImplementation(
        fakePostgresClaim([r3, r1, r2]),
      );

      const svc = new SyncDispatcherService(prisma, config, realOutbox, onnix, mapping);
      jest
        .spyOn(svc as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
        .mockResolvedValue(undefined);
      (prisma.message.findUnique as unknown as jest.Mock).mockImplementation(
        (args: { where: { id: string } }) =>
          Promise.resolve(makeMessage(`texto de ${args.where.id}`, {
            name: 'Ana',
            clientId: null,
          })),
      );
      onnix.addComment.mockResolvedValue(okComment());

      const res = await svc.processPending();

      expect(res).toEqual({ synced: 3, failed: 0 });
      // El hilo de OSD es una conversacion: el orden de los POST ES el orden en que
      // el cliente la lee. Si el claim devuelve heap order, esto sale 3,1,2.
      expect(onnix.addComment.mock.calls.map((c) => c[1])).toEqual([
        '[Ana] texto de msg_1',
        '[Ana] texto de msg_2',
        '[Ana] texto de msg_3',
      ]);
    });
  });

  // ── #50 FIX 2 — fondo del pozo del ordering gate ────────────────────────────

  /**
   * El gate libera la fila SIN consumir intento mientras el TICKET_CREATED no tiene
   * code: es el mecanismo elegido a proposito y NO cambia. Lo que se agrega es un
   * FONDO: pasadas 24h el ticket no va a tener code nunca (dry-run del rollout,
   * tickets previos a #13, TICKET_CREATED terminal por cliente no mapeado) y esa
   * fila entraba en un bucle infinito pending→in_flight→pending, invisible para la
   * DLQ y tapando la CABEZA de la cola (el claim ordena por created_at ASC).
   */
  describe('#50 FIX 2 — tope de edad del ordering gate', () => {
    const HOUR_MS = 60 * 60 * 1000;

    it('GUARD: COMMENT_ADDED RECIENTE sin code -> release, sin markFailed (mecanismo intacto)', async () => {
      // Este test debe pasar CON y SIN el fix: es el candado del caso normal, para
      // que el fondo del pozo no se coma el comportamiento que fijo el dueño.
      outbox.claim.mockResolvedValueOnce([
        makeChatRow('row_gate_new', 'msg_1', { created_at: new Date() }),
      ]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.release).toHaveBeenCalledWith('row_gate_new');
      expect(outbox.markFailed).not.toHaveBeenCalled();
      expect(onnix.addComment).not.toHaveBeenCalled();
    });

    it('GUARD: STATUS_CHANGED RECIENTE sin code -> release, sin markFailed', async () => {
      outbox.claim.mockResolvedValueOnce([
        makeRow('row_gate_new_st', 'STATUS_CHANGED', { created_at: new Date() }),
      ]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.release).toHaveBeenCalledWith('row_gate_new_st');
      expect(outbox.markFailed).not.toHaveBeenCalled();
      expect(onnix.setEstado).not.toHaveBeenCalled();
    });

    it('COMMENT_ADDED de hace 25h sin code -> failed TERMINAL por ordering gate, SIN release', async () => {
      outbox.claim.mockResolvedValueOnce([
        makeChatRow('row_zombie_c', 'msg_zombie', {
          created_at: new Date(Date.now() - 25 * HOUR_MS),
        }),
      ]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      // Sale de pending: deja de tapar la cabeza de la cola y se vuelve visible en
      // la DLQ, donde checkDlqAge SI la alerta (status='failed').
      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_zombie_c',
        expect.stringContaining('ordering gate'),
        true,
      );
      expect(outbox.release).not.toHaveBeenCalled();
      expect(onnix.addComment).not.toHaveBeenCalled();
    });

    it('STATUS_CHANGED de hace 25h sin code -> failed TERMINAL, SIN release', async () => {
      // El tope aplica a los DOS eventTypes a proposito: un STATUS_CHANGED zombie
      // traba la cola exactamente igual que un COMMENT_ADDED.
      outbox.claim.mockResolvedValueOnce([
        makeRow('row_zombie_st', 'STATUS_CHANGED', {
          created_at: new Date(Date.now() - 25 * HOUR_MS),
        }),
      ]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_zombie_st',
        expect.stringContaining('ordering gate'),
        true,
      );
      expect(outbox.release).not.toHaveBeenCalled();
      expect(onnix.setEstado).not.toHaveBeenCalled();
    });

    it('borde: EXACTAMENTE 24h cae del lado terminal (el corte es `< 24h` = joven)', async () => {
      outbox.claim.mockResolvedValueOnce([
        makeChatRow('row_borde_24', 'msg_borde', {
          created_at: new Date(Date.now() - 24 * HOUR_MS),
        }),
      ]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_borde_24',
        expect.stringContaining('ordering gate'),
        true,
      );
      expect(outbox.release).not.toHaveBeenCalled();
    });

    it('borde: un minuto ANTES de las 24h sigue siendo release (no se adelanta el corte)', async () => {
      outbox.claim.mockResolvedValueOnce([
        makeChatRow('row_borde_23', 'msg_borde2', {
          created_at: new Date(Date.now() - (24 * HOUR_MS - 60_000)),
        }),
      ]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.release).toHaveBeenCalledWith('row_borde_23');
      expect(outbox.markFailed).not.toHaveBeenCalled();
    });
  });

  // ── #50 FIX 3 — solapamiento del debounce ──────────────────────────────────

  /**
   * El callback del timer no consultaba `running`: un notify posterior armaba otro
   * timer que disparaba con el drenado anterior en vuelo. Dos processPending
   * solapados = dos lotes de comentarios posteandose en paralelo (la conversacion
   * se vuelve a desordenar en OSD, anulando el orden del FIX 1) y el `finally` del
   * primero en terminar pone `running=false` con el otro todavia vivo, desarmando
   * la guarda de onModuleDestroy.
   *
   * Aca NO se mockea processPending (a diferencia del describe de T7): se necesita
   * el `running` real. El drenado en vuelo se sostiene con un `claim` diferido.
   */
  describe('#50 FIX 3 — debounce que vence con un drenado EN VUELO', () => {
    let drainSpy: jest.SpyInstance;
    let releaseClaim: (rows: OutboxRow[]) => void;
    let inFlight: Promise<unknown>;

    beforeEach(() => {
      jest.useFakeTimers();
      spyLog('log');
      // spyOn sin mockImplementation: llama al original y ademas cuenta llamadas.
      drainSpy = jest.spyOn(service, 'processPending');
      outbox.claim.mockReturnValueOnce(
        new Promise<OutboxRow[]>((resolve) => {
          releaseClaim = resolve;
        }),
      );
      // Drenado en vuelo: `running` queda en true hasta que se resuelva el claim.
      inFlight = service.processPending();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('no arranca un SEGUNDO processPending y RE-ARMA el timer', async () => {
      service.onOutboxEnqueued();
      expect(jest.getTimerCount()).toBe(1);

      jest.advanceTimersByTime(3000);

      // El disparo no se pierde (retornar a secas lo perderia hasta el proximo
      // cron): el timer queda RE-ARMADO, no en cero.
      expect(drainSpy).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);

      // Termina el drenado en vuelo -> running=false -> el siguiente vencimiento SI drena.
      releaseClaim([]);
      await inFlight;
      expect(drainSpy).toHaveBeenCalledTimes(1);

      outbox.claim.mockResolvedValueOnce([]);
      jest.advanceTimersByTime(3000);
      expect(drainSpy).toHaveBeenCalledTimes(2);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    it('onModuleDestroy sigue cortando la cadena de re-armados', async () => {
      service.onOutboxEnqueued();
      jest.advanceTimersByTime(3000); // re-arma (drenado en vuelo)
      expect(jest.getTimerCount()).toBe(1);

      releaseClaim([]);
      await inFlight; // running=false: onModuleDestroy no tiene que esperar nada

      await service.onModuleDestroy();

      // `drainTimer` siempre apunta al timer VIGENTE (cada re-armado lo reasigna),
      // asi que el clearTimeout del shutdown lo corta aunque haya rebotado.
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(60_000);
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── #50 FIX 4 — la DLQ no se envenena con filas DRY_RUN ────────────────────

  /**
   * Las filas de simulacro quedan `failed` con lastError 'DRY_RUN: ...' y eso NO es
   * un defecto. Como R5.3 manda validar el rollout en prod con ONNIX_SYNC_DRY_RUN,
   * sin el filtro la alerta gritaria en cada ciclo por filas sanas — y, peor, la
   * fila mas vieja seria SIEMPRE una de simulacro, tapando la real.
   */
  describe('#50 FIX 4 — checkDlqAge ignora las filas DRY_RUN', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    beforeEach(() => {
      outbox.claim.mockResolvedValue([]); // el foco es checkDlqAge, no el drenado
      config.onnixDlqMaxAgeMin = 1440; // 24h
    });

    it('el where excluye DRY_RUN pero conserva las filas con lastError null', async () => {
      stubDlqRows([]);

      await service.processPending();

      const arg = prisma.outboxEvent.findFirst.mock.calls[0][0]!;
      expect(arg.where).toEqual({
        status: 'failed',
        OR: [{ lastError: null }, { NOT: { lastError: { startsWith: 'DRY_RUN' } } }],
      });
      // Sigue alertando por la MAS VIEJA (si se pierde el orderBy, la alerta miente).
      expect(arg.orderBy).toEqual({ createdAt: 'asc' });
    });

    it('una fila DRY_RUN vieja NO dispara la alerta de DLQ', async () => {
      stubDlqRows([
        { id: 'row_dry', status: 'failed', lastError: 'DRY_RUN: simulacro, no enviado a Onnix', createdAt: new Date(Date.now() - 3 * DAY_MS) },
      ]);
      const errorSpy = spyLog('error');

      await service.processPending();

      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('con una DRY_RUN mas vieja + una falla REAL vieja, alerta por la REAL', async () => {
      // El corazon del fix: sin filtro la mas vieja es siempre la de simulacro y la
      // falla real queda tapada (findFirst devuelve UNA sola fila).
      stubDlqRows([
        { id: 'row_dry', status: 'failed', lastError: 'DRY_RUN: simulacro, no enviado a Onnix', createdAt: new Date(Date.now() - 3 * DAY_MS) },
        { id: 'row_real', status: 'failed', lastError: '503 upstream', createdAt: new Date(Date.now() - 2 * DAY_MS) },
      ]);
      const errorSpy = spyLog('error');

      await service.processPending();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const msg = String(errorSpy.mock.calls[0][0]);
      expect(msg).toContain('row_real');
      expect(msg).not.toContain('row_dry');
      expect(msg).toContain('DLQ');
    });

    it('una fila failed vieja SIN lastError igual alerta (rama defensiva del OR)', async () => {
      // En SQL `NOT (last_error LIKE 'DRY_RUN%')` evalua a NULL para las filas sin
      // lastError y las descartaria: una alerta de DLQ no puede perderse por eso.
      stubDlqRows([
        { id: 'row_dry', status: 'failed', lastError: 'DRY_RUN: simulacro', createdAt: new Date(Date.now() - 3 * DAY_MS) },
        { id: 'row_sin_error', status: 'failed', lastError: null, createdAt: new Date(Date.now() - 2 * DAY_MS) },
      ]);
      const errorSpy = spyLog('error');

      await service.processPending();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('row_sin_error');
    });

    /**
     * Emula el filtrado de Prisma/SQL sobre un set chico de filas para que el
     * `where` del service se ejerza de verdad (un mockResolvedValue fijo no probaria
     * nada: devolveria la misma fila con y sin filtro).
     */
    function stubDlqRows(rows: DlqRow[]): void {
      (prisma.outboxEvent.findFirst as unknown as jest.Mock).mockImplementation(
        (args: { where: DlqWhere }) => {
          const match = [...rows]
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .find((r) => matchesDlqWhere(r, args.where));
          return Promise.resolve(match ? { id: match.id, createdAt: match.createdAt } : null);
        },
      );
    }
  });
});

// ── Helpers de emulacion (FIX 1 / FIX 4) ───────────────────────────────────

/**
 * Emula la semantica REAL de Postgres para el claim (#50 FIX 1): el `ORDER BY`
 * dentro del subquery del UPDATE elige QUE filas se bloquean, pero el `RETURNING`
 * las emite en orden de plan (`heapOrder`). Solo un `ORDER BY` aplicado DESPUES del
 * RETURNING —el SELECT sobre el CTE— garantiza el orden de salida.
 */
function fakePostgresClaim(
  heapOrder: OutboxRow[],
): (strings: TemplateStringsArray) => Promise<OutboxRow[]> {
  return (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    const afterReturning = sql.slice(sql.toUpperCase().lastIndexOf('RETURNING'));
    const ordered = /ORDER\s+BY\s+created_at/i.test(afterReturning);
    return Promise.resolve(
      ordered
        ? [...heapOrder].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        : heapOrder,
    );
  };
}

type DlqRow = { id: string; status: string; lastError: string | null; createdAt: Date };
type DlqNot = { lastError?: { startsWith?: string } };
type DlqWhere = {
  status?: string;
  NOT?: DlqNot;
  OR?: Array<{ lastError?: string | null; NOT?: DlqNot }>;
};

/** Evalua el `where` de checkDlqAge con semantica SQL (incluido el NULL del NOT). */
function matchesDlqWhere(row: DlqRow, where: DlqWhere): boolean {
  if (where.status && row.status !== where.status) return false;
  // NOT de primer nivel (variante SIN la rama defensiva del OR): en SQL
  // `NOT (NULL LIKE 'DRY_RUN%')` es NULL, asi que la fila sin lastError se PIERDE.
  if (where.NOT && !matchesDlqNot(row, where.NOT)) return false;
  if (!where.OR) return true; // sin OR = la version PRE-fix: entra todo
  return where.OR.some((cond) => {
    if (cond.NOT) return matchesDlqNot(row, cond.NOT);
    if ('lastError' in cond) return row.lastError === cond.lastError;
    return false;
  });
}

/** `NOT (last_error LIKE 'DRY_RUN%')`: con lastError NULL evalua a NULL => no entra. */
function matchesDlqNot(row: DlqRow, not: DlqNot): boolean {
  if (row.lastError === null) return false;
  const prefix = not.lastError?.startsWith;
  return prefix === undefined ? true : !row.lastError.startsWith(prefix);
}

// ── Factories ─────────────────────────────────────────────────────────────

function makeRow(
  id: string,
  eventType: OutboxEventType,
  overrides: Partial<OutboxRow> = {},
): OutboxRow {
  return {
    id,
    event_type: eventType,
    aggregate_id: 'ticket_1',
    payload: { ticketId: 'ticket_1', clientId: 'client_1', projectId: 'project_1' },
    payload_version: 1,
    status: 'in_flight',
    attempts: 0,
    last_error: null,
    external_id: null,
    locked_at: new Date(),
    created_at: new Date(),
    synced_at: null,
    ...overrides,
  };
}

/**
 * Fila COMMENT_ADDED de origen CHAT (#50 R2.2): el payload solo lleva el id del
 * Message porque el dispatcher lo RELEE al drenar.
 */
function makeChatRow(
  id: string,
  messageId: string,
  overrides: Partial<OutboxRow> = {},
): OutboxRow {
  return makeRow(id, 'COMMENT_ADDED', {
    payload: { ticketId: 'ticket_1', messageId },
    ...overrides,
  });
}

/**
 * Fila COMMENT_ADDED de origen NOTA INTERNA (#50 R3.2): el payload lleva el
 * SNAPSHOT del texto, no una referencia — a proposito, para que dos guardados
 * rapidos produzcan dos versiones distintas en OSD.
 */
function makeNoteRow(
  id: string,
  snapshot: string,
  authorUserId: string,
  overrides: Partial<OutboxRow> = {},
): OutboxRow {
  return makeRow(id, 'COMMENT_ADDED', {
    payload: { ticketId: 'ticket_1', adminNoteSnapshot: snapshot, authorUserId },
    ...overrides,
  });
}

// Partial del Ticket de Prisma: solo los campos que lee processCreate. Cast a
// `never` porque el modelo Ticket completo tiene ~25 campos no relevantes aqui.
function makeTicket(overrides: Record<string, unknown> = {}): never {
  return {
    id: 'ticket_1',
    organizationId: 'org-test',
    clientId: 'client_1',
    projectId: 'project_1',
    title: 'Ticket de prueba',
    description: 'Descripcion',
    category: 'SUPPORT_REQUEST',
    priority: 'MEDIUM',
    status: TicketStatus.OPEN,
    ...overrides,
  } as never;
}

/**
 * Partial del Message tal como lo proyecta processComment
 * (`select: { content, user: { name, clientId } }`). `clientId` presente = el
 * autor es del cliente → prefijo `[Cliente · ...]`.
 */
function makeMessage(
  content: string,
  user: { name: string | null; clientId: string | null },
): never {
  return { content, user } as never;
}

function okCreate(code: string): OnnixCallOutcome<OnnixTicketDetalle> {
  return { ok: true, status: 201, data: { id: 1, code } };
}

function okComment(): OnnixCallOutcome<OnnixTicketComentario> {
  return { ok: true, status: 201, data: { id: 99 } };
}
