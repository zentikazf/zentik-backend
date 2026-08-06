import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SlaCronService } from './sla-cron.service';
import { PrismaService } from '../../database/prisma.service';
import { TicketEventsService } from './ticket-events.service';

/**
 * Feature #43 R2.2 + R1b.6 — congela la semántica del cron respecto a los
 * estados que este feature cambia:
 *  - un ticket con `resolvedAt` seteado (rechazo RESOLVED→IN_PROGRESS conserva el
 *    valor) NUNCA entra a la query de breach de resolución → el reloj no revive;
 *  - `CLOSED` (cancelado) no aparece en NINGÚN filtro del cron.
 *
 * Si alguien "arregla" el cron sacando `resolvedAt: null` o metiendo CLOSED,
 * estos tests revientan.
 */
describe('SlaCronService — filtros de estado (#43 R2.2 / R1b.6)', () => {
  let service: SlaCronService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let events: DeepMockProxy<TicketEventsService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    events = mockDeep<TicketEventsService>();
    prisma.ticket.findMany.mockResolvedValue([] as never);
    service = new SlaCronService(prisma, eventEmitter, events);
  });

  it('la query de breach de resolución filtra resolvedAt:null y NO incluye CLOSED', async () => {
    await service.checkSlaBreaches();

    const wheres = prisma.ticket.findMany.mock.calls.map((c) => c[0].where as Record<string, any>);
    const resolutionQuery = wheres.find((w) => 'resolutionDeadline' in w && 'resolvedAt' in w);
    expect(resolutionQuery).toBeDefined();
    // El rechazo conserva resolvedAt → con resolvedAt no-null queda fuera de esta query.
    expect(resolutionQuery!.resolvedAt).toBeNull();
    // Un cancelado (CLOSED) nunca se marca como breach.
    expect(resolutionQuery!.status.in).not.toContain('CLOSED');
  });

  it('NINGUNA query del cron incluye CLOSED en su filtro de estado', async () => {
    await service.checkSlaBreaches();

    for (const call of prisma.ticket.findMany.mock.calls) {
      const where = call[0].where as Record<string, any>;
      const statusFilter = where.status;
      const values = statusFilter?.in ?? (statusFilter ? [statusFilter] : []);
      expect(values).not.toContain('CLOSED');
    }
  });
});
