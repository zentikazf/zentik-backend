import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { TicketService } from './ticket.service';
import { PrismaService } from '../../database/prisma.service';
import { TicketEventsService } from './ticket-events.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService } from '../sync/outbox.service';
import {
  ListTicketsQueryDto,
  OvershootBucket,
} from './dto/list-tickets-query.dto';

/**
 * Tests del listing paginado offset + filtro de overshoot por columna generada
 * (feature #12).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod).
 *
 * Cobertura:
 *  - R2 (paginacion offset admin): meta { total, page, limit, totalPages,
 *    hasNextPage } correcta; skip/take/count derivados de page/limit.
 *  - R2/R10 (paridad overshoot): el where.overshootMinutes = { gte: X } produce
 *    EXACTAMENTE el mismo set que el viejo filterByOvershoot en memoria para
 *    X = 0, 60, 240, 1440, -30 y null. Como la columna ahora la calcula la DB,
 *    el test mockea los tickets con overshootMinutes precalculado y verifica que
 *    el where (capturado del call a Prisma) los filtra igual.
 *  - R2 (bucket → rango): overshootBucket del frontend se traduce a [gte, lt).
 *  - R2/R10 (export CSV): sigue SIN paginar (no usa skip/take/count) y aplica el
 *    mismo where.
 */
