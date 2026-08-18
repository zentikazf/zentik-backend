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

/**
 * Feature #52 (T4) — el CAMBIO DE RESPONSABLE viaja a OSD como `ASSIGNEE_CHANGED`.
 *
 * Archivo propio, siguiendo la convencion del modulo (un archivo por tema:
 * `ticket-lifecycle`, `ticket-reclassify`, `ticket-admin-notes-outbox`).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod). Onnix no
 * participa: aca se verifica el PUNTO DE ENCOLADO, no el envio (eso es del
 * dispatcher, T5).
 *
 * Lo que estos tests defienden, en una linea: que el encolado reusa el flujo
 * `wantsAssignee`/`previousAssigneeId` que YA existe —no un camino paralelo— y que
 * solo encola cuando el responsable CAMBIO de verdad. Un encolado de mas es una
 * llamada a OSD por un cambio que no ocurrio; uno de menos es un ticket que en OSD
 * queda con el responsable equivocado para siempre.
 */
describe('TicketService — cambio de responsable al outbox Onnix (#52 R3)', () => {
  let service: TicketService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let events: DeepMockProxy<TicketEventsService>;
  let config: DeepMockProxy<AppConfigService> & { slaCascadeEnabled: boolean };
  let outbox: DeepMockProxy<OutboxService>;
  let hoursGuard: DeepMockProxy<TaskHoursGuardService>;
  let slaResolver: DeepMockProxy<SlaResolverService>;
  let classificationGuard: DeepMockProxy<TicketClassificationGuardService>;
  /** Traza de orden real de ejecucion — prueba el post-commit (#50 R4.3). */
  let trace: string[];

  const ORG = 'org-1';
  const TICKET = 'ticket-1';
  const TASK = 'task-1';
  const USER = 'user-staff-1';
  const ADA = 'user-ada';
  const JOSUE = 'user-josue';

  /**
   * Ticket del `findUnique` de arranque. `assignees` es el responsable ACTUAL: el
   * service lo lee como `ticket.task.assignments[0].userId` — la asignacion vive en
   * la task (`TaskAssignment`), no en el ticket.
   */
  function stubTicket(
    assignees: string[],
    extra: Record<string, unknown> = {},
  ): void {
    prisma.ticket.findUnique.mockResolvedValue({
      id: TICKET,
      status: 'IN_PROGRESS',
      organizationId: ORG,
      category: 'SUPPORT_REQUEST',
      adminNotes: null,
      firstResponseAt: null,
      resolvedAt: null,
      channelId: null,
      task: {
        id: TASK,
        status: 'IN_PROGRESS',
        projectId: 'p1',
        assignments: assignees.map((userId) => ({ userId })),
      },
      ...extra,
    } as never);
  }

  /** Filas ASSIGNEE_CHANGED encoladas (el flujo tambien puede encolar otros tipos). */
  function assignEnqueues() {
    return outbox.enqueueTx.mock.calls
      .map((c) => c[1])
      .filter((i) => i.eventType === 'ASSIGNEE_CHANGED');
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
    // #44: solo RESOLVED gatea (como el real). mockDeep devolveria un truthy y
    // activaria el candado de tipificacion sin querer.
    classificationGuard.isGatedStatus.mockImplementation((s?: string | null) => s === 'RESOLVED');
    classificationGuard.isClassified.mockResolvedValue(true);
    config.slaCascadeEnabled = false;

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
      // Un cambio de responsable solo NO toca campos escalares del ticket, asi que
      // `data` queda vacio y el service va por `findUniqueOrThrow`.
      tx.ticket.findUniqueOrThrow.mockResolvedValue({
        id: TICKET,
        project: { id: 'p1', name: 'P' },
        client: { id: 'c1', name: 'C' },
        task: { id: TASK, status: 'IN_PROGRESS', boardColumn: null },
      } as never);
      // Validacion "el asignado pertenece a la org": sin esto el service tira
      // ASSIGNEE_NOT_IN_ORG y ningun test de encolado llegaria a correr.
      tx.organizationMember.findFirst.mockResolvedValue({ id: 'member-1' } as never);
      // `syncTaskToStatus` corta apenas la task no aparece (`if (!task) return null`).
      tx.task.findUnique.mockResolvedValue(null as never);
      // Lectura de la nota previa con `FOR NO KEY UPDATE` (#51 R1/D1). Solo corre en
      // los PATCH que tocan `adminNotes`, pero el default de mockDeep es `undefined`
      // y el `[0]` del service explota. Este archivo no prueba notas: se devuelve la
      // forma correcta (array de filas) para que ese camino no interfiera.
      (tx.$queryRaw as unknown as jest.Mock).mockResolvedValue([{ admin_notes: null }]);
      const result = await (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
      trace.push('commit');
      return result;
    });
  });

  // ── R3.1: encola cuando el responsable CAMBIO ──────────────────────────────

  describe('el responsable cambio', () => {
    it('R3.1: asignar un ticket que estaba SIN responsable encola ASSIGNEE_CHANGED', async () => {
      stubTicket([]);

      await service.updateTicket(TICKET, { assigneeId: ADA }, USER);

      expect(assignEnqueues()).toHaveLength(1);
      expect(assignEnqueues()[0]).toMatchObject({
        eventType: 'ASSIGNEE_CHANGED',
        aggregateId: TICKET,
        organizationId: ORG,
        // ⚠️ R3.2: el asignado NO viaja en el payload — el dispatcher lo RELEE al
        // drenar (last-write-wins). Lo unico que viaja es el ACTOR, que es lo unico
        // que el drenado no puede reconstruir: el ticket no guarda quien reasigno.
        payload: { ticketId: TICKET, assignedByUserId: USER },
      });
      expect(assignEnqueues()[0].payload).not.toHaveProperty('assigneeId');
    });

    it('R3.1: REASIGNAR (ya tenia otro responsable) tambien encola — es la otra ruta de permisos', async () => {
      // R0.3: `tickets.assign` y `tickets.reassign` son permisos DISTINTOS en OSD.
      // Las dos rutas tienen que encolar igual; el QA manual las prueba por separado
      // porque el fallo de la segunda solo aparece en la reasignacion.
      stubTicket([JOSUE]);

      await service.updateTicket(TICKET, { assigneeId: ADA }, USER);

      expect(assignEnqueues()).toHaveLength(1);
      expect(assignEnqueues()[0].payload).toMatchObject({ assignedByUserId: USER });
    });

    it('R3.1: DESASIGNAR encola igual (el dispatcher decide que hacer, no el service)', async () => {
      // OSD no tiene desasignacion, pero esa es una limitacion del DESTINO: el
      // service encola el hecho de negocio y `processAssign` lo skipea con log. Si
      // el filtro viviera aca, el dia que OSD agregue desasignacion habria que
      // tocar dos capas en vez de una.
      stubTicket([JOSUE]);

      await service.updateTicket(TICKET, { assigneeId: null }, USER);

      expect(assignEnqueues()).toHaveLength(1);
    });

    it('#50 R4.3: el notify va DESPUES del commit, nunca dentro de la tx', async () => {
      stubTicket([]);

      await service.updateTicket(TICKET, { assigneeId: ADA }, USER);

      // Si el aviso saliera dentro de la tx y esta revirtiera, el dispatcher se
      // despertaria a drenar una fila que no existe.
      expect(trace).toEqual(['enqueue', 'commit', 'notify']);
    });
  });

  // ── R3.1: NO encola cuando no hubo cambio real ─────────────────────────────

  describe('no hubo cambio real', () => {
    it('R3.1: re-guardar el MISMO responsable NO encola (el "Guardar" repetido de la UI)', async () => {
      stubTicket([ADA]);

      await service.updateTicket(TICKET, { assigneeId: ADA }, USER);

      expect(assignEnqueues()).toHaveLength(0);
    });

    it('⚠️ R3.1: desasignar un ticket que YA estaba sin responsable NO encola', async () => {
      // El caso que rompe si se compara el `dto.assigneeId` crudo contra
      // `previousAssigneeId`: `dto.assigneeId` llega como `null` O como `''`, y
      // `'' !== null` da "cambio". Encolaria una fila que el dispatcher solo puede
      // skipear — trabajo muerto en la cola por un cambio que no ocurrio.
      stubTicket([]);

      await service.updateTicket(TICKET, { assigneeId: null }, USER);

      expect(assignEnqueues()).toHaveLength(0);
    });

    it('⚠️ R3.1: el string VACIO se trata como desasignar, no como un valor nuevo', async () => {
      // Misma normalizacion que usa el bloque de asignacion de la tx (`=== ''` es
      // una de las tres formas de desasignar). Sin ella, este caso encolaba.
      stubTicket([]);

      await service.updateTicket(TICKET, { assigneeId: '' }, USER);

      expect(assignEnqueues()).toHaveLength(0);
    });

    it('R3.1: un PATCH que NO toca el responsable no encola nada de asignacion', async () => {
      stubTicket([ADA]);

      await service.updateTicket(TICKET, { adminNotes: 'algo' }, USER);

      expect(assignEnqueues()).toHaveLength(0);
    });
  });

  // ── El caso multi-asignado (hallazgo de la revision adversarial) ───────────

  describe('task con VARIOS asignados', () => {
    it('⚠️ colapsar [U1,U2] a UNO de ellos SI encola, aunque `assignments[0]` no cambie', async () => {
      // El ticket es single-assignee pero su task es una task normal del kanban, que
      // acepta varios (PATCH /tasks con `assigneeIds`). El bloque de asignacion de
      // la tx hace `deleteMany` de TODOS y crea UNO: fijar ADA sobre [ADA, JOSUE]
      // deja a JOSUE sin el ticket. Comparando solo `assignments[0]` esto daba "no
      // cambio" y OSD se quedaba con el responsable viejo PARA SIEMPRE — el modo de
      // fallo mas caro, porque no deja ni un warn.
      stubTicket([ADA, JOSUE]);

      await service.updateTicket(TICKET, { assigneeId: ADA }, USER);

      expect(assignEnqueues()).toHaveLength(1);
    });

    it('⚠️ colapsar [U1,U2] a NINGUNO tambien encola', async () => {
      stubTicket([ADA, JOSUE]);

      await service.updateTicket(TICKET, { assigneeId: null }, USER);

      expect(assignEnqueues()).toHaveLength(1);
    });

    it('la lectura de assignments va con orderBy explicito (dos lecturas, el mismo responsable)', async () => {
      // Sin orden, Postgres devuelve el heap como quiera: `updateTicket` y el
      // dispatcher podian elegir responsables DISTINTOS para el mismo ticket.
      stubTicket([ADA]);

      await service.updateTicket(TICKET, { assigneeId: JOSUE }, USER);

      const include = prisma.ticket.findUnique.mock.calls[0][0].include as {
        task: { select: { assignments: { orderBy: unknown } } };
      };
      expect(include.task.select.assignments.orderBy).toEqual({ userId: 'asc' });
    });
  });

  describe('no hubo cambio real (continuacion)', () => {
    it('GUARD: un PATCH que NO toca el responsable no encola NI SIQUIERA con la task multi-asignada', async () => {
      // El `previousAssigneeCount > 1` es una rama del `assigneeChanged`, y ese
      // `wantsAssignee &&` de adelante es lo que impide que un PATCH de notas sobre
      // una task de dos asignados encole una asignacion que nadie pidio.
      stubTicket([ADA, JOSUE]);

      await service.updateTicket(TICKET, { adminNotes: 'algo' }, USER);

      expect(assignEnqueues()).toHaveLength(0);
    });
  });

  // ── Gates heredados del modulo ─────────────────────────────────────────────

  describe('gates', () => {
    it('ticket que NO es SUPPORT_REQUEST no encola: el scope de la integracion son los de soporte', async () => {
      // En linea con su TICKET_CREATED, que tampoco se encolo. Un ASSIGNEE_CHANGED
      // de un ticket que no existe en OSD solo puede quedar trabado en el gate de
      // orden hasta que el fondo de pozo de 24h lo declare terminal.
      stubTicket([], { category: 'INTERNAL' });

      await service.updateTicket(TICKET, { assigneeId: ADA }, USER);

      expect(assignEnqueues()).toHaveLength(0);
    });

    it('ticket SIN task no encola: sin task no hay assignments, asi que no cambio nada', async () => {
      stubTicket([], { task: null });

      await service.updateTicket(TICKET, { assigneeId: ADA }, USER);

      expect(assignEnqueues()).toHaveLength(0);
    });

    it('D8: si enqueueTx devuelve false (org fuera de la whitelist), NO se avisa al dispatcher', async () => {
      stubTicket([]);
      outbox.enqueueTx.mockResolvedValue(false);

      await service.updateTicket(TICKET, { assigneeId: ADA }, USER);

      expect(outbox.enqueueTx).toHaveBeenCalled();
      expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
    });
  });
});
