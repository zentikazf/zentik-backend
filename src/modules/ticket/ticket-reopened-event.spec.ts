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
 * Feature #71 (B3) — LA REAPERTURA SE REGISTRA EN EL TIMELINE.
 *
 * Archivo propio, siguiendo la convencion del modulo (un archivo por tema:
 * `ticket-lifecycle`, `ticket-reclassify`, `ticket-assignee-outbox`).
 *
 * Que estaba roto: el frontend YA tenia el icono, la etiqueta "Reabierto" y el
 * formato para el evento REOPENED, y el tipo estaba en el enum — pero NINGUNA
 * linea del backend lo escribia. Una reapertura quedaba como un STATUS_CHANGE
 * generico ("cambio de estado"), indistinguible de cualquier otro cambio. El
 * chat SI avisaba (ticket-sync.listener.ts, TICKET_REOPENED_NOTICE): o sea que
 * se avisaba y no se registraba, y un mensaje de chat se borra o se pierde
 * entre 200 mensajes mientras el timeline ES el registro.
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod).
 *
 * Los dos caminos de reapertura, que son disjuntos y por eso NO se duplican:
 *  - DETALLE DEL TICKET -> `updateTicket` (escribe STATUS_CHANGE + REOPENED).
 *  - KANBAN             -> `syncTicketFromTaskMove`, disparado por
 *                          TicketSyncListener cuando el board emite `task.moved`
 *                          (escribe KANBAN_MOVE + REOPENED).
 */
