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
 * "guarda" y el `$queryRaw` siguiente "lee" lo guardado). Sin eso, el test del
 * corazon de R3.2 (dos ediciones = dos snapshots distintos) no probaria nada:
 * el previo siempre seria el mismo y ambas ediciones parecerian un cambio.
 *
 * #51 (R1/D1): la lectura del previo dejo de ser `tx.ticket.findUnique` y paso a
 * ser `tx.$queryRaw ... FOR NO KEY UPDATE`. El mock NO serializa las tx por
 * decreto: los cuerpos corren interleaved (como en la DB real bajo READ COMMITTED)
 * y lo unico que los serializa es el CANDADO DE FILA que simula `acquireRowLock`,
 * y ese candado SOLO se toma si el SQL que llega al `$queryRaw` realmente pide
 * lock — igual que Postgres, donde un SELECT plano no bloquea a nadie.
 *
 * Esa distincion es todo el valor del archivo: si el fix se revierte a
 * `tx.ticket.findUnique`, o si alguien "limpia" el candado de la query, el test de
 * los dos PATCH concurrentes se pone en rojo por la razon correcta (dos encolados
 * = comentario duplicado en OSD), no porque cambiamos un stub.
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
  /**
   * #51 (R1.4): cola del CANDADO DE FILA del ticket. Es la simulacion del
   * `FOR UPDATE` de Postgres: quien lo toma se queda con la fila hasta el commit,
   * y el que llega despues espera ahi (no lee un valor viejo, espera y lee el
   * nuevo). Lo toma unicamente el `$queryRaw` cuyo SQL dice `FOR UPDATE`; un
   * SELECT plano —o un `findUnique`, que es lo que habia antes del fix— pasa de
   * largo sin bloquear a nadie, tal cual READ COMMITTED.
   */
  let lockQueue: Promise<void>;

  /** Toma el candado de la fila; devuelve la funcion que lo suelta (el "commit"). */
  function acquireRowLock(): Promise<() => void> {
    const previousHolder = lockQueue;
    let release!: () => void;
    lockQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previousHolder.then(() => release);
  }

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
    lockQueue = Promise.resolve();

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
      /** Candado que tomo ESTA tx, si es que lo tomo. Se suelta al commitear. */
      let releaseRowLock: (() => void) | null = null;

      // R3.1 + #51 R1.1: la lectura del valor PREVIO va por el tx (serializada
      // con la escritura), no por `prisma`, y ahora por SQL crudo con `FOR UPDATE`.
      // Devuelve lo "persistido" hasta ahora, con el nombre de columna real
      // (`admin_notes`) porque el service lee la fila cruda, no el modelo Prisma.
      //
      // #51 (R1.4): el candado se toma ACA y solo si el SQL lo pide. Es la unica
      // fuente de serializacion del mock: si la query pierde el `FOR UPDATE`, dos
      // PATCH concurrentes vuelven a leer los dos el valor viejo — exactamente el
      // bug que el fix vino a cerrar, y el test de concurrencia se pone rojo.
      //
      // #51 (Fix 13): el modo real es `FOR NO KEY UPDATE` — misma exclusion mutua
      // entre escritores de la fila (que es todo lo que R1.4 necesita) sin
      // bloquear los chequeos de FK. El regex acepta los dos modos porque los dos
      // serializan a dos escritores; lo que NO acepta es un SELECT sin lock.
      (tx.$queryRaw as unknown as jest.Mock).mockImplementation(
        async (strings: TemplateStringsArray | string) => {
          const sql = typeof strings === 'string' ? strings : Array.from(strings).join(' ');
          if (/FOR\s+(?:NO\s+KEY\s+)?UPDATE/i.test(sql) && !releaseRowLock) {
            releaseRowLock = await acquireRowLock();
          }
          return [{ admin_notes: storedAdminNotes }];
        },
      );
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

      // Los cuerpos de las tx arrancan enseguida y corren interleaved: el mock NO
      // los ordena. El unico que puede ordenarlos es el candado de arriba, que es
      // justamente lo que se quiere probar. El `finally` suelta la fila al commit
      // (o al rollback: una tx que revienta tampoco puede dejar la fila tomada,
      // o el resto del test quedaria colgado esperando para siempre).
      lastTx = tx;
      try {
        const result = await (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
        trace.push('commit');
        return result;
      } finally {
        (releaseRowLock as (() => void) | null)?.();
      }
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
     *
     * #51 (R1.3): y se lee UNA sola vez, por `$queryRaw`. El `tx.ticket.findUnique`
     * no vuelve a aparecer: si alguien lo reintroduce "porque es mas prolijo" se
     * pierde el candado en silencio (un findUnique es un SELECT plano) y el bug de
     * concurrencia vuelve sin que nada mas se ponga rojo. Por eso la ausencia se
     * assertea explicitamente y no se deja implicita en el conteo del $queryRaw.
     */
    it('lee el previo por el tx con $queryRaw (nunca findUnique) y ANTES del update', async () => {
      storedAdminNotes = 'vieja';
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: 'nueva' }, USER);

      expect(lastTx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(lastTx.ticket.findUnique).not.toHaveBeenCalled();
      expect((lastTx.$queryRaw as unknown as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        lastTx.ticket.update.mock.invocationCallOrder[0],
      );
    });

    /**
     * #51 (R1.1): la forma del SQL es parte del contrato, no un detalle.
     *
     * Tres cosas se verifican juntas porque las tres se rompen igual de facil al
     * editar la query: que lleva candado (sin eso R1.4 vuelve a fallar en
     * produccion, no en el test), que el candado es el MINIMO que alcanza
     * (`FOR NO KEY UPDATE`, ver abajo) y que el `ticketId` viaja como BIND PARAM y
     * no interpolado en el string (regla dura del modulo: tagged template siempre,
     * jamas concatenacion — es la defensa anti-inyeccion).
     *
     * #51 (Fix 13): el modo se assertea EXACTO a proposito. `FOR UPDATE` tambien
     * haria pasar el test de concurrencia, pero es estrictamente mas fuerte:
     * conflictua con `FOR KEY SHARE`, o sea que bloquea a cualquier tx concurrente
     * que inserte una fila hija con FK a este ticket (hoy `ticket_events`) mientras
     * dure el PATCH. Esa contension extra no compra nada para el dedup, asi que si
     * alguien "sube" el modo pensando que es mas seguro, este test lo frena.
     */
    it('el previo se lee con SELECT ... FOR NO KEY UPDATE y el id va como bind param', async () => {
      storedAdminNotes = 'vieja';
      stubTicket();

      await service.updateTicket(TICKET, { adminNotes: 'nueva' }, USER);

      const [strings, ...values] = (lastTx.$queryRaw as unknown as jest.Mock).mock.calls[0];
      const sql = (strings as string[]).join(' ? ');
      expect(sql).toMatch(/SELECT\s+admin_notes\s+FROM\s+tickets/i);
      expect(sql).toMatch(/FOR\s+NO\s+KEY\s+UPDATE/i);
      // El id NO esta en el texto de la query: entro por el hueco del template.
      expect(sql).not.toContain(TICKET);
      expect(values).toEqual([TICKET]);
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

  /**
   * ── #51 R1.4: DOS PATCH CONCURRENTES, UN SOLO COMENTARIO ───────────────────
   *
   * El caso real es el doble click en "Guardar": dos requests con el MISMO texto
   * casi al mismo tiempo. Con el `findUnique` sin lock los dos leian el previo
   * viejo, los dos concluian "cambio" y la nota llegaba DUPLICADA a OSD (que no
   * tiene borrado de comentario, o sea que el duplicado queda a la vista del
   * cliente para siempre). Con `FOR UPDATE` la segunda tx espera, lee el valor ya
   * commiteado por la primera, compara y no encola.
   *
   * Estos tests NO corren en un orden que el mock les imponga: los dos PATCH
   * arrancan juntos y lo unico que los ordena es el candado que toma el propio
   * SQL del service (ver `acquireRowLock` arriba). Sacale el `FOR UPDATE` a la
   * query y este describe se cae solo.
   */
  describe('dos PATCH concurrentes (R1.4 — el candado)', () => {
    it('mismo texto disparado dos veces en paralelo → UN solo encolado', async () => {
      storedAdminNotes = 'nota vieja';
      stubTicket();

      await Promise.all([
        service.updateTicket(TICKET, { adminNotes: 'nota nueva' }, USER),
        service.updateTicket(TICKET, { adminNotes: 'nota nueva' }, USER),
      ]);

      // El segundo leyo 'nota nueva' (lo que dejo el primero) y se callo.
      expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
      expect(payloadOf(0).adminNoteSnapshot).toBe('nota nueva');
      expect(outbox.notifyEnqueued).toHaveBeenCalledTimes(1);
    });

    /**
     * El caso de arriba con la nota vacia de entrada: es el estado real del
     * ticket la primera vez que alguien escribe una nota interna, y es cuando el
     * doble click es mas probable (formulario vacio, el usuario no ve feedback).
     * Va aparte porque el previo `null` es el borde que hundio al atajo sin SQL
     * crudo (`updateMany({ where: { adminNotes: { not: x } } })`, descartado en el
     * design: en Postgres `<>` no matchea NULL). Si algun dia alguien vuelve a ese
     * atajo, este test es el que lo agarra.
     */
    it('primera nota (previo null) escrita dos veces en paralelo → UN solo encolado', async () => {
      storedAdminNotes = null;
      stubTicket();

      await Promise.all([
        service.updateTicket(TICKET, { adminNotes: 'primera nota' }, USER),
        service.updateTicket(TICKET, { adminNotes: 'primera nota' }, USER),
      ]);

      expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
      expect(payloadOf(0).adminNoteSnapshot).toBe('primera nota');
    });

    it('textos DISTINTOS en paralelo → dos encolados (el candado serializa, no descarta)', async () => {
      storedAdminNotes = null;
      stubTicket();

      await Promise.all([
        service.updateTicket(TICKET, { adminNotes: 'version 1' }, USER),
        service.updateTicket(TICKET, { adminNotes: 'version 2' }, USER),
      ]);

      // La contracara del test de arriba: el fix dedup-lica lo repetido, NO se
      // come ediciones reales. Si este pasara a 1, el candado estaria perdiendo
      // notas del equipo — mucho peor que el bug que vino a arreglar.
      expect(outbox.enqueueTx).toHaveBeenCalledTimes(2);
      expect([payloadOf(0).adminNoteSnapshot, payloadOf(1).adminNoteSnapshot].sort()).toEqual([
        'version 1',
        'version 2',
      ]);
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

    /**
     * #51 (Fix 12): el gate de categoria tiene que apagar tambien el CANDADO, no
     * solo el encolado. El unico consumidor del previo es la decision de encolar,
     * asi que en un ticket fuera del scope Onnix el `SELECT ... FOR NO KEY UPDATE`
     * era trabajo muerto que igual serializaba los PATCH de esa fila.
     *
     * Importa por una razon operativa concreta: con el flag de la integracion
     * apagado (o la org fuera de la whitelist) el comportamiento a nivel DB tiene
     * que ser IDENTICO al de antes de #51 — el kill-switch tiene que revertir de
     * verdad, y el lock es la primera palanca que se va a tirar si aparece
     * contencion. Si alguien saca el gate de la relectura, esto se pone rojo.
     */
    it('fuera del scope Onnix NO se toma el candado (el kill-switch revierte a nivel DB)', async () => {
      storedAdminNotes = 'vieja';
      stubTicket({ category: 'NEW_DEVELOPMENT' });

      await service.updateTicket(TICKET, { adminNotes: 'nota nueva' }, USER);

      expect(lastTx.$queryRaw).not.toHaveBeenCalled();
      // Y el gate es SOLO de sync: la nota se sigue guardando en Zentik igual.
      const data = (lastTx.ticket.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(data.adminNotes).toBe('nota nueva');
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
      // #51 (R1.2): y por lo tanto tampoco se toma el candado — un PATCH que no
      // toca la nota no paga ninguna contencion nueva.
      expect(lastTx.$queryRaw).not.toHaveBeenCalled();
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
