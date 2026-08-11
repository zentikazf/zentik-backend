import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { TicketService } from './ticket.service';
import { PrismaService } from '../../database/prisma.service';
import { TicketEventsService } from './ticket-events.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService } from '../sync/outbox.service';
import { TaskHoursGuardService } from '../task/task-hours-guard.service';
import { SlaResolverService } from '../sla/sla-resolver.service';
import { TicketClassificationGuardService } from './ticket-classification-guard.service';
import { TicketStatusDto } from './dto/update-ticket.dto';
import { OutboxPayload } from '../sync/types/outbox.types';

/**
 * Feature #50 (T5) — la NOTA INTERNA viaja a OSD como comentario `is_internal`.
 *
 * Vive en su propio archivo (no en `ticket.service.spec.ts`) por dos razones:
 * el `beforeEach` de aquel spec esta cableado al camino feliz de `createTicket`
 * (stubs de task/channel/generateTicketNumber que este flujo no usa) y ademas
 * instancia `TicketService` SIN el `classificationGuard`, que `updateTicket` si
 * necesita. Es tambien la convencion del modulo: un archivo por tema
 * (`ticket-lifecycle`, `ticket-reclassify`, `ticket-list-where`).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod).
 * Onnix no participa: se verifica el punto de ENCOLADO (`OutboxService`), no el
 * envio (eso es del dispatcher, T6).
 *
 * El `tx` mockeado simula la persistencia real de `adminNotes` (el update
 * "guarda" y el findUnique siguiente "lee" lo guardado). Sin eso, el test del
 * corazon de R3.2 (dos ediciones = dos snapshots distintos) no probaria nada:
 * el previo siempre seria el mismo y ambas ediciones parecerian un cambio.
 */