describe('TicketService — el evento REOPENED del timeline (#71 B3)', () => {
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

  const ORG = 'org-1';
  const TICKET = 'ticket-1';
  const TASK = 'task-1';
  const USER = 'user-staff-1';

  /** Los eventos de timeline de un tipo, tal como se pidieron escribir. */
  function written(type: string) {
    return events.writeEventTx.mock.calls
      .map((c) => c[1])
      .filter((input) => input.type === type);
  }

  /** El `tx` con el que se escribio el primer evento de ese tipo. */
  function txOf(type: string) {
    return events.writeEventTx.mock.calls.find((c) => c[1].type === type)?.[0];
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
    // H6: idem para el gate de horas — solo IN_REVIEW/DONE gatean. Sin esto el
    // mock truthy frena la sincronizacion de la task y los tests del camino
    // detalle nunca recorrerian el sync completo.
    hoursGuard.isGatedStatus.mockImplementation(
      (s?: string | null) => s === 'IN_REVIEW' || s === 'DONE',
    );
    config.slaCascadeEnabled = false;

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

    prisma.$transaction.mockImplementation(async (cb: unknown) => {
      const tx = mockDeep<Prisma.TransactionClient>();
      const updated = {
        id: TICKET,
        project: { id: 'p1', name: 'P' },
        client: { id: 'c1', name: 'C' },
        task: null,
      };
      tx.ticket.update.mockResolvedValue(updated as never);
      tx.ticket.findUniqueOrThrow.mockResolvedValue(updated as never);
      // `syncTaskToStatus` (sync ticket->task): por defecto corta apenas la task
      // no aparece. Los tests que necesitan recorrerlo lo sobreescriben.
      tx.task.findUnique.mockResolvedValue(null as never);
      tx.boardColumn.findFirst.mockResolvedValue(null as never);
      tx.task.update.mockResolvedValue({ id: TASK, status: 'IN_PROGRESS' } as never);
      // Lectura de la nota previa con `FOR NO KEY UPDATE` (#51): solo corre en
      // los PATCH que tocan adminNotes, pero el default de mockDeep explota en
      // el `[0]` del service.
      (tx.$queryRaw as unknown as jest.Mock).mockResolvedValue([{ admin_notes: null }]);
      lastTx = tx;
      return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Camino 1: el DETALLE DEL TICKET (PATCH /tickets/:id)
  // ─────────────────────────────────────────────────────────────────────────
  describe('camino DETALLE DEL TICKET (updateTicket)', () => {
    function stubTicket(status: string, extra: Record<string, unknown> = {}) {
      prisma.ticket.findUnique.mockResolvedValue({
        id: TICKET,
        status,
        organizationId: ORG,
        category: 'SUPPORT_REQUEST',
        adminNotes: null,
        firstResponseAt: null,
        resolvedAt: null,
        channelId: null,
        task: null,
        ...extra,
      } as never);
    }

    it('RESOLVED -> IN_PROGRESS escribe REOPENED **y** STATUS_CHANGE (se suma, no reemplaza)', async () => {
      stubTicket('RESOLVED', { resolvedAt: new Date('2026-09-01T12:00:00Z') });

      await service.updateTicket(TICKET, { status: 'IN_PROGRESS' } as never, USER);

      // El STATUS_CHANGE SIGUE estando: hay consumidores que lo leen y el outbox
      // de Onnix encola STATUS_CHANGED desde el. Tocarlo es alcance de otro spec.
      expect(written('STATUS_CHANGE')).toHaveLength(1);

      const [reopened] = written('REOPENED');
      expect(reopened).toBeDefined();
      expect(reopened.ticketId).toBe(TICKET);
      expect(reopened.fromValue).toBe('RESOLVED');
      expect(reopened.toValue).toBe('IN_PROGRESS');
      expect(reopened.source).toBe('TICKET');
      expect(reopened.userId).toBe(USER);
    });

    it('CLOSED -> OPEN tambien es una reapertura (el otro estado cerrado)', async () => {
      stubTicket('CLOSED');

      await service.updateTicket(TICKET, { status: 'OPEN' } as never, USER);

      expect(written('REOPENED')).toHaveLength(1);
      expect(written('REOPENED')[0].fromValue).toBe('CLOSED');
      expect(written('REOPENED')[0].toValue).toBe('OPEN');
    });

    // El ASSERT DE PRESENCIA. Sin este test, un REOPENED que se escribiera
    // SIEMPRE pasaria igual de verde el test de arriba. Patron del flag apagado:
    // el camino que NO debe disparar se prueba explicitamente.
    it('OPEN -> IN_PROGRESS escribe SOLO STATUS_CHANGE: no es una reapertura', async () => {
      stubTicket('OPEN');

      await service.updateTicket(TICKET, { status: 'IN_PROGRESS' } as never, USER);

      expect(written('STATUS_CHANGE')).toHaveLength(1);
      expect(written('REOPENED')).toHaveLength(0);
    });

    it('IN_PROGRESS -> RESOLVED (resolver) tampoco escribe REOPENED', async () => {
      stubTicket('IN_PROGRESS');

      await service.updateTicket(TICKET, { status: 'RESOLVED' } as never, USER);

      expect(written('REOPENED')).toHaveLength(0);
    });

    // B3.5: el riesgo real de cubrir los dos caminos. `updateTicket` termina
    // sincronizando la task (`syncTaskToStatus`), que emite `task.moved` — el
    // mismo evento que escucha el listener del kanban. Si ese rebote entrara,
    // una sola reapertura escribiria DOS eventos. Por eso se CUENTA, no se
    // comprueba que exista alguno.
    it('una reapertura por el detalle escribe UN REOPENED, no dos (el sync ticket->task no rebota)', async () => {
      stubTicket('RESOLVED', {
        task: { id: TASK, status: 'DONE', projectId: 'p1', assignments: [] },
      });
      prisma.$transaction.mockImplementation(async (cb: unknown) => {
        const tx = mockDeep<Prisma.TransactionClient>();
        const updated = {
          id: TICKET,
          project: { id: 'p1', name: 'P' },
          client: { id: 'c1', name: 'C' },
          task: { id: TASK, status: 'DONE', boardColumn: null },
        };
        tx.ticket.update.mockResolvedValue(updated as never);
        tx.ticket.findUniqueOrThrow.mockResolvedValue(updated as never);
        // La task EXISTE: `syncTaskToStatus` se recorre entero (sale de DONE).
        tx.task.findUnique.mockResolvedValue({
          id: TASK,
          status: 'DONE',
          projectId: 'p1',
          boardColumnId: null,
          startDate: null,
          endDate: new Date('2026-09-01T12:00:00Z'),
          title: 'T',
          type: 'SUPPORT',
          estimatedHours: null,
          createdAt: new Date('2026-08-01T09:00:00Z'),
        } as never);
        tx.boardColumn.findFirst.mockResolvedValue(null as never);
        tx.task.update.mockResolvedValue({ id: TASK, status: 'IN_PROGRESS' } as never);
        (tx.$queryRaw as unknown as jest.Mock).mockResolvedValue([{ admin_notes: null }]);
        lastTx = tx;
        return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
      });

      await service.updateTicket(TICKET, { status: 'IN_PROGRESS' } as never, USER);

      // UNO. Ni cero ni dos.
      expect(written('REOPENED')).toHaveLength(1);

      // La razon por la que no hay dos: el `task.moved` de este camino sale
      // marcado, y `TicketSyncListener.handleTaskMoved` lo descarta por el loop
      // guard en vez de llamar a `syncTicketFromTaskMove`.
      const taskMoved = eventEmitter.emit.mock.calls.find((c) => c[0] === 'task.moved');
      expect(taskMoved).toBeDefined();
      expect((taskMoved![1] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
        fromTicketSync: true,
      });
    });

    it('el REOPENED va en el MISMO tx que el cambio de estado (nunca por el writeEvent global)', async () => {
      stubTicket('RESOLVED');

      await service.updateTicket(TICKET, { status: 'IN_PROGRESS' } as never, USER);

      // Misma transaccion que el STATUS_CHANGE y que el `ticket.update`.
      expect(txOf('REOPENED')).toBe(txOf('STATUS_CHANGE'));
      expect(txOf('REOPENED')).toBe(lastTx);
      // La variante NO transaccional escribe con el cliente global: si el evento
      // saliera por ahi, un rollback del cambio de estado dejaria el timeline
      // afirmando una reapertura que no paso.
      expect(events.writeEvent).not.toHaveBeenCalled();
    });

    it('si la transaccion falla, updateTicket rechaza y no queda ninguna escritura fuera de la tx', async () => {
      stubTicket('RESOLVED', {
        task: { id: TASK, status: 'DONE', projectId: 'p1', assignments: [] },
      });
      prisma.$transaction.mockImplementation(async (cb: unknown) => {
        const tx = mockDeep<Prisma.TransactionClient>();
        tx.ticket.update.mockResolvedValue({
          id: TICKET,
          project: { id: 'p1', name: 'P' },
          client: { id: 'c1', name: 'C' },
          task: { id: TASK, status: 'DONE', boardColumn: null },
        } as never);
        (tx.$queryRaw as unknown as jest.Mock).mockResolvedValue([{ admin_notes: null }]);
        // H8c: reabrir una task con horas ya facturadas explota DENTRO de la tx,
        // despues de que el evento se escribio. La tx entera revierte.
        tx.task.findUnique.mockResolvedValue({
          id: TASK,
          status: 'DONE',
          projectId: 'p1',
          boardColumnId: null,
          startDate: null,
          endDate: new Date('2026-09-01T12:00:00Z'),
          title: 'T',
          type: 'SUPPORT',
          estimatedHours: null,
          createdAt: new Date('2026-08-01T09:00:00Z'),
        } as never);
        lastTx = tx;
        return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
      });
      hoursGuard.assertNotBilled.mockRejectedValue(new Error('HOURS_ALREADY_BILLED'));

      await expect(
        service.updateTicket(TICKET, { status: 'IN_PROGRESS' } as never, USER),
      ).rejects.toThrow('HOURS_ALREADY_BILLED');

      // Con Prisma mockeado el rollback lo hace el motor, no el test. Lo que se
      // defiende aca es la condicion que lo hace posible: TODA la escritura del
      // evento fue con el `tx` que revierte, y ni una sola linea uso el cliente
      // global — si la hubiera, sobreviviria al rollback.
      expect(events.writeEvent).not.toHaveBeenCalled();
      expect(written('REOPENED')).toHaveLength(1);
      for (const call of events.writeEventTx.mock.calls) {
        expect(call[0]).toBe(lastTx);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Camino 2: el KANBAN (la tarjeta sale de DONE -> TicketSyncListener)
  // ─────────────────────────────────────────────────────────────────────────
  describe('camino KANBAN (syncTicketFromTaskMove)', () => {
    function stubTicket(status: string, extra: Record<string, unknown> = {}) {
      prisma.ticket.findFirst.mockResolvedValue({
        id: TICKET,
        status,
        organizationId: ORG,
        firstResponseAt: new Date('2026-09-01T09:00:00Z'),
        resolvedAt: null,
        channelId: 'chan-1',
        ...extra,
      } as never);
    }

    it('la tarjeta sale de DONE con el ticket RESOLVED -> REOPENED ademas del KANBAN_MOVE', async () => {
      stubTicket('RESOLVED', { resolvedAt: new Date('2026-09-01T12:00:00Z') });

      await service.syncTicketFromTaskMove(TASK, 'IN_PROGRESS', USER);

      // Este camino nunca escribio STATUS_CHANGE: su evento base es KANBAN_MOVE.
      expect(written('KANBAN_MOVE')).toHaveLength(1);

      const [reopened] = written('REOPENED');
      expect(reopened).toBeDefined();
      expect(reopened.fromValue).toBe('RESOLVED');
      expect(reopened.toValue).toBe('IN_PROGRESS');
      expect(reopened.source).toBe('KANBAN');
    });

    it('una reapertura desde el kanban escribe UN REOPENED, no dos', async () => {
      stubTicket('RESOLVED', { resolvedAt: new Date('2026-09-01T12:00:00Z') });

      await service.syncTicketFromTaskMove(TASK, 'IN_PROGRESS', USER);

      expect(written('REOPENED')).toHaveLength(1);
      // Y el ticket.updated sale marcado para que nadie rio abajo re-sincronice.
      const ticketUpdated = eventEmitter.emit.mock.calls.find((c) => c[0] === 'ticket.updated');
      expect((ticketUpdated![1] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
        fromKanbanSync: true,
      });
    });

    it('una tarjeta CLOSED que vuelve a TODO tambien reabre (CLOSED -> OPEN)', async () => {
      stubTicket('CLOSED');

      await service.syncTicketFromTaskMove(TASK, 'TODO', USER);

      expect(written('REOPENED')).toHaveLength(1);
      expect(written('REOPENED')[0].fromValue).toBe('CLOSED');
      expect(written('REOPENED')[0].toValue).toBe('OPEN');
    });

    // El assert de presencia del lado kanban: mover la tarjeta A DONE es el
    // movimiento inverso y no puede registrar una reapertura.
    it('la tarjeta que ENTRA a DONE (IN_PROGRESS -> RESOLVED) NO escribe REOPENED', async () => {
      stubTicket('IN_PROGRESS');

      await service.syncTicketFromTaskMove(TASK, 'DONE', USER);

      expect(written('KANBAN_MOVE')).toHaveLength(1);
      expect(written('REOPENED')).toHaveLength(0);
    });

    it('el REOPENED del kanban va en el MISMO tx que el KANBAN_MOVE', async () => {
      stubTicket('RESOLVED', { resolvedAt: new Date('2026-09-01T12:00:00Z') });

      await service.syncTicketFromTaskMove(TASK, 'IN_PROGRESS', USER);

      expect(txOf('REOPENED')).toBe(txOf('KANBAN_MOVE'));
      expect(txOf('REOPENED')).toBe(lastTx);
      expect(events.writeEvent).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // B3.5: el metadata contesta "por donde se reabrio"
  // ─────────────────────────────────────────────────────────────────────────
  describe('el metadata distingue el origen (B3.5)', () => {
    function stubDetail() {
      prisma.ticket.findUnique.mockResolvedValue({
        id: TICKET,
        status: 'RESOLVED',
        organizationId: ORG,
        category: 'SUPPORT_REQUEST',
        adminNotes: null,
        firstResponseAt: null,
        resolvedAt: new Date('2026-09-01T12:00:00Z'),
        channelId: null,
        task: null,
      } as never);
    }

    function stubKanban() {
      prisma.ticket.findFirst.mockResolvedValue({
        id: TICKET,
        status: 'RESOLVED',
        organizationId: ORG,
        firstResponseAt: new Date('2026-09-01T09:00:00Z'),
        resolvedAt: new Date('2026-09-01T12:00:00Z'),
        channelId: 'chan-1',
      } as never);
    }

    it('detalle del ticket -> origin "ticket_detail", con from y to', async () => {
      stubDetail();

      await service.updateTicket(TICKET, { status: 'IN_PROGRESS' } as never, USER);

      expect(written('REOPENED')[0].metadata).toMatchObject({
        from: 'RESOLVED',
        to: 'IN_PROGRESS',
        origin: 'ticket_detail',
      });
    });

    it('kanban -> origin "kanban", y ademas que tarjeta lo movio', async () => {
      stubKanban();

      await service.syncTicketFromTaskMove(TASK, 'IN_PROGRESS', USER);

      expect(written('REOPENED')[0].metadata).toMatchObject({
        from: 'RESOLVED',
        to: 'IN_PROGRESS',
        origin: 'kanban',
        taskId: TASK,
        newTaskStatus: 'IN_PROGRESS',
      });
    });

    // Sin esto, los dos caminos podrian converger en la misma etiqueta y el log
    // diria que se reabrio pero no por donde — justo la pregunta de quien audita.
    it('los dos origenes son distintos entre si', async () => {
      const origins = new Set<unknown>();

      stubDetail();
      await service.updateTicket(TICKET, { status: 'IN_PROGRESS' } as never, USER);
      origins.add(written('REOPENED')[0].metadata?.origin);

      events.writeEventTx.mockClear();
      stubKanban();
      await service.syncTicketFromTaskMove(TASK, 'IN_PROGRESS', USER);
      origins.add(written('REOPENED')[0].metadata?.origin);

      expect(origins.size).toBe(2);
    });
  });
});
