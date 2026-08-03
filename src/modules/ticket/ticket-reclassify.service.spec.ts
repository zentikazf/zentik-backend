import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, TicketCriticality } from '@prisma/client';
import { TicketService } from './ticket.service';
import { PrismaService } from '../../database/prisma.service';
import { TicketEventsService } from './ticket-events.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService } from '../sync/outbox.service';
import { TaskHoursGuardService } from '../task/task-hours-guard.service';
import { SlaResolverService } from '../sla/sla-resolver.service';
import { TicketCriticalityDto } from './dto/create-ticket.dto';

/**
 * Tipificación / reclasificación interna (feature #42 — Fase 2).
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca DATABASE_URL (prod).
 *
 * Invariante de negocio que este spec CUSTODIA: reclasificar **no recalcula ni
 * toca los deadlines** (`responseDeadline` / `resolutionDeadline`) ni el resultado
 * congelado de la cascada (`slaPolicyId` / `slaSource`). Si alguien agrega ese
 * recálculo "para que quede consistente", estos tests fallan — es una decisión de
 * negocio (paridad con OSD), no un detalle de implementación.
 */
describe('TicketService.reclassify (feature #42 — Fase 2)', () => {
  let service: TicketService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let events: DeepMockProxy<TicketEventsService>;
  let lastTx: DeepMockProxy<Prisma.TransactionClient>;

  const ORG = 'org-1';
  const TICKET = 'ticket-1';
  const USER = 'user-dev-1';
  const REASON = 'El cliente lo reportó como consulta pero es un error del sistema';

  /** Ticket actual: tipo "Consulta", criticidad MEDIA, sin categoría interna. */
  function stubCurrentTicket(over: Record<string, unknown> = {}) {
    prisma.ticket.findFirst.mockResolvedValue({
      id: TICKET,
      ticketTypeId: 'type-consulta',
      criticality: TicketCriticality.MEDIUM,
      categoryConfigId: null,
      ticketType: { name: 'Consulta' },
      categoryConfig: null,
      ...over,
    } as never);
  }

  /** `data` del update ejecutado dentro de la transacción. */
  function updateData(): Record<string, unknown> {
    return lastTx.ticket.update.mock.calls[0][0].data as Record<string, unknown>;
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    events = mockDeep<TicketEventsService>();

    service = new TicketService(
      prisma,
      eventEmitter,
      events,
      mockDeep<AppConfigService>(),
      mockDeep<OutboxService>(),
      mockDeep<TaskHoursGuardService>(),
      mockDeep<SlaResolverService>(),
    );

    stubCurrentTicket();
    prisma.ticketType.findFirst.mockResolvedValue({
      id: 'type-error',
      name: 'Error del sistema',
    } as never);
    prisma.ticketCategoryConfig.findFirst.mockResolvedValue({
      id: 'cfg-bug',
      name: 'Bug productivo',
    } as never);
    prisma.ticketCriticalityConfig.findMany.mockResolvedValue([
      { criticality: TicketCriticality.HIGH, displayName: 'Alta' },
      { criticality: TicketCriticality.MEDIUM, displayName: 'Media' },
    ] as never);

    prisma.$transaction.mockImplementation(async (cb: unknown) => {
      const tx = mockDeep<Prisma.TransactionClient>();
      tx.ticket.update.mockResolvedValue({ id: TICKET } as never);
      lastTx = tx;
      return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
    });
  });

  describe('motivo obligatorio', () => {
    it('rechaza un motivo vacío (solo espacios) sin tocar la DB', async () => {
      await expect(
        service.reclassify(ORG, TICKET, { ticketTypeId: 'type-error', reason: '   ' }, USER),
      ).rejects.toMatchObject({ code: 'RECLASSIFY_REASON_REQUIRED', statusCode: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('scoping multi-tenant', () => {
    it('un ticket de OTRA organización es 404 (nunca 403)', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null as never);

      await expect(
        service.reclassify(ORG, TICKET, { ticketTypeId: 'type-error', reason: REASON }, USER),
      ).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND', statusCode: 404 });
      expect(prisma.ticket.findFirst.mock.calls[0][0]).toMatchObject({
        where: { id: TICKET, organizationId: ORG },
      });
    });

    it('un tipo de solicitud de OTRA organización se rechaza', async () => {
      prisma.ticketType.findFirst.mockResolvedValue(null as never);

      await expect(
        service.reclassify(ORG, TICKET, { ticketTypeId: 'type-de-otra-org', reason: REASON }, USER),
      ).rejects.toMatchObject({ code: 'TICKET_TYPE_NOT_FOUND', statusCode: 404 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('una categoría interna de OTRA organización se rechaza', async () => {
      prisma.ticketCategoryConfig.findFirst.mockResolvedValue(null as never);

      await expect(
        service.reclassify(ORG, TICKET, { categoryConfigId: 'cfg-ajeno', reason: REASON }, USER),
      ).rejects.toMatchObject({ code: 'TICKET_CATEGORY_NOT_FOUND', statusCode: 404 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('los deadlines quedan CONGELADOS (decisión de diseño, igual que OSD)', () => {
    it('NO toca responseDeadline / resolutionDeadline / slaPolicyId / slaSource', async () => {
      await service.reclassify(
        ORG,
        TICKET,
        {
          ticketTypeId: 'type-error',
          criticality: TicketCriticalityDto.HIGH,
          categoryConfigId: 'cfg-bug',
          reason: REASON,
        },
        USER,
      );

      const data = updateData();
      expect(data).toEqual({
        ticketTypeId: 'type-error',
        criticality: TicketCriticality.HIGH,
        categoryConfigId: 'cfg-bug',
      });
      expect(data).not.toHaveProperty('responseDeadline');
      expect(data).not.toHaveProperty('resolutionDeadline');
      expect(data).not.toHaveProperty('slaPolicyId');
      expect(data).not.toHaveProperty('slaSource');
    });

    it('no invoca la cascada de SLA en ningún caso', async () => {
      await service.reclassify(ORG, TICKET, { ticketTypeId: 'type-error', reason: REASON }, USER);

      expect(prisma.projectTicketTypeSla.findFirst).not.toHaveBeenCalled();
      expect(prisma.slaPolicy.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('evento RECLASSIFIED en el timeline', () => {
    it('escribe el evento dentro de la MISMA transacción, con from/to legibles y el motivo', async () => {
      await service.reclassify(ORG, TICKET, { ticketTypeId: 'type-error', reason: REASON }, USER);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(events.writeEventTx).toHaveBeenCalledTimes(1);
      const [tx, input] = events.writeEventTx.mock.calls[0];
      expect(tx).toBe(lastTx); // el cliente de la transacción, no el prisma global
      expect(input).toMatchObject({
        ticketId: TICKET,
        type: 'RECLASSIFIED',
        fromValue: 'Tipo: Consulta',
        toValue: 'Tipo: Error del sistema',
        source: 'TICKET',
        userId: USER,
      });
      expect(input.metadata).toMatchObject({
        reason: REASON,
        changes: [
          { field: 'ticketTypeId', label: 'Tipo', from: 'Consulta', to: 'Error del sistema' },
        ],
      });
    });

    it('usa el displayName configurado por la org para la criticidad', async () => {
      await service.reclassify(
        ORG,
        TICKET,
        { criticality: TicketCriticalityDto.HIGH, reason: REASON },
        USER,
      );

      expect(events.writeEventTx.mock.calls[0][1]).toMatchObject({
        fromValue: 'Criticidad: Media',
        toValue: 'Criticidad: Alta',
      });
    });

    it('un ticket sin tipo previo registra el "desde" como vacío, no como null crudo', async () => {
      stubCurrentTicket({ ticketTypeId: null, ticketType: null });

      await service.reclassify(ORG, TICKET, { ticketTypeId: 'type-error', reason: REASON }, USER);

      expect(events.writeEventTx.mock.calls[0][1]).toMatchObject({
        fromValue: 'Tipo: —',
        toValue: 'Tipo: Error del sistema',
      });
    });

    it('emite ticket.reclassified con el motivo, los cambios y el usuario', async () => {
      await service.reclassify(ORG, TICKET, { ticketTypeId: 'type-error', reason: REASON }, USER);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'ticket.reclassified',
        expect.objectContaining({
          ticketId: TICKET,
          organizationId: ORG,
          reason: REASON,
          userId: USER,
        }),
      );
    });
  });

  describe('sin cambios reales', () => {
    it('mandar los MISMOS valores no escribe evento ni actualiza (timeline sin ruido)', async () => {
      prisma.ticketType.findFirst.mockResolvedValue({
        id: 'type-consulta',
        name: 'Consulta',
      } as never);
      prisma.ticket.findUnique.mockResolvedValue({ id: TICKET } as never);

      await service.reclassify(
        ORG,
        TICKET,
        { ticketTypeId: 'type-consulta', criticality: TicketCriticalityDto.MEDIUM, reason: REASON },
        USER,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(events.writeEventTx).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