describe('TicketService — nota interna al outbox Onnix (#50 R3)', () => {
  let service: TicketService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let events: DeepMockProxy<TicketEventsService>;
  let config: DeepMockProxy<AppConfigService> & { slaCascadeEnabled: boolean };
  let outbox: DeepMockProxy<OutboxService>;
  let hoursGuard: DeepMockProxy<TaskHoursGuardService>;
  let slaResolver: DeepMockProxy<SlaResolverService>;
  let classificationGuard: DeepMockProxy<TicketClassificationGuardService>;
  let lastTx: DeepMockProxy<Prisma.TransactionClient>;

  /** Valor "en la DB" de adminNotes: lo lee el tx y lo pisa el update. */
  let storedAdminNotes: string | null;
  /** Traza de orden real de ejecucion — sirve para probar el post-commit (R4.3). */
  let trace: string[];

  const ORG = 'org-1';
  const TICKET = 'ticket-1';
  const USER = 'user-staff-1';

  /** El ticket que devuelve el findUnique de arranque (y el getTicketDetail final). */
  function stubTicket(extra: Record<string, unknown> = {}) {
    prisma.ticket.findUnique.mockResolvedValue({
      id: TICKET,
      status: 'IN_PROGRESS',
      organizationId: ORG,
      category: 'SUPPORT_REQUEST',
      adminNotes: storedAdminNotes,
      firstResponseAt: null,
      resolvedAt: null,
      channelId: null,
      task: null,
      ...extra,
    } as never);
  }

  /** Payload de la enesima llamada a enqueueTx, ya tipado. */
  function payloadOf(callIndex: number): OutboxPayload {
    return outbox.enqueueTx.mock.calls[callIndex][1].payload;
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    events = mockDeep<TicketEventsService>();
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & {
      slaCascadeEnabled: boolean;
    };
    outbox = mockDeep<OutboxService>();
    hoursGuard = mockDeep<TaskHoursGuardService>();
    slaResolver = mockDeep<SlaResolverService>();
    classificationGuard = mockDeep<TicketClassificationGuardService>();
    // #44: solo RESOLVED gatea (como el real). Estos tests no resuelven tickets,
    // pero mockDeep devolveria un truthy y activaria el candado sin querer.
    classificationGuard.isGatedStatus.mockImplementation((s?: string | null) => s === 'RESOLVED');
    classificationGuard.isClassified.mockResolvedValue(true);
    config.slaCascadeEnabled = false;

    storedAdminNotes = null;
    trace = [];

    service = new TicketService(
      prisma,
      eventEmitter,
      events,
      config,
      outbox,
      hoursGuard,
      slaResolver,
      classificationGuard,
    );

    // #50 D8: `enqueueTx` devuelve true = escribio fila. El default de mockDeep es
    // `undefined` (falsy) y haria pasar por verde el test de `notifyEnqueued`.
    outbox.enqueueTx.mockImplementation(async () => {
      trace.push('enqueue');
      return true;
    });
    outbox.notifyEnqueued.mockImplementation(() => {
      trace.push('notify');
    });

    prisma.$transaction.mockImplementation(async (cb: unknown) => {
      const tx = mockDeep<Prisma.TransactionClient>();

      // R3.1: la lectura del valor PREVIO va por el tx (serializada con la
      // escritura), no por `prisma`. Devuelve lo "persistido" hasta ahora.
      (tx.ticket.findUnique as unknown as jest.Mock).mockImplementation(async () => ({
        adminNotes: storedAdminNotes,
      }));
      // El update "persiste": la siguiente edicion vera este valor como previo.
      (tx.ticket.update as unknown as jest.Mock).mockImplementation(
        async (args: { data: Record<string, unknown> }) => {
          if ('adminNotes' in args.data) {
            storedAdminNotes = (args.data.adminNotes as string | null) ?? null;
          }
          return {
            id: TICKET,
            project: { id: 'p1', name: 'P' },
            client: { id: 'c1', name: 'C' },
            task: null,
          };
        },
      );
      tx.ticket.findUniqueOrThrow.mockResolvedValue({
        id: TICKET,
        project: { id: 'p1', name: 'P' },
        client: { id: 'c1', name: 'C' },
        task: null,
      } as never);

      lastTx = tx;
      const result = await (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
      trace.push('commit');
      return result;
    });
  });

  // ── R3.1 / R3.2: el cambio encola con SNAPSHOT ─────────────────────────────
  describe('la nota cambio', () => {
    it('encola COMMENT_ADDED con el texto nuevo como snapshot y el autor del guardado', async () => {
      storedAdminNotes = 'nota vieja';
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: 'nota nueva' }, USER);

      expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
      expect(outbox.enqueueTx.mock.calls[0][1]).toMatchObject({
        eventType: 'COMMENT_ADDED',
        aggregateId: TICKET,
        organizationId: ORG,
        payload: {
          ticketId: TICKET,
          adminNoteSnapshot: 'nota nueva',
          // R3.3: el dispatcher arma el prefijo `[Nombre]` con este autor (OSD
          // atribuye todo al usuario de servicio).
          authorUserId: USER,
        },
      });
      // Es nota interna, NO chat: el payload no lleva messageId (el discriminante
      // del dispatcher es justamente `adminNoteSnapshot !== undefined`).
      expect(payloadOf(0).messageId).toBeUndefined();
    });

    it('el snapshot va trimmeado pero lo que se PERSISTE es el texto tal cual (D6)', async () => {
      storedAdminNotes = null;
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: '  con espacios  ' }, USER);

      expect(payloadOf(0).adminNoteSnapshot).toBe('con espacios');
      const data = (lastTx.ticket.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(data.adminNotes).toBe('  con espacios  ');
    });

    it('la primera nota (previo null) tambien encola', async () => {
      storedAdminNotes = null;
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: 'primera nota' }, USER);

      expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
      expect(payloadOf(0).adminNoteSnapshot).toBe('primera nota');
    });

    /**
     * R3.1: el previo se lee DENTRO de la tx y ANTES del update. Si se leyera
     * despues, el "previo" seria el valor recien escrito y NUNCA habria cambio
     * detectado — la nota jamas llegaria a OSD y nadie se enteraria.
     */
    it('lee el previo por el tx (no por prisma) y ANTES del update', async () => {
      storedAdminNotes = 'vieja';
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: 'nueva' }, USER);

      expect(lastTx.ticket.findUnique).toHaveBeenCalledWith({
        where: { id: TICKET },
        select: { adminNotes: true },
      });
      expect(lastTx.ticket.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        lastTx.ticket.update.mock.invocationCallOrder[0],
      );
    });
  });

  // ── R3.1: sin cambio no hay comentario ─────────────────────────────────────
  describe('la nota NO cambio', () => {
    it('mismo texto → NO encola (el "Guardar" repetido de la UI no duplica en OSD)', async () => {
      storedAdminNotes = 'misma nota';
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: 'misma nota' }, USER);

      expect(outbox.enqueueTx).not.toHaveBeenCalled();
      expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
    });

    it('mismo texto con espacios de mas → NO encola (la comparacion es trim vs trim)', async () => {
      storedAdminNotes = 'misma nota';
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: '   misma nota  ' }, USER);

      expect(outbox.enqueueTx).not.toHaveBeenCalled();
    });
  });

  // ── R3.4: borrar la nota no genera comentario ──────────────────────────────
  describe('la nota se vacia (R3.4)', () => {
    it('texto vacio → NO encola, pero SI se persiste el borrado', async () => {
      storedAdminNotes = 'habia una nota';
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: '' }, USER);

      expect(outbox.enqueueTx).not.toHaveBeenCalled();
      // El gate es solo de ENCOLADO: la nota se borra igual en Zentik.
      const data = (lastTx.ticket.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(data.adminNotes).toBe('');
    });

    it('solo espacios → NO encola (OSD no tiene borrado de comentario: mandar vacio ensucia el hilo)', async () => {
      storedAdminNotes = 'habia una nota';
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: '    ' }, USER);

      expect(outbox.enqueueTx).not.toHaveBeenCalled();
    });
  });

  /**
   * ── R3.2: EL CORAZON DE LA DECISION ────────────────────────────────────────
   *
   * Dos guardados rapidos generan DOS filas, cada una con el texto de ESE
   * guardado. Si el dispatcher releyera el ticket al drenar (como hace con el
   * chat), ambas filas mandarian el texto FINAL a OSD: el mismo comentario dos
   * veces y la version intermedia perdida para siempre. Por eso el payload
   * congela el snapshot en el momento del guardado.
   */
  describe('dos ediciones seguidas (R3.2 — snapshot, no relectura)', () => {
    it('produce DOS filas con DOS textos distintos, cada uno el de SU guardado', async () => {
      storedAdminNotes = null;
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: 'version 1' }, USER);
      await service.updateTicket(TICKET, { adminNotes: 'version 2' }, USER);

      expect(outbox.enqueueTx).toHaveBeenCalledTimes(2);
      // La clave: la PRIMERA fila sigue diciendo "version 1" despues del segundo
      // guardado. Con relectura ambas dirian "version 2".
      expect([payloadOf(0).adminNoteSnapshot, payloadOf(1).adminNoteSnapshot]).toEqual([
        'version 1',
        'version 2',
      ]);
      expect(outbox.notifyEnqueued).toHaveBeenCalledTimes(2);
    });

    it('tercera edicion que vuelve al texto original tambien encola (es un cambio real)', async () => {
      storedAdminNotes = null;
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: 'A' }, USER);
      await service.updateTicket(TICKET, { adminNotes: 'B' }, USER);
      await service.updateTicket(TICKET, { adminNotes: 'A' }, USER);

      expect(outbox.enqueueTx).toHaveBeenCalledTimes(3);
      expect([
        payloadOf(0).adminNoteSnapshot,
        payloadOf(1).adminNoteSnapshot,
        payloadOf(2).adminNoteSnapshot,
      ]).toEqual(['A', 'B', 'A']);
    });
  });

  // ── Gate por categoria: el scope de la integracion son los tickets de soporte ─
  describe('gate por categoria', () => {
    it('NEW_DEVELOPMENT: NO encola aunque la nota cambie (fuera del scope Onnix)', async () => {
      storedAdminNotes = 'vieja';
      stubTicket({ category: 'NEW_DEVELOPMENT' });

      await service.updateTicket(TICKET, { adminNotes: 'nota nueva' }, USER);

      expect(outbox.enqueueTx).not.toHaveBeenCalled();
      expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
    });

    it('NEW_PROJECT: NO encola aunque la nota cambie', async () => {
      storedAdminNotes = null;
      stubTicket({ category: 'NEW_PROJECT' });

      await service.updateTicket(TICKET, { adminNotes: 'nota nueva' }, USER);

      expect(outbox.enqueueTx).not.toHaveBeenCalled();
    });
  });

  // ── R4.3 / D8: el aviso al dispatcher es POST-COMMIT ───────────────────────
  describe('drain-on-enqueue (R4.3)', () => {
    it('notifyEnqueued se llama DESPUES del commit, no dentro de la tx', async () => {
      storedAdminNotes = null;
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: 'nota nueva' }, USER);

      // Si el aviso saliera dentro de la tx y esta revirtiera, el dispatcher
      // drenaria una fila que no existe.
      expect(trace).toEqual(['enqueue', 'commit', 'notify']);
    });

    it('enqueueTx devolvio false (org fuera de la whitelist / flag off) → NO avisa', async () => {
      storedAdminNotes = null;
      stubTicket();
      outbox.enqueueTx.mockImplementation(async () => {
        trace.push('enqueue');
        return false;
      });

      await service.updateTicket(TICKET, { adminNotes: 'nota nueva' }, USER);

      expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
      expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
      expect(trace).toEqual(['enqueue', 'commit']);
    });
  });

  // ── No-regresion del camino de #13 (status) ────────────────────────────────
  describe('no-regresion: el PATCH de estado sigue igual', () => {
    it('PATCH solo de estado → encola STATUS_CHANGED y NINGUN COMMENT_ADDED', async () => {
      stubTicket({ status: 'OPEN' });

      await service.updateTicket(TICKET, { status: TicketStatusDto.IN_PROGRESS }, USER);

      expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
      expect(outbox.enqueueTx.mock.calls[0][1]).toMatchObject({
        eventType: 'STATUS_CHANGED',
        aggregateId: TICKET,
      });
      // Sin `adminNotes` en el DTO no hay lectura del previo ni comentario.
      expect(lastTx.ticket.findUnique).not.toHaveBeenCalled();
      expect(outbox.notifyEnqueued).toHaveBeenCalledTimes(1);
    });

    it('estado + nota en el MISMO PATCH → dos filas (STATUS_CHANGED + COMMENT_ADDED) y UN solo aviso', async () => {
      storedAdminNotes = 'vieja';
      stubTicket({ status: 'OPEN' });

      await service.updateTicket(
        TICKET,
        { status: TicketStatusDto.IN_PROGRESS, adminNotes: 'nota nueva' },
        USER,
      );

      expect(outbox.enqueueTx.mock.calls.map((c) => c[1].eventType)).toEqual([
        'STATUS_CHANGED',
        'COMMENT_ADDED',
      ]);
      // El debounce del dispatcher agrupa; el service avisa una vez por commit.
      expect(outbox.notifyEnqueued).toHaveBeenCalledTimes(1);
      expect(trace).toEqual(['enqueue', 'enqueue', 'commit', 'notify']);
    });
  });
});