describe('TicketService — listing offset + overshoot (feature #12)', () => {
  let service: TicketService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let events: DeepMockProxy<TicketEventsService>;
  let config: DeepMockProxy<AppConfigService>;
  let outbox: DeepMockProxy<OutboxService>;

  const ORG_ID = 'org-test';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    events = mockDeep<TicketEventsService>();
    config = mockDeep<AppConfigService>();
    outbox = mockDeep<OutboxService>();
    service = new TicketService(prisma, eventEmitter, events, config, outbox);
  });

  /** Construye un DTO real (instancia) para que actuen los getters de overshoot. */
  function makeQuery(partial: Partial<ListTicketsQueryDto>): ListTicketsQueryDto {
    return Object.assign(new ListTicketsQueryDto(), partial);
  }

  // ── Fixtures de tickets con overshootMinutes precalculado (lo da la DB) ──
  // Cubre negativos (resuelto antes del deadline), cero, positivos y null.
  type OvershootRow = {
    id: string;
    resolvedAt: Date | null;
    resolutionDeadline: Date | null;
    overshootMinutes: number | null;
  };

  const MIN = 60000;
  function row(
    id: string,
    overshootMinutes: number | null,
  ): OvershootRow {
    // resolvedAt/resolutionDeadline coherentes con overshootMinutes para poder
    // correr el algoritmo viejo (filterByOvershoot) como oraculo de paridad.
    if (overshootMinutes === null) {
      return { id, resolvedAt: null, resolutionDeadline: null, overshootMinutes: null };
    }
    const deadline = new Date('2026-01-01T00:00:00.000Z');
    const resolved = new Date(deadline.getTime() + overshootMinutes * MIN);
    return { id, resolvedAt: resolved, resolutionDeadline: deadline, overshootMinutes };
  }

  const FIXTURE: OvershootRow[] = [
    row('neg30', -30),
    row('zero', 0),
    row('m30', 30),
    row('m60', 60),
    row('m239', 239),
    row('m240', 240),
    row('m1439', 1439),
    row('m1440', 1440),
    row('m5000', 5000),
    row('nullA', null),
    row('nullB', null),
  ];

  /**
   * Oraculo: replica EXACTAMENTE el viejo filterByOvershoot en memoria.
   * overshootMin = floor((resolvedAt - resolutionDeadline)/60000); null si falta
   * alguna fecha. Devuelve los tickets con overshoot >= threshold.
   */
  function legacyFilterByOvershoot(
    rows: OvershootRow[],
    overshootMinGte: number | undefined,
  ): OvershootRow[] {
    if (overshootMinGte === undefined || overshootMinGte === null) return rows;
    return rows.filter((t) => {
      if (!t.resolvedAt || !t.resolutionDeadline) return false;
      const diffMin = Math.floor(
        (t.resolvedAt.getTime() - t.resolutionDeadline.getTime()) / 60000,
      );
      return diffMin >= overshootMinGte;
    });
  }

  /**
   * Aplica un where.overshootMinutes (Prisma IntNullableFilter) sobre el fixture,
   * imitando lo que hace Postgres con la columna generada. Soporta { gte, lt }.
   */
  function applyOvershootWhere(
    rows: OvershootRow[],
    filter: Prisma.IntNullableFilter | undefined,
  ): OvershootRow[] {
    if (!filter) return rows;
    return rows.filter((t) => {
      if (t.overshootMinutes === null || t.overshootMinutes === undefined) return false;
      if (filter.gte != null && !(t.overshootMinutes >= (filter.gte as number))) return false;
      if (filter.lt != null && !(t.overshootMinutes < (filter.lt as number))) return false;
      return true;
    });
  }

  describe('paridad overshoot: where.overshootMinutes == filterByOvershoot viejo', () => {
    it.each([0, 60, 240, 1440, -30])(
      'X=%p devuelve el mismo set por columna generada que por memoria',
      async (threshold) => {
        // Capturamos el where que getOrgTickets pasa a Prisma con overshootMinGte=X.
        prisma.ticket.findMany.mockResolvedValue([] as never);
        prisma.ticket.count.mockResolvedValue(0 as never);

        // Inyectamos overshootMinGte/overshootMaxLt directamente (lo que producen
        // los getters del bucket): aca probamos un gte suelto sin cota superior.
        const query = makeQuery({}) as ListTicketsQueryDto & {
          overshootMinGte: number;
          overshootMaxLt: number | undefined;
        };
        Object.defineProperty(query, 'overshootMinGte', { value: threshold, configurable: true });
        Object.defineProperty(query, 'overshootMaxLt', { value: undefined, configurable: true });

        await service.getOrgTickets(ORG_ID, query);

        const whereArg = prisma.ticket.findMany.mock.calls[0][0]?.where as
          | Prisma.TicketWhereInput
          | undefined;
        const overshootFilter = whereArg?.overshootMinutes as
          | Prisma.IntNullableFilter
          | undefined;

        expect(overshootFilter).toEqual({ gte: threshold });

        const viaColumn = applyOvershootWhere(FIXTURE, overshootFilter)
          .map((r) => r.id)
          .sort();
        const viaMemory = legacyFilterByOvershoot(FIXTURE, threshold)
          .map((r) => r.id)
          .sort();

        expect(viaColumn).toEqual(viaMemory);
      },
    );

    it('null (sin filtro): NO agrega where.overshootMinutes y devuelve todo el set', async () => {
      prisma.ticket.findMany.mockResolvedValue([] as never);
      prisma.ticket.count.mockResolvedValue(0 as never);

      await service.getOrgTickets(ORG_ID, makeQuery({}));

      const whereArg = prisma.ticket.findMany.mock.calls[0][0]?.where as
        | Prisma.TicketWhereInput
        | undefined;
      expect(whereArg?.overshootMinutes).toBeUndefined();

      const viaColumn = applyOvershootWhere(FIXTURE, undefined)
        .map((r) => r.id)
        .sort();
      const viaMemory = legacyFilterByOvershoot(FIXTURE, undefined)
        .map((r) => r.id)
        .sort();
      expect(viaColumn).toEqual(viaMemory);
      expect(viaColumn).toHaveLength(FIXTURE.length);
    });
  });

  describe('overshootBucket → rango [gte, lt)', () => {
    it.each([
      [OvershootBucket.LT_1H, { gte: 0, lt: 60 }],
      [OvershootBucket.BETWEEN_1_4H, { gte: 60, lt: 240 }],
      [OvershootBucket.BETWEEN_4_24H, { gte: 240, lt: 1440 }],
      [OvershootBucket.GT_24H, { gte: 1440 }],
    ])('%s se traduce a where.overshootMinutes = %p', async (bucket, expected) => {
      prisma.ticket.findMany.mockResolvedValue([] as never);
      prisma.ticket.count.mockResolvedValue(0 as never);

      await service.getOrgTickets(ORG_ID, makeQuery({ overshootBucket: bucket as OvershootBucket }));

      const whereArg = prisma.ticket.findMany.mock.calls[0][0]?.where as Prisma.TicketWhereInput;
      expect(whereArg.overshootMinutes).toEqual(expected);
    });

    it('BETWEEN_1_4H filtra el fixture igual que aplicar [60,240) en memoria', async () => {
      prisma.ticket.findMany.mockResolvedValue([] as never);
      prisma.ticket.count.mockResolvedValue(0 as never);

      await service.getOrgTickets(
        ORG_ID,
        makeQuery({ overshootBucket: OvershootBucket.BETWEEN_1_4H }),
      );

      const filter = (prisma.ticket.findMany.mock.calls[0][0]?.where as Prisma.TicketWhereInput)
        .overshootMinutes as Prisma.IntNullableFilter;
      const ids = applyOvershootWhere(FIXTURE, filter).map((r) => r.id);
      // 60..239 inclusive del fixture: m60, m239. NO incluye m240 (cota superior).
      expect(ids).toEqual(['m60', 'm239']);
    });
  });

  describe('paginacion offset: meta { total, page, limit, totalPages, hasNextPage }', () => {
    it('page 2 / limit 10 sobre total 35 → skip 10, take 10, totalPages 4, hasNextPage true', async () => {
      const pageItems = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` }));
      prisma.ticket.findMany.mockResolvedValue(pageItems as never);
      prisma.ticket.count.mockResolvedValue(35 as never);

      const res = await service.getOrgTickets(ORG_ID, makeQuery({ page: 2, limit: 10 }));

      const findArgs = prisma.ticket.findMany.mock.calls[0][0];
      expect(findArgs?.skip).toBe(10);
      expect(findArgs?.take).toBe(10);
      expect(res.data).toHaveLength(10);
      expect(res.meta).toEqual({
        total: 35,
        page: 2,
        limit: 10,
        totalPages: 4,
        hasNextPage: true,
      });
    });

    it('ultima pagina → hasNextPage false', async () => {
      prisma.ticket.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }] as never);
      prisma.ticket.count.mockResolvedValue(35 as never);

      const res = await service.getOrgTickets(ORG_ID, makeQuery({ page: 4, limit: 10 }));

      expect(prisma.ticket.findMany.mock.calls[0][0]?.skip).toBe(30);
      expect(res.meta.hasNextPage).toBe(false);
      expect(res.meta.totalPages).toBe(4);
    });

    it('total 0 → totalPages 0, hasNextPage false (no rompe)', async () => {
      prisma.ticket.findMany.mockResolvedValue([] as never);
      prisma.ticket.count.mockResolvedValue(0 as never);

      const res = await service.getOrgTickets(ORG_ID, makeQuery({ page: 1, limit: 20 }));

      expect(res.meta).toEqual({
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
        hasNextPage: false,
      });
    });

    it('default page=1 / limit=20 cuando el DTO no los trae', async () => {
      prisma.ticket.findMany.mockResolvedValue([] as never);
      prisma.ticket.count.mockResolvedValue(5 as never);

      const res = await service.getOrgTickets(ORG_ID, makeQuery({}));

      expect(prisma.ticket.findMany.mock.calls[0][0]?.skip).toBe(0);
      expect(prisma.ticket.findMany.mock.calls[0][0]?.take).toBe(20);
      expect(res.meta.page).toBe(1);
      expect(res.meta.limit).toBe(20);
      expect(res.meta.totalPages).toBe(1);
    });
  });

  describe('export CSV: sin paginacion, mismo where', () => {
    it('NO usa skip/take ni count, y aplica el where con overshootMinutes', async () => {
      prisma.ticket.findMany.mockResolvedValue([] as never);

      await service.exportTicketsCsv(
        ORG_ID,
        makeQuery({ overshootBucket: OvershootBucket.GT_24H }),
      );

      // Una sola query (findMany), sin count.
      expect(prisma.ticket.count).not.toHaveBeenCalled();
      const findArgs = prisma.ticket.findMany.mock.calls[0][0];
      expect(findArgs?.skip).toBeUndefined();
      expect(findArgs?.take).toBeUndefined();
      expect((findArgs?.where as Prisma.TicketWhereInput).overshootMinutes).toEqual({ gte: 1440 });
    });

    it('genera CSV con header y BOM UTF-8 (presentacion intacta)', async () => {
      prisma.ticket.findMany.mockResolvedValue([
        {
          ticketNumber: 'TK-1',
          title: 'Demo',
          category: 'SUPPORT_REQUEST',
          criticality: 'HIGH',
          status: 'RESOLVED',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          firstResponseAt: null,
          resolvedAt: new Date('2026-01-02T00:00:00.000Z'),
          resolutionDeadline: new Date('2026-01-01T12:00:00.000Z'),
          responseDeadline: null,
          closeReason: null,
          client: { name: 'Cliente' },
          project: { name: 'Proyecto' },
        },
      ] as never);

      const buf = await service.exportTicketsCsv(ORG_ID, makeQuery({}));
      const text = buf.toString('utf8');
      expect(text.startsWith('﻿')).toBe(true);
      expect(text).toContain('ticketNumber,title,client');
      expect(text).toContain('TK-1');
      // resolutionOvershoot = floor((resolved - deadline)/60000) = 720 min (Math.max(0)).
      expect(text).toContain('720');
    });
  });
});
