import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { TicketStatus } from '@prisma/client';
import { SyncDispatcherService } from './sync-dispatcher.service';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService, SKIPPED_MESSAGE_DELETED_EXTERNAL_ID } from './outbox.service';
import { OnnixClientService } from './onnix-client.service';
import { OnnixMappingService } from './onnix-mapping.service';
import { OnnixUpstreamError } from './errors';
import { OutboxEventType, OutboxRow, OutboxStatus } from './types/outbox.types';
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
    // #51 D2.2: el chequeo anti-duplicado del comentario solo corre con
    // `attempts > 0`. Defaults EXPLICITOS (mockDeep no devuelve ni un array ni el
    // objeto de estado: el `.find` / el `.unanchored` explotarian y el test pasaria
    // por la razon equivocada, via el catch de processComment). "No hay nada en OSD,
    // nada reclamado y NINGUNA fila sin ancla" = el dedup esta activo y no encuentra
    // nada, asi que se postea normal.
    onnix.listComments.mockResolvedValue([]);
    outbox.getCommentClaimState.mockResolvedValue({ claimedIds: [], unanchored: 0 });
    // #52: default EXPLICITO "nadie mapeado". Sin esto mockDeep devuelve una
    // funcion (truthy, ni number ni null) y CADA test de TICKET_CREATED que ya
    // existia empezaria a mandar un `assigned_to` basura en el body — pasando o
    // fallando por una razon que no tiene nada que ver con lo que prueba. `null` es
    // ademas el estado real de una org sin `seed-users` corrido: el body sale
    // exactamente igual que antes de #52 (R2.2).
    mapping.resolveUserId.mockResolvedValue(null);
    // El `reason` de la asignacion resuelve el nombre del actor con un findUnique
    // sobre User; default explicito por el mismo motivo (processComment ya lo
    // stubbea por test, pero ASSIGNEE_CHANGED lo llama SIEMPRE).
    prisma.user.findUnique.mockResolvedValue(null as never);
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
      // #51 D2.1: el id que devuelve el 201 de OSD se persiste como externalId de la
      // fila. Es el ancla del dedup: sin dueño, el mismo comentario en OSD podria
      // ser adoptado por otra fila y perderiamos un mensaje.
      expect(outbox.markSynced).toHaveBeenCalledWith('row_c2', '99');
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
      // Con CENTINELA, no con externalId null (#51 FIX D): una fila COMMENT_ADDED
      // `synced` sin ancla cuenta como `unanchored`, y `unanchored > 0` desactiva
      // la adopcion del ticket ENTERO para siempre — un solo mensaje borrado
      // apagaba el anti-duplicado de ese ticket y cada timeout posterior de OSD
      // duplicaba. El centinela dice la verdad ("no hay comentario que anclar") y
      // no puede colisionar con un id de OSD, que es numerico.
      expect(outbox.markSynced).toHaveBeenCalledWith(
        'row_c5',
        SKIPPED_MESSAGE_DELETED_EXTERNAL_ID,
      );
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

    it('5xx -> UN solo POST y handleUpstreamFailure (reintentable, attempts++)', async () => {
      // attempts=0, cap=3 -> 0+1 < 3 -> NO capea: vuelve a pending para el proximo ciclo.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_c9', 'nota', 'user_admin', { attempts: 0 }),
      ]);
      prisma.user.findUnique.mockResolvedValue({ name: 'Josu' } as never);
      onnix.addComment.mockRejectedValue(new OnnixUpstreamError(503, 'add-comment'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      // #51 D2.3: el comentario ya NO se reintenta intra-drain. Ese reintento corria
      // con attempts todavia en 0 —el punto ciego del chequeo anti-duplicado— y
      // disparaba a los ~300ms, con OSD probablemente procesando el primer POST.
      // Un solo camino de reintento (vuelta a pending) = un solo lugar donde
      // preguntar "¿ya llego?". La latencia la cubre el drenado de seguimiento (D3).
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
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

  // ── #51 FIX A — un solo drenado por proceso ────────────────────────────────

  /**
   * El cron era el UNICO disparador que llamaba `processPending()` sin mirar
   * `this.running` (`onTicketEvent` y el timer del debounce si lo miraban), y
   * `waitForCompletion` solo evita que el cron se solape CONSIGO MISMO: no sabe
   * del timer ni del endpoint admin. Dos `processPending` solapados eran la raiz
   * de casi todos los caminos de perdida/duplicado de #51.
   *
   * Igual que en el FIX 3 de #50, aca NO se mockea `processPending`: hace falta el
   * `running` real, sostenido con un `claim` diferido.
   */
  describe('#51 FIX A — el cron no se solapa con el timer ni con el endpoint', () => {
    let drainSpy: jest.SpyInstance;
    let releaseClaim: (rows: OutboxRow[]) => void;
    let inFlight: Promise<unknown>;

    beforeEach(() => {
      spyLog('log');
      drainSpy = jest.spyOn(service, 'processPending');
      // Default ANTES del `once`: si la guarda no estuviera y arrancara un SEGUNDO
      // drenado, su `claim` tiene que resolver limpio (lote vacio) para que lo que
      // se rompa sea el ASSERT de "una sola llamada" y no un TypeError adentro del
      // service. Un test que falla crasheando no dice cual es el invariante roto.
      outbox.claim.mockResolvedValue([]);
      outbox.claim.mockReturnValueOnce(
        new Promise<OutboxRow[]>((resolve) => {
          releaseClaim = resolve;
        }),
      );
      inFlight = service.processPending();
    });

    afterEach(async () => {
      releaseClaim([]);
      await inFlight;
    });

    it('tick() con un drenado EN VUELO no arranca un segundo processPending', async () => {
      await service.tick();

      // Solo el drenado en vuelo. Perder el tick no cuesta nada: el cron vuelve en
      // 20 min y el drenado vivo esta procesando la MISMA cola ahora mismo.
      expect(drainSpy).toHaveBeenCalledTimes(1);
      expect(outbox.claim).toHaveBeenCalledTimes(1);
    });

    it('isDraining() expone el estado real y vuelve a false al terminar', async () => {
      expect(service.isDraining()).toBe(true);

      releaseClaim([]);
      await inFlight;

      expect(service.isDraining()).toBe(false);
    });

    it('tick() vuelve a drenar una vez que el drenado en vuelo termino', async () => {
      releaseClaim([]);
      await inFlight;
      outbox.claim.mockResolvedValueOnce([]);

      await service.tick();

      expect(drainSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── #51 FIX C — el lock se refresca POR FILA ───────────────────────────────

  /**
   * `claim` estampa `locked_at` UNA vez para las hasta 50 filas del lote, asi que
   * el reloj de ONNIX_SYNC_STALE_LOCK_MS (120s) corre POR LOTE. Con OSD lento la
   * ultima fila puede empezar a procesarse ~25 min despues del claim: otro drenado
   * la rescata como lock vencido y la postea mientras esta todavia la tiene en
   * memoria => comentario duplicado en OSD, que no tiene delete.
   */
  describe('#51 FIX C — refresco de lock por fila antes de procesarla', () => {
    it('refresca el lock de CADA fila del lote, por id, antes de tocarla', async () => {
      const r1 = makeChatRow('row_lk1', 'msg_1');
      const r2 = makeChatRow('row_lk2', 'msg_2');
      outbox.claim.mockResolvedValueOnce([r1, r2]);
      outbox.renewClaimLock.mockResolvedValue('applied');
      outbox.getCreatedExternalId.mockResolvedValue('TK-2026-000123');
      (prisma.message.findUnique as unknown as jest.Mock).mockImplementation(() =>
        Promise.resolve(makeMessage('hola', { name: 'Ana', clientId: null })),
      );
      onnix.addComment.mockResolvedValue(okComment());

      await service.processPending();

      // Uno por fila (no uno por lote): es lo que hace que el reloj del lock corra
      // por fila y el rescate solo pueda pasar si ESA fila de verdad se colgo.
      expect(outbox.renewClaimLock.mock.calls.map((c) => c[0])).toEqual([
        'row_lk1',
        'row_lk2',
      ]);
      // Y ANTES de tocarla, no despues: refrescar el lock DESPUES del POST no
      // evitaria nada — para entonces el otro drenado ya rescato la fila y el
      // comentario duplicado ya esta en OSD, que no tiene delete. El orden es el
      // fix; la cantidad de llamadas sola no lo prueba.
      expect(outbox.renewClaimLock.mock.invocationCallOrder[0]).toBeLessThan(
        onnix.addComment.mock.invocationCallOrder[0],
      );
      expect(outbox.renewClaimLock.mock.invocationCallOrder[1]).toBeLessThan(
        onnix.addComment.mock.invocationCallOrder[1],
      );
    });

    it('fila que ya no es nuestra ("lost") se SALTEA: no se postea ni se escribe nada', async () => {
      const mine = makeChatRow('row_mine', 'msg_1');
      const stolen = makeChatRow('row_stolen', 'msg_2');
      outbox.claim.mockResolvedValueOnce([stolen, mine]);
      // La primera fila se la llevo otro drenado tras vencer su lock.
      outbox.renewClaimLock.mockResolvedValueOnce('lost').mockResolvedValueOnce('applied');
      outbox.getCreatedExternalId.mockResolvedValue('TK-2026-000123');
      (prisma.message.findUnique as unknown as jest.Mock).mockImplementation(() =>
        Promise.resolve(makeMessage('hola', { name: 'Ana', clientId: null })),
      );
      onnix.addComment.mockResolvedValue(okComment());
      const logSpy = spyLog('log');

      const res = await service.processPending();

      // Procesarla igual produciria EXACTAMENTE el duplicado que este refresco vino
      // a evitar, y no se pierde nada: el otro drenado la termina.
      expect(prisma.message.findUnique).toHaveBeenCalledTimes(1);
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      expect(outbox.markSynced).toHaveBeenCalledTimes(1);
      expect(outbox.markSynced).toHaveBeenCalledWith('row_mine', expect.anything());
      // La fila robada no es ni exito ni fallo de este ciclo.
      expect(res).toEqual({ synced: 1, failed: 0 });
      // `lost>0` es el sintoma directo de dos drenados solapados: tiene que quedar
      // en el log de cierre o un duplicado en OSD no tiene por donde auditarse.
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('lost=1'));
    });
  });

  /**
   * Contracara OBLIGATORIA de la guarda: `if (this.running) return` es una linea
   * que, mal puesta, apaga el cron entero sin que nada mas se ponga rojo (el resto
   * de los tests llaman `processPending` directo, no `tick`). Este describe corre
   * SIN drenado en vuelo a proposito — es el unico lugar del archivo que prueba
   * que el camino normal del disparador sigue existiendo.
   */
  describe('#51 FIX A — sin drenado en vuelo, el camino normal es el de siempre', () => {
    it('tick() drena igual que antes (la guarda no apaga el cron)', async () => {
      spyLog('log');
      outbox.claim.mockResolvedValueOnce([]);
      const drainSpy = jest.spyOn(service, 'processPending');

      await service.tick();

      expect(drainSpy).toHaveBeenCalledTimes(1);
      expect(outbox.claim).toHaveBeenCalledTimes(1);
      // Y la bandera queda limpia para el proximo disparador: si `processPending`
      // no la apagara en el `finally`, el primer tick del proceso dejaria mudos a
      // los otros tres disparadores para siempre.
      expect(service.isDraining()).toBe(false);
    });

    it('tick() con el flag maestro apagado no drena (la guarda vieja sigue primero)', async () => {
      config.onnixSyncEnabled = false;
      const drainSpy = jest.spyOn(service, 'processPending');

      await service.tick();

      expect(drainSpy).not.toHaveBeenCalled();
      expect(outbox.claim).not.toHaveBeenCalled();
    });
  });

  // ── #51 FIX D — un mensaje borrado no apaga el anti-duplicado ───────────────

  /**
   * EL test del FIX D, y el unico que prueba la consecuencia real: el skip por
   * mensaje borrado marcaba la fila `synced` con `externalId = null`, o sea una
   * fila COMMENT_ADDED sincronizada SIN ancla para siempre. `unanchored > 0`
   * DESACTIVA la adopcion del ticket ENTERO, asi que un unico mensaje que un
   * usuario borrara apagaba el anti-duplicado de ese ticket de forma permanente y
   * cada timeout posterior de OSD ahi duplicaba el comentario.
   *
   * Por eso NO se mockea `OutboxService`: con el mock, `getCommentClaimState`
   * devolveria lo que elija el test y el encadenamiento —lo que la fila borrada
   * ESCRIBE es lo que la fila siguiente LEE— no se ejerceria. Se arma un
   * OutboxService REAL contra una tabla en memoria que aplica los `where` de
   * verdad, que es la unica forma sin DB de que las dos filas se hablen.
   */
  describe('#51 FIX D — el centinela del mensaje borrado', () => {
    const ROW_AT = new Date('2026-08-01T10:00:00.000Z');
    const AFTER_ROW = '2026-08-01T10:00:07.000Z';

    /** Fila de la tabla en memoria: solo las columnas que miran estos where. */
    type StoredRow = {
      id: string;
      aggregateId: string;
      eventType: OutboxEventType;
      status: OutboxStatus;
      externalId: string | null;
    };

    type WriteArgs = {
      where?: { id?: string; status?: OutboxStatus };
      data?: { status?: OutboxStatus; externalId?: string };
    };

    /**
     * Cablea `outboxEvent` contra `table` aplicando los where de verdad. Ojo con
     * `update`: se cablea con la MISMA implementacion pero IGNORANDO el status del
     * where, que es exactamente lo que hacia la version pre-FIX B. Asi, si alguien
     * revierte cualquiera de los dos fixes, la tabla queda en el estado equivocado
     * y el test se pone rojo solo en vez de pasar contra un mock complaciente.
     */
    function wireOutboxTable(
      outboxPrisma: DeepMockProxy<PrismaService>,
      table: StoredRow[],
    ): void {
      const write = (args: WriteArgs, ignoreStatus: boolean): StoredRow[] => {
        const where = args?.where ?? {};
        const hit = table.filter(
          (r) =>
            (where.id === undefined || r.id === where.id) &&
            (ignoreStatus || where.status === undefined || r.status === where.status),
        );
        for (const r of hit) {
          if (args?.data?.status !== undefined) r.status = args.data.status;
          if (args?.data?.externalId !== undefined) r.externalId = args.data.externalId;
        }
        return hit;
      };
      (outboxPrisma.outboxEvent.updateMany as unknown as jest.Mock).mockImplementation(
        (args: WriteArgs) => Promise.resolve({ count: write(args, false).length }),
      );
      (outboxPrisma.outboxEvent.update as unknown as jest.Mock).mockImplementation(
        (args: WriteArgs) => Promise.resolve(write(args, true)[0] ?? null),
      );
      // getCommentClaimState: filtra por aggregate + eventType + status y proyecta
      // solo externalId, igual que el select del service.
      (outboxPrisma.outboxEvent.findMany as unknown as jest.Mock).mockImplementation(
        (args: {
          where: { aggregateId: string; eventType: OutboxEventType; status: OutboxStatus };
        }) =>
          Promise.resolve(
            table
              .filter(
                (r) =>
                  r.aggregateId === args.where.aggregateId &&
                  r.eventType === args.where.eventType &&
                  r.status === args.where.status,
              )
              .map((r) => ({ externalId: r.externalId })),
          ),
      );
      // getCreatedExternalId: el code del ticket para el gate de orden.
      (outboxPrisma.outboxEvent.findFirst as unknown as jest.Mock).mockImplementation(
        (args: { where: { aggregateId: string; eventType?: OutboxEventType } }) =>
          Promise.resolve(
            table.find(
              (r) =>
                r.aggregateId === args.where.aggregateId &&
                r.eventType === args.where.eventType &&
                r.externalId !== null,
            ) ?? null,
          ),
      );
    }

    it('⚠️ un mensaje borrado NO apaga el dedup del ticket: la fila siguiente SIGUE adoptando', async () => {
      const outboxPrisma = mockDeep<PrismaService>();
      config.onnixSyncStaleLockMs = 120_000;
      const table: StoredRow[] = [
        // El ticket ya existe en OSD: el gate de orden deja pasar los comentarios.
        {
          id: 'row_created',
          aggregateId: 'ticket_1',
          eventType: 'TICKET_CREATED',
          status: 'synced',
          externalId: 'TK-2026-000123',
        },
        // La del mensaje que el usuario borro entre el encolado y el drenado.
        {
          id: 'row_borrado',
          aggregateId: 'ticket_1',
          eventType: 'COMMENT_ADDED',
          status: 'in_flight',
          externalId: null,
        },
        // Y una POSTERIOR del mismo ticket que vuelve de un fallo ambiguo: su POST
        // si habia llegado a OSD. Es la que paga el precio si el borrado apago el
        // dedup — postearia de nuevo un comentario que ya esta en el hilo.
        {
          id: 'row_perdida',
          aggregateId: 'ticket_1',
          eventType: 'COMMENT_ADDED',
          status: 'in_flight',
          externalId: null,
        },
      ];
      wireOutboxTable(outboxPrisma, table);
      const realOutbox = new OutboxService(
        outboxPrisma,
        config,
        mockDeep<EventEmitter2>(),
      );
      // El ORDEN importa: primero la borrada (escribe el centinela), despues la
      // que consulta la contabilidad. Al reves el test no probaria nada.
      (outboxPrisma.$queryRaw as unknown as jest.Mock).mockResolvedValue([
        makeChatRow('row_borrado', 'msg_borrado', { created_at: ROW_AT }),
        makeNoteRow('row_perdida', 'la nota que se perdio', 'user_admin', {
          attempts: 1,
          created_at: ROW_AT,
        }),
      ]);
      prisma.message.findUnique.mockResolvedValue(null); // el usuario lo borro
      prisma.user.findUnique.mockResolvedValue({ name: 'Josu' } as never);
      // El POST perdido de `row_perdida` SI esta en OSD: cumple las cinco
      // condiciones de adopcion, asi que lo unico que puede frenarla es el dedup
      // apagado por la fila borrada.
      onnix.listComments.mockResolvedValue([
        {
          id: 777,
          comment: '[Josu] la nota que se perdio',
          is_internal: true,
          created_at: AFTER_ROW,
        },
      ]);
      onnix.addComment.mockResolvedValue(okComment());

      const svc = new SyncDispatcherService(prisma, config, realOutbox, onnix, mapping);
      jest
        .spyOn((svc as unknown as { logger: Logger }).logger, 'log')
        .mockImplementation(() => undefined);
      jest
        .spyOn(svc as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
        .mockResolvedValue(undefined);

      const res = await svc.processPending();

      // ⚠️ EL ASSERT, y va PRIMERO a proposito: lo que importa es la CONSECUENCIA
      // (el ticket sigue sin duplicar), no el mecanismo. Con `externalId = null` en
      // la fila borrada, esta fila veria unanchored=1, el kill-switch apagaria la
      // adopcion y este POST saldria duplicado — y asi cada reintento de ese ticket,
      // para siempre, porque una fila sin ancla no gana un externalId nunca.
      expect(onnix.addComment).not.toHaveBeenCalled();
      expect(table.find((r) => r.id === 'row_perdida')).toMatchObject({
        status: 'synced',
        externalId: '777',
      });
      // La borrada no cuenta (skipped) y la otra se adopta.
      expect(res).toEqual({ synced: 1, failed: 0 });
      // Y el mecanismo que lo hace posible: la fila del mensaje borrado queda
      // ANCLADA con el centinela — dice la verdad ("no hay comentario en OSD que
      // esta fila deba reclamar") en vez de sumar para siempre a `unanchored`.
      expect(table.find((r) => r.id === 'row_borrado')).toMatchObject({
        status: 'synced',
        externalId: SKIPPED_MESSAGE_DELETED_EXTERNAL_ID,
      });
    });

    it('el centinela dentro de `claimedIds` NO bloquea la adopcion de un id REAL de OSD', async () => {
      // La propiedad que hace segura la decision de arriba: los ids de comentario
      // de OSD son numericos y el dedup compara contra `String(c.id)`, asi que el
      // centinela es inerte dentro del set de reclamados. Si alguna vez matcheara,
      // el fix habria cambiado un duplicado por una PERDIDA de mensaje.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_cent', 'la nota que se perdio', 'user_admin', {
          attempts: 1,
          created_at: ROW_AT,
        }),
      ]);
      outbox.getCreatedExternalId.mockResolvedValue('TK-2026-000123');
      prisma.user.findUnique.mockResolvedValue({ name: 'Josu' } as never);
      onnix.addComment.mockResolvedValue(okComment());
      onnix.listComments.mockResolvedValueOnce([
        {
          id: 777,
          comment: '[Josu] la nota que se perdio',
          is_internal: true,
          created_at: AFTER_ROW,
        },
      ]);
      // Contabilidad completa (unanchored 0) y el UNICO reclamo es el centinela.
      outbox.getCommentClaimState.mockResolvedValueOnce({
        claimedIds: [SKIPPED_MESSAGE_DELETED_EXTERNAL_ID],
        unanchored: 0,
      });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment).not.toHaveBeenCalled();
      expect(outbox.markSynced).toHaveBeenCalledWith('row_cent', '777');
      // Y el centinela no es un numero: `String(777)` jamas puede ser igual a el.
      expect(Number.isNaN(Number(SKIPPED_MESSAGE_DELETED_EXTERNAL_ID))).toBe(true);
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
      // OutboxService REAL: el refresco de lock por fila (#51 FIX C) y las
      // escrituras terminales (FIX B) van por `updateMany` y leen el `count` para
      // saber si la fila sigue siendo nuestra. `count: 1` = lo sigue siendo.
      outboxPrisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 } as {
        count: number;
      });
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

  // ── #51 T3 — idempotencia del comentario ante fallo ambiguo ────────────────

  /**
   * El pipeline es at-least-once y un timeout NO prueba que OSD no haya procesado
   * el POST (`rawFetch` aborta a los 15s y clasifica como transitorio). OSD no
   * tiene delete de comentario, asi que cada POST de mas es una linea de mas en la
   * conversacion que ve el cliente — y cada mensaje de menos es peor todavia.
   *
   * El fix son cuatro piezas que se sostienen entre si (D2.1 a D2.4) y el test que
   * las cierra es el del "ok" repetido: es el unico que distingue un dedup correcto
   * de uno que PIERDE mensajes.
   */
  describe('#51 T3 — idempotencia del comentario ante fallo ambiguo (R2/D2)', () => {
    /**
     * Reloj EXPLICITO del dedup. La ventana temporal (`created_at` del comentario de
     * OSD >= `created_at` de la fila) es una de las cinco condiciones de adopcion,
     * asi que las fechas son parte del contrato de estos tests y no ruido de fixture:
     * un fixture "sin fecha" no se adopta, y un test que dependiera de eso pasaria
     * aunque el guard que dice probar no existiera.
     */
    const ROW_AT = new Date('2026-08-01T10:00:00.000Z');
    /** Posterior a la fila: candidato valido por ventana temporal. */
    const AFTER_ROW = '2026-08-01T10:00:07.000Z';
    /** Anterior a la fila: no puede ser el POST perdido de ESA fila. */
    const BEFORE_ROW = '2026-08-01T09:59:53.000Z';

    beforeEach(() => {
      outbox.getCreatedExternalId.mockResolvedValue('TK-2026-000123');
      prisma.user.findUnique.mockResolvedValue({ name: 'Josu' } as never);
      onnix.addComment.mockResolvedValue(okComment());
    });

    /**
     * Fila de nota interna que YA salio a la ruta (`attempts > 0` es lo unico que
     * gatea el chequeo anti-duplicado) y con `created_at` fijo, para poder colocar
     * los comentarios remotos de un lado u otro de la ventana temporal.
     */
    function retryNoteRow(id: string, snapshot: string, attempts = 1): OutboxRow {
      return makeNoteRow(id, snapshot, 'user_admin', { attempts, created_at: ROW_AT });
    }

    /**
     * Comentario remoto que cumple LAS CINCO condiciones de adopcion, para el texto
     * que produce `retryNoteRow(_, 'la nota que se perdio')`.
     *
     * ⚠️ Los tests de PERDIDA de abajo rompen UNA sola condicion cada uno, a
     * proposito: si el fixture fuera invalido por dos motivos a la vez, el test
     * seguiria verde aunque el guard bajo prueba desapareciera — probaria el otro.
     */
    function adoptable(
      overrides: Partial<OnnixTicketComentario> = {},
    ): OnnixTicketComentario {
      return {
        id: 777,
        comment: '[Josu] la nota que se perdio',
        is_internal: true,
        created_at: AFTER_ROW,
        ...overrides,
      };
    }

    it('D2.1: el id del comentario que devuelve el 201 se persiste como externalId de la fila', async () => {
      // Es EL ancla del dedup: sin dueño, ese mismo comentario en OSD queda
      // "libre" y otra fila con el mismo texto podria adoptarlo → mensaje perdido.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_ext', 'nota con ancla', 'user_admin'),
      ]);
      onnix.addComment.mockResolvedValueOnce({ ok: true, status: 201, data: { id: 4321 } });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(outbox.markSynced).toHaveBeenCalledWith('row_ext', '4321');
    });

    it('GUARD D2.1: un 200 SIN body no rompe ni escribe un externalId basura', async () => {
      // Contrato roto de OSD (200 sin cuerpo). La fila SI se sincronizo, asi que
      // markSynced va igual — pero sin ancla, nunca con el string "undefined",
      // que quedaria reclamado para siempre y envenenaria el dedup del ticket.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_sin_body', 'nota', 'user_admin'),
      ]);
      onnix.addComment.mockResolvedValueOnce({ ok: true, status: 200 });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(outbox.markSynced).toHaveBeenCalledWith('row_sin_body', undefined);
    });

    it('✅ R2.2 CAMINO SANO: reintento, comentario nuestro sin reclamar y sin filas sin ancla -> SE ADOPTA', async () => {
      // `attempts: 1` = esta fila ya salio y volvio con un fallo ambiguo. El POST
      // habia llegado; lo que se perdio fue la respuesta. Las cinco condiciones se
      // cumplen (id numerico, texto exacto, misma visibilidad, no reclamado,
      // posterior a la fila) Y la contabilidad esta completa (unanchored=0).
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_dedup', 'la nota que se perdio')]);
      onnix.listComments.mockResolvedValueOnce([adoptable()]);
      // Nadie lo reclamo y NO hay filas sin ancla: el dedup esta habilitado.
      outbox.getCommentClaimState.mockResolvedValueOnce({ claimedIds: [], unanchored: 0 });
      const logSpy = spyLog('log');

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      // Lo central: NO se duplica el comentario en el hilo del cliente.
      expect(onnix.addComment).not.toHaveBeenCalled();
      expect(outbox.markSynced).toHaveBeenCalledWith('row_dedup', '777');
      expect(onnix.listComments).toHaveBeenCalledWith('TK-2026-000123', expect.any(String));
      expect(outbox.getCommentClaimState).toHaveBeenCalledWith('ticket_1');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dedup'));
    });

    it('✅ borde de la ventana: `created_at` EXACTAMENTE igual al de la fila SI adopta (el corte es `>=`)', async () => {
      // El corte tiene que dejar entrar el caso normal —OSD sella el comentario en
      // el mismo instante en que se creo la fila— o el dedup no adoptaria nunca y
      // cada reintento duplicaria. La direccion segura del borde se prueba abajo.
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_borde_eq', 'la nota que se perdio')]);
      onnix.listComments.mockResolvedValueOnce([
        adoptable({ created_at: ROW_AT.toISOString() }),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment).not.toHaveBeenCalled();
      expect(outbox.markSynced).toHaveBeenCalledWith('row_borde_eq', '777');
    });

    // ── ⚠️ CAMINOS DE PERDIDA DE MENSAJE ──────────────────────────────────────
    //
    // R2: PERDER UN MENSAJE ES MUCHO PEOR QUE DUPLICARLO. OSD no tiene delete ni
    // update de comentario, asi que un duplicado se limpia a ojo pero un mensaje
    // que no se postea se pierde para siempre Y EN SILENCIO (la fila queda
    // `synced`). Cada test de acá abajo rompe UNA condicion de adopcion y exige
    // que el resultado sea POSTEAR. Si alguien saca esa guarda, el test se pone
    // rojo porque el mensaje deja de salir.

    it('⚠️ PERDIDA 1: con UNA fila synced SIN externalId el dedup NO adopta NADA -> postea + WARN', async () => {
      // El comentario remoto es un match PERFECTO: sin el kill-switch se adoptaria.
      // Pero el ticket tiene comentarios nuestros sin ancla, o sea que NO sabemos
      // cuales de los comentarios "libres" de OSD ya son nuestros: ese 777 puede ser
      // de otra fila, y adoptarlo daria por enviado un mensaje que nunca salio.
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_sin_ancla', 'la nota que se perdio')]);
      onnix.listComments.mockResolvedValueOnce([adoptable()]);
      outbox.getCommentClaimState.mockResolvedValueOnce({ claimedIds: [], unanchored: 1 });
      const warnSpy = spyLog('warn');

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      // EL assert: el mensaje SALE igual (duplicado recuperable > perdida silenciosa).
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      expect(onnix.addComment.mock.calls[0][1]).toBe('[Josu] la nota que se perdio');
      // Y reclama SU propio id, no el 777 ajeno.
      expect(outbox.markSynced).toHaveBeenCalledWith('row_sin_ancla', '99');
      // El estado degradado no puede ser invisible: sin este WARN nadie entiende por
      // que ese ticket empezo a duplicar.
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('dedup DESACTIVADO');
      expect(logged).toContain('ticketId=ticket_1');
      expect(logged).toContain('rowId=row_sin_ancla');
      // NUNCA el cuerpo: el WARN termina en Railway/Sentry.
      expect(logged).not.toContain('la nota que se perdio');
    });

    it('⚠️ PERDIDA 1b: el kill-switch se reactiva solo en cuanto no quedan filas sin ancla', async () => {
      // Es un estado degradado TRANSITORIO (filas pre-#51, o un 201 sin id), no un
      // apagado permanente: si no se reactivara, el ticket duplicaria para siempre.
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_reactiva', 'la nota que se perdio')]);
      onnix.listComments.mockResolvedValueOnce([adoptable()]);
      outbox.getCommentClaimState.mockResolvedValueOnce({ claimedIds: [], unanchored: 0 });

      await service.processPending();

      expect(onnix.addComment).not.toHaveBeenCalled();
      expect(outbox.markSynced).toHaveBeenCalledWith('row_reactiva', '777');
    });

    it('⚠️ PERDIDA 2: comentario remoto con `id` NO numerico -> NO se adopta, se postea', async () => {
      // Si OSD devuelve el id como string (cast de Laravel), `typeof c.id === number`
      // falla y NO hay match: se postea. Sin ese guard se adoptaria un id de forma
      // desconocida y se grabaria como ancla algo que quizas no identifica nada.
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_id_str', 'la nota que se perdio')]);
      onnix.listComments.mockResolvedValueOnce([
        adoptable({ id: '777' as unknown as number }),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      expect(outbox.markSynced).toHaveBeenCalledWith('row_id_str', '99');
    });

    it('⚠️ PERDIDA 2b: comentario remoto SIN `id` -> se postea y JAMAS se graba el string "undefined"', async () => {
      // El peor caso del predicado viejo: `String(c.id)` daba 'undefined', que nunca
      // esta en el set de reclamados, asi que ese comentario matcheaba SIEMPRE por
      // texto — y la fila quedaba `synced` con externalId 'undefined': mensaje
      // perdido Y el dedup del ticket envenenado para siempre.
      const sinId = { comment: '[Josu] la nota que se perdio', is_internal: true, created_at: AFTER_ROW };
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_sin_id', 'la nota que se perdio')]);
      onnix.listComments.mockResolvedValueOnce([sinId as unknown as OnnixTicketComentario]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      expect(outbox.markSynced).toHaveBeenCalledWith('row_sin_id', '99');
      // Doble reja: ni por el predicado ni por el `!= null` del call site.
      expect(outbox.markSynced).not.toHaveBeenCalledWith('row_sin_id', 'undefined');
    });

    it('⚠️ PERDIDA 3: mismo texto pero `is_internal` DISTINTO -> NO se adopta, se postea', async () => {
      // El prefijo de la nota interna de un admin y el de su mensaje de chat son
      // IDENTICOS (`[Josu] `). Sin este guard, la nota interna se contabiliza contra
      // el mensaje publico: la nota nunca viaja y el cliente nunca ve su mensaje.
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_vis', 'la nota que se perdio')]);
      onnix.listComments.mockResolvedValueOnce([adoptable({ is_internal: false })]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      // Y sale con la visibilidad correcta, que es lo que estaba en juego.
      expect(onnix.addComment.mock.calls[0][2]).toBe(true);
      expect(outbox.markSynced).toHaveBeenCalledWith('row_vis', '99');
    });

    it('⚠️ PERDIDA 3b: si OSD NO devuelve `is_internal`, no se adivina la visibilidad -> se postea', async () => {
      const sinVis = { id: 777, comment: '[Josu] la nota que se perdio', created_at: AFTER_ROW };
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_vis_null', 'la nota que se perdio')]);
      onnix.listComments.mockResolvedValueOnce([sinVis as OnnixTicketComentario]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      expect(outbox.markSynced).toHaveBeenCalledWith('row_vis_null', '99');
    });

    it('⚠️ PERDIDA 4: comentario remoto ANTERIOR a `row.created_at` -> NO se adopta, se postea', async () => {
      // Un comentario que ya existia cuando la fila ni siquiera se habia escrito no
      // puede ser su POST perdido: es de otra fila o lo escribio un humano en OSD.
      // Adoptarlo es perder este mensaje.
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_viejo', 'la nota que se perdio')]);
      onnix.listComments.mockResolvedValueOnce([adoptable({ created_at: BEFORE_ROW })]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      expect(outbox.markSynced).toHaveBeenCalledWith('row_viejo', '99');
    });

    it('⚠️ PERDIDA 4b: sin `created_at` o con una fecha que no parsea -> NO se adopta, se postea', async () => {
      // Sin fecha no hay forma de saber si es nuestro: la duda resuelve a postear.
      outbox.claim.mockResolvedValueOnce([
        retryNoteRow('row_sin_fecha', 'la nota que se perdio'),
        retryNoteRow('row_fecha_basura', 'la nota que se perdio'),
      ]);
      onnix.listComments
        .mockResolvedValueOnce([adoptable({ created_at: undefined })])
        .mockResolvedValueOnce([adoptable({ created_at: 'ayer a la tarde' })]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 2, failed: 0 });
      expect(onnix.addComment).toHaveBeenCalledTimes(2);
    });

    it('⚠️ PERDIDA 5: las dos lecturas van SECUENCIALES (OSD primero, reclamos despues), nunca en Promise.all', async () => {
      // En paralelo el snapshot de reclamos es de t0 y el de OSD de t0+latencia (el
      // GET puede tardar hasta 15s). Un comentario que OTRO drenado postea y marca
      // `synced` DENTRO de esa ventana aparece en el listado de OSD pero NO en los
      // reclamos: se ve huerfano, esta fila lo adopta y su mensaje se pierde.
      // Preguntando a OSD PRIMERO, todo lo que exista en el listado ya tuvo su
      // chance de figurar como reclamado.
      const order: string[] = [];
      onnix.listComments.mockImplementation(async () => {
        order.push('osd:in');
        await Promise.resolve();
        await Promise.resolve();
        order.push('osd:out');
        return [];
      });
      outbox.getCommentClaimState.mockImplementation(async () => {
        order.push('reclamos:in');
        await Promise.resolve();
        return { claimedIds: [], unanchored: 0 };
      });
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_secuencial', 'nota')]);

      await service.processPending();

      // Con `Promise.all` el orden seria osd:in, reclamos:in, osd:out.
      expect(order).toEqual(['osd:in', 'osd:out', 'reclamos:in']);
    });

    it('GUARD R2.2: el match es por texto EXACTO (prefijo incluido), no por parecido', async () => {
      // El mismo cuerpo SIN el prefijo de autor es OTRO comentario (lo escribio un
      // humano en OSD). Si alguien afloja el `===` a un includes/startsWith,
      // adoptariamos comentarios ajenos y el mensaje nuestro no viajaria nunca.
      outbox.claim.mockResolvedValueOnce([retryNoteRow('row_parecido', 'la nota')]);
      // Todo lo demas es adoptable: lo UNICO que falla es el texto.
      onnix.listComments.mockResolvedValueOnce([
        adoptable({ id: 888, comment: 'la nota' }),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      expect(outbox.markSynced).toHaveBeenCalledWith('row_parecido', '99');
    });

    /**
     * ⚠️ EL TEST DEL SPEC. Dos filas distintas con el MISMO texto exacto ("ok",
     * "gracias", "dale" — lo mas normal del mundo en un chat). La primera ya posteo
     * y RECLAMO su id; la segunda entra por el camino de reintento.
     *
     * Si la segunda adopta el "ok" de la primera, el fix es peor que el bug que
     * arregla: en vez de duplicar un mensaje, PERDEMOS uno del cliente y nadie se
     * entera (la fila queda `synced`). Por eso el POST tiene que salir igual.
     *
     * Se simulan VIVOS el hilo de OSD y nuestra tabla: lo que se postea entra al
     * hilo, y lo que se marca synced con id queda reclamado. Con constantes fijas
     * el test no probaria nada — el resultado lo estariamos eligiendo nosotros.
     */
    it('⚠️ PERDIDA 6 — "ok" repetido: la segunda fila SI se postea, no adopta el comentario de la primera', async () => {
      const osdThread: OnnixTicketComentario[] = [];
      const claimedIds: string[] = [];
      let nextOsdId = 700;
      onnix.addComment.mockImplementation((_code, comment, isInternal) => {
        // El hilo simulado devuelve lo MISMO que devolveria OSD: id, texto,
        // visibilidad y sello de tiempo. Con un fixture pobre (sin is_internal ni
        // created_at) la segunda fila no adoptaria por culpa de esas guardas y el
        // test pasaria sin probar lo que dice probar (el set de reclamados).
        const created: OnnixTicketComentario = {
          id: nextOsdId++,
          comment,
          is_internal: isInternal,
          created_at: new Date().toISOString(),
        };
        osdThread.push(created);
        return Promise.resolve({ ok: true, status: 201, data: created });
      });
      onnix.listComments.mockImplementation(() => Promise.resolve([...osdThread]));
      outbox.markSynced.mockImplementation((_id, externalId) => {
        if (externalId) claimedIds.push(externalId);
        return Promise.resolve();
      });
      // Contabilidad COMPLETA (unanchored 0): el dedup esta activo a pleno, asi que
      // lo unico que puede frenar la adopcion es que el "ok" de la primera fila ya
      // tenga dueño. Ese es exactamente el mecanismo bajo prueba.
      outbox.getCommentClaimState.mockImplementation(() =>
        Promise.resolve({ claimedIds: [...claimedIds], unanchored: 0 }),
      );

      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_ok_1', 'ok', 'user_admin', {
          attempts: 0,
          created_at: new Date(Date.now() - 1000),
        }),
        // Ya fallo una vez: pasa por el chequeo anti-duplicado, con el "ok" de la
        // primera fila ya en el hilo de OSD.
        makeNoteRow('row_ok_2', 'ok', 'user_admin', {
          attempts: 1,
          created_at: new Date(Date.now() - 1000),
        }),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 2, failed: 0 });
      // LOS DOS mensajes llegan. Si baja a 1, se perdio uno.
      expect(onnix.addComment).toHaveBeenCalledTimes(2);
      expect(onnix.addComment.mock.calls.map((c) => c[1])).toEqual([
        '[Josu] ok',
        '[Josu] ok',
      ]);
      expect(osdThread.map((c) => c.id)).toEqual([700, 701]);
      // Y cada fila reclama SU id: la segunda nunca se cuelga del de la primera.
      expect(outbox.markSynced).toHaveBeenNthCalledWith(1, 'row_ok_1', '700');
      expect(outbox.markSynced).toHaveBeenNthCalledWith(2, 'row_ok_2', '701');
    });

    it('R2.4: el primer intento (attempts === 0) NO paga el GET de dedup', async () => {
      // El camino feliz —el 99,9% de los drenados— no puede pagar una request extra
      // por ticket para cubrir un caso de reintento.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_feliz', 'nota', 'user_admin', { attempts: 0 }),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.listComments).not.toHaveBeenCalled();
      expect(outbox.getCommentClaimState).not.toHaveBeenCalled();
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
    });

    it('D2.3: un 5xx del comentario postea UNA vez; el de TICKET_CREATED SIGUE reintentando intra-drain', async () => {
      // El contraste es el punto: `retryWithJitter` se saco SOLO del comentario.
      // La creacion tiene el guard de external_id y el estado es last-write-wins,
      // asi que para ellos el reintento inmediato es gratis; para el comentario era
      // el disparo con MAS chances de duplicar (a los ~300ms, con OSD todavia
      // procesando el primero) y encima corria con attempts en 0, el punto ciego
      // del chequeo anti-duplicado.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_5xx_c', 'nota', 'user_admin', { attempts: 0 }),
        makeRow('row_5xx_t', 'TICKET_CREATED', { external_id: null, attempts: 0 }),
      ]);
      prisma.ticket.findUnique.mockResolvedValue(makeTicket());
      mapping.resolveClientId.mockResolvedValue(555);
      mapping.resolveProjectId.mockResolvedValue(777);
      mapping.resolveCatalogIds.mockResolvedValue({
        ticketTypeId: 10,
        ticketCategoryId: 20,
        ticketPriorityId: 30,
      });
      onnix.addComment.mockRejectedValue(new OnnixUpstreamError(503, 'add-comment'));
      onnix.createTicket.mockRejectedValue(new OnnixUpstreamError(503, 'create-ticket'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 2 });
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      expect(onnix.createTicket).toHaveBeenCalledTimes(2);
      await service.onModuleDestroy(); // corta el drenado de seguimiento (D3)
    });

    it('D2.4: el Idempotency-Key es el id de la fila (estable por fila, distinto entre dos filas del mismo texto)', async () => {
      // Esa semantica es exactamente la que hace falta: el mismo valor en los
      // reintentos de UNA fila, distinto entre dos mensajes iguales. El dia que OSD
      // honre el header, el duplicado se corta del otro lado sin tocar nada aca.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_key_1', 'ok', 'user_admin'),
        makeNoteRow('row_key_2', 'ok', 'user_admin'),
      ]);

      await service.processPending();

      expect(onnix.addComment).toHaveBeenNthCalledWith(
        1,
        'TK-2026-000123',
        '[Josu] ok',
        true,
        expect.any(String),
        'row_key_1',
      );
      expect(onnix.addComment).toHaveBeenNthCalledWith(
        2,
        'TK-2026-000123',
        '[Josu] ok',
        true,
        expect.any(String),
        'row_key_2',
      );
    });

    it('R2.6: el re-post tras fallo ambiguo deja un WARN rastreable y NUNCA el cuerpo del comentario', async () => {
      // El re-post es el unico momento en que puede nacer un duplicado (R2.7), asi
      // que tiene que quedar auditable a mano: ticket, code, fila e intentos. El
      // cuerpo no: es conversacion del cliente en un log que termina en Railway.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_warn', 'datos confidenciales del cliente', 'user_admin', {
          attempts: 2,
        }),
      ]);
      onnix.listComments.mockResolvedValueOnce([]); // OSD no tiene huella del intento anterior
      const warnSpy = spyLog('warn');

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.addComment).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('rowId=row_warn');
      expect(logged).toContain('ticketId=ticket_1');
      expect(logged).toContain('code=TK-2026-000123');
      expect(logged).toContain('attempts=2');
      expect(logged).not.toContain('datos confidenciales del cliente');
    });

    it('si el GET de dedup falla, NO se postea a ciegas: la fila vuelve a pending', async () => {
      // Si no podemos preguntar "¿ya llego?", postear seria apostar a que no. Un
      // ciclo mas de espera es barato; un comentario duplicado en OSD no se borra.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_ciego', 'nota', 'user_admin', { attempts: 1 }),
      ]);
      onnix.listComments.mockRejectedValueOnce(
        new OnnixUpstreamError(503, 'list-comments'),
      );

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(onnix.addComment).not.toHaveBeenCalled();
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_ciego',
        expect.stringContaining('503'),
        false, // reintentable: el proximo drenado vuelve a preguntar
      );
      await service.onModuleDestroy(); // corta el drenado de seguimiento (D3)
    });

    it('GUARD D5: el externalId nuevo de COMMENT_ADDED NO confunde a getCreatedExternalId (#13)', async () => {
      // Antes de #51 el unico externalId era el `code` de TICKET_CREATED. Ahora las
      // filas COMMENT_ADDED tambien lo tienen, asi que el ordering gate podria
      // empezar a leer un id de comentario como si fuera el code del ticket.
      // OutboxService REAL contra un findFirst que emula el filtrado de Prisma: si
      // alguien saca el `eventType: 'TICKET_CREATED'` del where, esto lo caza.
      const outboxPrisma = mockDeep<PrismaService>();
      const realOutbox = new OutboxService(outboxPrisma, config, mockDeep<EventEmitter2>());
      const stored = [
        { eventType: 'COMMENT_ADDED', externalId: '99' },
        { eventType: 'TICKET_CREATED', externalId: 'TK-2026-000123' },
      ];
      (outboxPrisma.outboxEvent.findFirst as unknown as jest.Mock).mockImplementation(
        (args: { where: { eventType?: string } }) =>
          Promise.resolve(stored.find((r) => r.eventType === args.where.eventType) ?? null),
      );

      await expect(realOutbox.getCreatedExternalId('ticket_1')).resolves.toBe(
        'TK-2026-000123',
      );
      expect(outboxPrisma.outboxEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ eventType: 'TICKET_CREATED' }),
        }),
      );
    });
  });

  // ── #51 T4 — drenado de seguimiento (R4/D3) ────────────────────────────────

  /**
   * Sacar el reintento intra-drain del comentario (D2.3) deja un hueco: una fila
   * que falla por un blip de OSD esperaria al cron —hasta 20 min— que es justo lo
   * que #50 R4 vino a eliminar. El cierre es re-agendar el drenado al terminar,
   * reusando `scheduleDrain` (mismo debounce, misma guarda de re-armado, misma
   * limpieza en el shutdown): cero maquinaria nueva.
   *
   * Se mide por `jest.getTimerCount()` en vez de espiar el metodo privado: lo que
   * importa es que quede un drenado AGENDADO de verdad, no que se llame una funcion.
   */
  describe('#51 T4 — drenado de seguimiento al cerrar processPending (R4/D3)', () => {
    /**
     * Espera del seguimiento cuando quedaron filas REINTENTABLES (#51 FIX 4). NO es
     * el debounce de 3s: con `ONNIX_SYNC_MAX_ATTEMPTS` y 3s entre intentos el
     * presupuesto se quema en segundos y una caida corta de OSD manda el outbox
     * entero a la DLQ. Duplicado aca (no importado) a proposito: si alguien cambia
     * la constante del service, estos tests tienen que ponerse rojos y obligar a
     * mirar por que.
     */
    const RETRY_BACKOFF_MS = 60_000;
    const DEBOUNCE_MS = 3000;

    beforeEach(() => {
      jest.useFakeTimers();
      outbox.getCreatedExternalId.mockResolvedValue('TK-2026-000123');
      prisma.user.findUnique.mockResolvedValue({ name: 'Josu' } as never);
      onnix.addComment.mockResolvedValue(okComment());
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('R4.1/FIX 4: un fallo transitorio agenda con RETRY_BACKOFF_MS, NO con el debounce', async () => {
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_t4_retry', 'nota', 'user_admin', { attempts: 0 }),
      ]);
      onnix.addComment.mockRejectedValue(new OnnixUpstreamError(503, 'add-comment'));

      const res = await service.processPending();

      // La fila volvio a pending (reintentable), no quedo terminal en la DLQ.
      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith(
        'row_t4_retry',
        expect.stringContaining('503'),
        false,
      );
      expect(jest.getTimerCount()).toBe(1);

      const drainSpy = jest
        .spyOn(service, 'processPending')
        .mockResolvedValue({ synced: 0, failed: 0 });
      // A los 3s NO tiene que reintentar: con el debounce corto, tres intentos se
      // consumen en ~9 segundos y un blip de 60s de OSD manda todo a la DLQ.
      jest.advanceTimersByTime(RETRY_BACKOFF_MS - 1);
      expect(drainSpy).not.toHaveBeenCalled();

      // Y ese timer SI es un drenado: al vencer el backoff corre processPending.
      jest.advanceTimersByTime(1);
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('R4.1: un lote LLENO con avance agenda seguimiento con el DEBOUNCE corto (es latencia, no reintento)', async () => {
      // `claimed === batchSize` significa que habia al menos tantas pendientes como
      // el batch: casi seguro quedo trabajo atras. Aplica a TODOS los eventTypes.
      config.onnixSyncBatchSize = 2;
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_t4_full_a', 'uno', 'user_admin'),
        makeNoteRow('row_t4_full_b', 'dos', 'user_admin'),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 2, failed: 0 });
      expect(jest.getTimerCount()).toBe(1);

      const drainSpy = jest
        .spyOn(service, 'processPending')
        .mockResolvedValue({ synced: 0, failed: 0 });
      jest.advanceTimersByTime(DEBOUNCE_MS - 1);
      expect(drainSpy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('⚠️ FIX 3: un lote LLENO de puros `skipped` (ordering gate) NO agenda NADA', async () => {
      // El busy-loop que estuvo 24h vivo en produccion: `claimed === batchSize` a
      // secas lo cumple un lote entero de filas que el gate LIBERA sin avanzar nada
      // (claim de N, N release, "synced=0 failed=0", re-agenda a los 3s, otra vez).
      // ~28.800 ciclos y ~2,9M de escrituras muertas por dia contra la DB, durante
      // las 24h que tarda el fondo de pozo en declararlas terminales. Esas filas no
      // consumieron intento: las despierta su TICKET_CREATED via notifyEnqueued.
      config.onnixSyncBatchSize = 2;
      outbox.claim.mockResolvedValueOnce([
        makeChatRow('row_t4_gate_a', 'msg_a', { created_at: new Date() }),
        makeChatRow('row_t4_gate_b', 'msg_b', { created_at: new Date() }),
      ]);
      outbox.getCreatedExternalId.mockResolvedValue(null); // el ticket aun no esta en OSD

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.release).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('FIX 3: lote lleno con UNA sola fila que avanzo -> SI agenda (el corte es "hubo trabajo util")', async () => {
      // La contracara del anterior: la condicion no es "todo avanzo", es "avanzo
      // algo". Si se endureciera de mas, un lote mixto dejaria de encadenar y el
      // backlog volveria a depender del cron de 20 min.
      config.onnixSyncBatchSize = 2;
      outbox.claim.mockResolvedValueOnce([
        makeChatRow('row_t4_mix_gate', 'msg_gate', { created_at: new Date() }),
        makeNoteRow('row_t4_mix_ok', 'nota', 'user_admin'),
      ]);
      outbox.getCreatedExternalId
        .mockResolvedValueOnce(null) // la primera queda en el gate
        .mockResolvedValueOnce('TK-2026-000123');

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(jest.getTimerCount()).toBe(1);
    });

    it('⚠️ FIX 3: batchSize 0 (env var VACIA en Railway) NO agenda: `0 === 0` era un bucle infinito', async () => {
      // `Number('') === 0` y pasa la validacion. Con la condicion vieja
      // (`claimed === batchSize`) un lote vacio cumplia `0 === 0` y el drenado se
      // re-agendaba para siempre con la cola MUERTA: nada se sincronizaba y la DB
      // comia un claim cada 3 segundos. Por eso se exige tambien `claimed > 0`.
      config.onnixSyncBatchSize = 0;
      outbox.claim.mockResolvedValueOnce([]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.claim).toHaveBeenCalledWith(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('todo synced y lote CORTO -> NO agenda nada (no se drena en vacio en bucle)', async () => {
      // La contracara. Si esto se rompe, cada drenado agenda otro para siempre.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_t4_ok', 'nota', 'user_admin'),
      ]);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('un failed TERMINAL (cap de intentos) NO agenda: esa fila ya no se mueve sola', async () => {
      // Aca esta el porque de distinguir `retry` de `failed` en vez de contar
      // `result.failed`: la fila capeo y quedo en la DLQ, asi que re-agendar seria
      // un drenado en vacio en bucle hasta que alguien la saque a mano.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_t4_cap', 'nota', 'user_admin', { attempts: 2 }), // cap = 3
      ]);
      onnix.addComment.mockRejectedValue(new OnnixUpstreamError(500, 'add-comment'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith('row_t4_cap', expect.any(String), true);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('el ordering gate (skipped) NO agenda por si solo: su TICKET_CREATED la despierta', async () => {
      // Esa fila no consumio intento y lo que le falta es el code del ticket, que
      // llega por notifyEnqueued cuando el TICKET_CREATED se sincroniza. Agendar
      // por ella seria drenar en vacio cada debounce hasta las 24h del fondo de pozo.
      outbox.claim.mockResolvedValueOnce([
        makeChatRow('row_t4_gate', 'msg_1', { created_at: new Date() }),
      ]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.release).toHaveBeenCalledWith('row_t4_gate');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('con el flag maestro apagado no agenda seguimiento (ni siquiera reclama)', async () => {
      config.onnixSyncEnabled = false;

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.claim).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('el seguimiento reusa scheduleDrain: onModuleDestroy lo corta y no drena en el shutdown', async () => {
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_t4_destroy', 'nota', 'user_admin', { attempts: 0 }),
      ]);
      onnix.addComment.mockRejectedValue(new OnnixUpstreamError(503, 'add-comment'));

      await service.processPending();
      expect(jest.getTimerCount()).toBe(1);

      await service.onModuleDestroy();

      // Si el seguimiento usara un setTimeout propio en vez de scheduleDrain,
      // `drainTimer` no lo apuntaria y el shutdown no lo cortaria.
      expect(jest.getTimerCount()).toBe(0);
      const drainSpy = jest.spyOn(service, 'processPending');
      jest.advanceTimersByTime(60_000);
      expect(drainSpy).not.toHaveBeenCalled();
    });

    it('si el seguimiento vence con OTRO drenado en vuelo, re-arma en vez de solaparse', async () => {
      // La guarda de #50 FIX 3 tiene que seguir cubriendo tambien a este disparo:
      // dos processPending solapados vuelven a desordenar la conversacion en OSD.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_t4_rearm', 'nota', 'user_admin', { attempts: 0 }),
      ]);
      onnix.addComment.mockRejectedValueOnce(new OnnixUpstreamError(503, 'add-comment'));
      await service.processPending();
      expect(jest.getTimerCount()).toBe(1);

      // Segundo drenado EN VUELO (claim diferido): `running` queda en true.
      let releaseClaim!: (rows: OutboxRow[]) => void;
      outbox.claim.mockReturnValueOnce(
        new Promise<OutboxRow[]>((resolve) => {
          releaseClaim = resolve;
        }),
      );
      const inFlight = service.processPending();
      const drainSpy = jest.spyOn(service, 'processPending');

      // El timer pendiente es el del BACKOFF (el ciclo cerro con una fila
      // reintentable), asi que hay que llegar hasta los 60s para que venza.
      jest.advanceTimersByTime(RETRY_BACKOFF_MS);

      expect(drainSpy).not.toHaveBeenCalled(); // no arranco un tercero en paralelo
      expect(jest.getTimerCount()).toBe(1); // el disparo no se perdio: re-armado

      releaseClaim([]);
      await inFlight;
      await service.onModuleDestroy();
    });

    // ── FIX 4: un solo timer, dos esperas de proposito opuesto ────────────────

    it('⚠️ FIX 4: un pedido mas CORTO reemplaza al backoff pendiente (un mensaje nuevo no espera 60s)', async () => {
      // Si el backoff no se pudiera adelantar, un mensaje escrito durante la ventana
      // de reintento saldria recien un minuto despues: el drain-on-enqueue de #50
      // quedaria anulado justo cuando OSD ya se recupero.
      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_t4_corto', 'nota', 'user_admin', { attempts: 0 }),
      ]);
      onnix.addComment.mockRejectedValueOnce(new OnnixUpstreamError(503, 'add-comment'));
      await service.processPending(); // arma el backoff de 60s
      expect(jest.getTimerCount()).toBe(1);

      const drainSpy = jest
        .spyOn(service, 'processPending')
        .mockResolvedValue({ synced: 0, failed: 0 });
      service.onOutboxEnqueued(); // llega un mensaje: pide 3s

      // Sigue habiendo UN solo timer (se reemplazo, no se sumo) y vence a los 3s.
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(DEBOUNCE_MS);
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('⚠️ FIX 4: un backoff NO atrasa un debounce ya agendado (el reintento no puede frenar la rafaga)', async () => {
      // La direccion contraria. Si el pedido largo pisara al corto, cada ciclo con
      // una fila reintentable empujaria el drenado de los mensajes NUEVOS a 60s.
      service.onOutboxEnqueued(); // debounce de 3s armado
      expect(jest.getTimerCount()).toBe(1);

      outbox.claim.mockResolvedValueOnce([
        makeNoteRow('row_t4_largo', 'nota', 'user_admin', { attempts: 0 }),
      ]);
      onnix.addComment.mockRejectedValueOnce(new OnnixUpstreamError(503, 'add-comment'));
      await service.processPending(); // pide 60s: tiene que ser IGNORADO

      expect(jest.getTimerCount()).toBe(1);
      const drainSpy = jest
        .spyOn(service, 'processPending')
        .mockResolvedValue({ synced: 0, failed: 0 });
      jest.advanceTimersByTime(DEBOUNCE_MS);
      expect(drainSpy).toHaveBeenCalledTimes(1); // salio a los 3s, no a los 60s
    });
  });

  // ── #52 T5 — ASSIGNEE_CHANGED ──────────────────────────────────────────────

  describe('ASSIGNEE_CHANGED — #52 T5 (R3.2/R3.3/R3.4)', () => {
    it('R3.3: gate de orden — sin code de creacion aun -> release SIN consumir intento', async () => {
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a1')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.release).toHaveBeenCalledWith('row_a1');
      expect(outbox.markFailed).not.toHaveBeenCalled();
      expect(onnix.assignTicket).not.toHaveBeenCalled();
      // El gate corre ANTES de leer nada: no se toca el ticket.
      expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
    });

    it('R3.2/R3.3: RELEE el asignado actual y lo manda con el reason del actor', async () => {
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a2', 'user_actor')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      prisma.user.findUnique.mockResolvedValueOnce({ name: 'Josue Farias' } as never);
      onnix.assignTicket.mockResolvedValueOnce({ ok: true, status: 200 });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      // El asignado sale de la RELECTURA del ticket (R3.2), no del payload.
      expect(mapping.resolveUserId).toHaveBeenCalledWith('org-test', 'user_ada');
      expect(onnix.assignTicket).toHaveBeenCalledWith(
        'TK-2026-000123',
        {
          assigned_to: 10,
          reason: 'Sincronizado desde Zentik — asignado por Josue Farias',
        },
        expect.any(String),
      );
      expect(outbox.markSynced).toHaveBeenCalledWith('row_a2');
    });

    it('R3.3: actor sin nombre cargado -> el reason cae al fallback, NUNCA rompe la asignacion', async () => {
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a3', 'user_fantasma')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      prisma.user.findUnique.mockResolvedValueOnce(null as never); // actor borrado
      onnix.assignTicket.mockResolvedValueOnce({ ok: true, status: 200 });

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.assignTicket).toHaveBeenCalledWith(
        'TK-2026-000123',
        expect.objectContaining({ reason: 'Sincronizado desde Zentik — asignado por Usuario' }),
        expect.any(String),
      );
    });

    it('R3.3: reason TRUNCADO a 500 — un nombre absurdo no puede convertir la asignacion en un 422', async () => {
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a4', 'user_actor')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      prisma.user.findUnique.mockResolvedValueOnce({ name: 'N'.repeat(900) } as never);
      onnix.assignTicket.mockResolvedValueOnce({ ok: true, status: 200 });

      await service.processPending();

      const body = onnix.assignTicket.mock.calls[0][1];
      expect(body.reason?.length).toBe(500);
    });

    it('R3.3: ticket SIN responsable (desasignado en Zentik) -> skip con log, OSD conserva el ultimo', async () => {
      // OSD no tiene desasignacion (`assigned_to` es obligatorio en /asignar):
      // no hay nada que mandar y ningun reintento lo arregla. Limitacion conocida.
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a5')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket(null));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 }); // skipped no incrementa contadores
      expect(onnix.assignTicket).not.toHaveBeenCalled();
      // markSynced (la fila esta TERMINADA), NUNCA markFailed: no es un defecto y no
      // puede quedar en la DLQ.
      expect(outbox.markSynced).toHaveBeenCalledWith('row_a5');
      expect(outbox.markFailed).not.toHaveBeenCalled();
    });

    it('R3.3: responsable SIN mapping -> skip con warn, NO va a la DLQ', async () => {
      const warn = spyLog('warn');
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a6')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_sin_par'));
      mapping.resolveUserId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(onnix.assignTicket).not.toHaveBeenCalled();
      expect(outbox.markSynced).toHaveBeenCalledWith('row_a6');
      expect(outbox.markFailed).not.toHaveBeenCalled();
      // El warn tiene que decir QUE hacer (correr el seed), no solo que fallo.
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain('user_sin_par');
      expect(msg).toContain('seed-users');
    });

    it('⚠️ R3.3 EL TEST QUE IMPORTA: 422 del cerco -> skip con warn, la fila NUNCA llega a la DLQ', async () => {
      // Es LA excepcion deliberada al manejo 4xx del dispatcher, y solo para este
      // eventType. En cualquier otro, un 422 es terminal y la fila queda `failed`
      // (= DLQ). Acá el 422 significa "el rol de integracion no puede asignarle a
      // esta persona": un limite de permisos CONOCIDO que ningun requeue arregla.
      // Si esta fila cayera en `failed`, cada asignacion a alguien fuera del equipo
      // envenenaria la cola y haria sonar checkDlqAge por algo sano.
      const warn = spyLog('warn');
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a7')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      onnix.assignTicket.mockResolvedValueOnce({
        ok: false,
        status: 422,
        message: 'El usuario no pertenece a tu equipo',
      });

      const res = await service.processPending();

      // ⚠️ EL ASSERT, y va PRIMERO a proposito: NADA de esto puede terminar en
      // `failed`. `markFailed` es el unico camino a la DLQ.
      expect(outbox.markFailed).not.toHaveBeenCalled();
      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.markSynced).toHaveBeenCalledWith('row_a7');
      // El mensaje CRUDO de OSD viaja al warn: un 422 inesperado sigue siendo
      // diagnosticable aunque el manejo sea el mismo.
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain('El usuario no pertenece a tu equipo');
      expect(msg).toContain('NO va a la DLQ');
    });

    it('R3.3: un 422 con OTRA redaccion tampoco va a la DLQ (no se matchea la frase del cerco)', async () => {
      // Contrapunto del anterior. La alternativa —matchear "no es de tu equipo" y
      // mandar el resto a la DLQ, como hace STATUS_CHANGED con el "ya esta en ese
      // estado"— apostaria a la redaccion literal de un mensaje en español de OSD.
      // El dia que le cambien una palabra, el 422 esperable se vuelve la fila
      // envenenada que R3.3 vino a evitar. Acá el default seguro es skipear.
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a8')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      onnix.assignTicket.mockResolvedValueOnce({
        ok: false,
        status: 422,
        message: 'assigned_to invalido',
      });

      const res = await service.processPending();

      expect(outbox.markFailed).not.toHaveBeenCalled();
      expect(res).toEqual({ synced: 0, failed: 0 });
      expect(outbox.markSynced).toHaveBeenCalledWith('row_a8');
    });

    it('GUARD: un 5xx SI sigue siendo reintentable (el skip del 422 no se comio el manejo transitorio)', async () => {
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a9', 'user_actor', { attempts: 0 })]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      onnix.assignTicket.mockRejectedValue(new OnnixUpstreamError(503, 'assign-ticket'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith('row_a9', expect.stringContaining('503'), false);
      expect(outbox.markSynced).not.toHaveBeenCalled();
      await service.onModuleDestroy(); // limpia el timer de seguimiento
    });

    it('GUARD: un 403 (permiso faltante) SI tiene que ser ruidoso — no se skipea como el 422', async () => {
      // R0.3: `tickets.assign` y `tickets.reassign` son permisos distintos. Si
      // alguien revoca uno, el 403 tiene que doler (reintento -> cap -> DLQ), no
      // desaparecer en un warn: es un problema de configuracion que hay que
      // arreglar, no un limite esperable como el cerco.
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a10', 'user_actor', { attempts: 2 })]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      onnix.assignTicket.mockRejectedValue(new OnnixUpstreamError(403, 'assign-ticket'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith('row_a10', expect.stringContaining('403'), true);
    });

    it('R3.4: tras asignar OK, REAFIRMA el estado encolando un STATUS_CHANGED y avisa al drenador', async () => {
      // OSD mueve el ticket a "asignado" al asignar. Sin esta reafirmacion, un
      // ticket que en Zentik esta "en proceso" aparece RETROCEDIDO del lado del
      // cliente y ningun evento de Zentik lo explica.
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a11')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      onnix.assignTicket.mockResolvedValueOnce({ ok: true, status: 200 });
      outbox.enqueueTx.mockResolvedValueOnce(true);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(outbox.enqueueTx).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          eventType: 'STATUS_CHANGED',
          aggregateId: 'ticket_1',
          organizationId: 'org-test',
          payload: { ticketId: 'ticket_1' },
        }),
      );
      // La fila nace DESPUES del claim de este drenado: sin el aviso esperaria al cron.
      expect(outbox.notifyEnqueued).toHaveBeenCalledTimes(1);
      await service.onModuleDestroy();
    });

    it('R3.4: si el encolado de la reafirmacion falla, la asignacion NO se revierte (ERROR loggeado, fila synced)', async () => {
      // La asignacion YA se aplico en OSD y es irreversible. Fallar la fila la
      // devolveria a pending y volveria a asignar; peor, un markFailed tardio sobre
      // una fila ya `synced` no escribe nada y el operador se queda sin señal.
      const error = spyLog('error');
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a12')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      onnix.assignTicket.mockResolvedValueOnce({ ok: true, status: 200 });
      outbox.enqueueTx.mockRejectedValueOnce(new Error('DB caida'));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(outbox.markSynced).toHaveBeenCalledWith('row_a12');
      expect(outbox.markFailed).not.toHaveBeenCalled();
      expect(String(error.mock.calls[0][0])).toContain('reafirmacion');
    });

    it('R3.4: NO se reafirma nada cuando la asignacion NO se envio (skip del 422)', async () => {
      // Sin POST, OSD no movio el estado: encolar un STATUS_CHANGED seria una
      // llamada a OSD por un efecto que nunca ocurrio.
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a13')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      onnix.assignTicket.mockResolvedValueOnce({ ok: false, status: 422, message: 'cerco' });

      await service.processPending();

      expect(outbox.enqueueTx).not.toHaveBeenCalled();
      expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
    });

    it('R5.3: dry-run resuelve todo pero NO llama a OSD ni reafirma el estado', async () => {
      config.onnixSyncDryRun = true;
      const warn = spyLog('warn');
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a14', 'user_actor')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(makeAssignTicket('user_ada'));
      mapping.resolveUserId.mockResolvedValueOnce(10);
      prisma.user.findUnique.mockResolvedValueOnce({ name: 'Josue Farias' } as never);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 0, dryRun: 1 });
      expect(onnix.assignTicket).not.toHaveBeenCalled();
      expect(outbox.enqueueTx).not.toHaveBeenCalled();
      expect(outbox.markFailed).toHaveBeenCalledWith('row_a14', expect.stringContaining('DRY_RUN'), true);
      // El QA valida en el log que el responsable resuelto es el correcto.
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain('assigned_to=10');
      expect(msg).toContain('DRY_RUN');
    });

    it('ticket borrado entre el encolado y el drenado -> failed terminal (payload sin sujeto)', async () => {
      outbox.claim.mockResolvedValueOnce([makeAssignRow('row_a15')]);
      outbox.getCreatedExternalId.mockResolvedValueOnce('TK-2026-000123');
      prisma.ticket.findUnique.mockResolvedValueOnce(null as never);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 0, failed: 1 });
      expect(outbox.markFailed).toHaveBeenCalledWith('row_a15', expect.stringContaining('no existe'), true);
    });
  });

  // ── #52 T3 — assigned_to en el create ──────────────────────────────────────

  describe('TICKET_CREATED — #52 R2 assigned_to en el create', () => {
    function arrangeCreate(): void {
      outbox.claim.mockResolvedValueOnce([makeRow('row_c52', 'TICKET_CREATED', { external_id: null })]);
      mapping.resolveClientId.mockResolvedValueOnce(555);
      mapping.resolveProjectId.mockResolvedValueOnce(777);
      mapping.resolveCatalogIds.mockResolvedValueOnce({
        ticketTypeId: 10,
        ticketCategoryId: 20,
        ticketPriorityId: 30,
      });
      onnix.createTicket.mockResolvedValueOnce(okCreate('TK-2026-000123'));
      prisma.ticket.update.mockResolvedValueOnce({} as never);
    }

    it('R2.1: ticket YA asignado y con mapping -> nace en OSD con ese responsable', async () => {
      arrangeCreate();
      prisma.ticket.findUnique.mockResolvedValueOnce(
        makeTicket({ task: { assignments: [{ userId: 'user_ada' }] } }),
      );
      mapping.resolveUserId.mockResolvedValueOnce(10);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      expect(onnix.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ assigned_to: 10 }),
        expect.any(String),
      );
    });

    it('R2.2: asignado SIN mapping -> el body va SIN assigned_to (el create nunca falla por esto)', async () => {
      arrangeCreate();
      prisma.ticket.findUnique.mockResolvedValueOnce(
        makeTicket({ task: { assignments: [{ userId: 'user_sin_par' }] } }),
      );
      mapping.resolveUserId.mockResolvedValueOnce(null);

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      // La CLAVE no puede existir: `assigned_to: undefined` sigue siendo una clave
      // en el JSON del body y un backend estricto la rechazaria.
      const body = onnix.createTicket.mock.calls[0][0];
      expect(body).not.toHaveProperty('assigned_to');
    });

    it('R2.2: ticket SIN asignado -> body intacto, identico al de antes de #52', async () => {
      arrangeCreate();
      prisma.ticket.findUnique.mockResolvedValueOnce(makeTicket({ task: null }));

      const res = await service.processPending();

      expect(res).toEqual({ synced: 1, failed: 0 });
      const body = onnix.createTicket.mock.calls[0][0];
      expect(body).not.toHaveProperty('assigned_to');
      expect(mapping.resolveUserId).toHaveBeenCalledWith('org-test', undefined);
    });
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

/**
 * Fila ASSIGNEE_CHANGED (#52 R3.2): el payload NO lleva el asignado —el dispatcher
 * lo RELEE al drenar, last-write-wins— sino solo el ACTOR, que es lo unico que el
 * drenado no puede reconstruir (el ticket no guarda quien reasigno).
 */
function makeAssignRow(
  id: string,
  assignedByUserId = 'user_actor',
  overrides: Partial<OutboxRow> = {},
): OutboxRow {
  return makeRow(id, 'ASSIGNEE_CHANGED', {
    payload: { ticketId: 'ticket_1', assignedByUserId },
    ...overrides,
  });
}

/**
 * Partial del Ticket tal como lo proyecta processAssign
 * (`select: { organizationId, task: { assignments: { userId } } }`).
 * `assigneeId = null` = ticket desasignado en Zentik (la task existe pero sin
 * assignments), que es el caso que OSD no puede representar.
 */
function makeAssignTicket(assigneeId: string | null): never {
  return {
    organizationId: 'org-test',
    task: { assignments: assigneeId ? [{ userId: assigneeId }] : [] },
  } as never;
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
