import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { TicketStatus } from '@prisma/client';
import { SyncDispatcherService } from './sync-dispatcher.service';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService } from './outbox.service';
import { OnnixClientService } from './onnix-client.service';
import { OnnixMappingService } from './onnix-mapping.service';
import { OnnixUpstreamError } from './errors';
import { OutboxRow } from './types/outbox.types';
import { OnnixCallOutcome, OnnixTicketDetalle } from './types/onnix.types';

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

    service = new SyncDispatcherService(prisma, config, outbox, onnix, mapping);
    // Neutraliza los backoffs reales (retryWithJitter -> sleep) para tests rapidos.
    jest
      .spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    // checkDlqAge no es el foco de estos tests.
    prisma.outboxEvent.findFirst.mockResolvedValue(null);
  });

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
      expect(mapping.resolveCatalogIds).toHaveBeenCalledWith(
        'org-test',
        'SUPPORT_REQUEST',
        'MEDIUM',
        expect.any(String),
      );
      expect(outbox.markSynced).toHaveBeenCalledWith('row_1', 'TK-2026-000123');
      // Persiste el code en el ticket (best-effort).
      expect(prisma.ticket.update).toHaveBeenCalledWith({
        where: { id: 'ticket_1' },
        data: { onnixCode: 'TK-2026-000123' },
      });
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
  });
});

// ── Factories ─────────────────────────────────────────────────────────────

function makeRow(
  id: string,
  eventType: 'TICKET_CREATED' | 'STATUS_CHANGED',
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

// Partial del Ticket de Prisma: solo los campos que lee processCreate. Cast a
// `never` porque el modelo Ticket completo tiene ~25 campos no relevantes aqui.
function makeTicket(): never {
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
  } as never;
}

function okCreate(code: string): OnnixCallOutcome<OnnixTicketDetalle> {
  return { ok: true, status: 201, data: { id: 1, code } };
}
