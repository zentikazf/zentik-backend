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
import { CreateAdminTicketDto } from './dto/create-admin-ticket.dto';
import { TicketCategoryDto, TicketPriorityDto } from './dto/create-ticket.dto';

// Cast puntual documentado: los getters de AppConfigService son read-only; el mock
// los hace asignables en runtime pero TS sigue viendo el tipo real.
type WritableConfig = { -readonly [K in keyof AppConfigService]: AppConfigService[K] };

/**
 * Tests del gate por categoría del outbox Onnix (feature #13).
 *
 * Scope de la integración Onnix = SOLO tickets de soporte. El admin
 * (`createTicket` / createByAdmin) puede crear cualquier categoría, por eso el
 * call site gatea: solo `SUPPORT_REQUEST` se encola al outbox; `NEW_DEVELOPMENT`
 * y `NEW_PROJECT` NO llaman `enqueueTx`.
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod).
 * Onnix no participa: solo verificamos la llamada (o no-llamada) a
 * `OutboxService.enqueueTx` en el punto de creación admin.
 */
describe('TicketService — gate por categoría del outbox (feature #13)', () => {
  let service: TicketService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let events: DeepMockProxy<TicketEventsService>;
  let config: DeepMockProxy<AppConfigService> & WritableConfig;
  let outbox: DeepMockProxy<OutboxService>;
  let hoursGuard: DeepMockProxy<TaskHoursGuardService>;
  let slaResolver: DeepMockProxy<SlaResolverService>;
  let lastTx: DeepMockProxy<Prisma.TransactionClient>;

  const ORG_ID = 'org-test';
  const CLIENT_ID = 'client-1';
  const PROJECT_ID = 'project-1';
  const CREATED_BY = 'user-admin-1';
  const CREATED_TICKET_ID = 'ticket-created-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    events = mockDeep<TicketEventsService>();
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & WritableConfig;
    outbox = mockDeep<OutboxService>();
    hoursGuard = mockDeep<TaskHoursGuardService>();
    slaResolver = mockDeep<SlaResolverService>();

    // Feature #42: default del sistema = cascada APAGADA (mockDeep devolvería un
    // mock truthy si no lo fijamos, activando el path nuevo sin querer).
    config.slaCascadeEnabled = false;

    service = new TicketService(
      prisma,
      eventEmitter,
      events,
      config,
      outbox,
      hoursGuard,
      slaResolver,
    );

    // ── Stubs del camino feliz de createTicket (admin) ──────────────
    // Validaciones previas a la tx.
    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT_ID,
      name: 'Cliente Demo',
      userId: null,
    } as never);
    prisma.project.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      name: 'Proyecto Demo',
      organizationId: ORG_ID,
      createdById: CREATED_BY,
      responsibleId: null,
      members: [],
    } as never);
    // Sin PO/PM extra para los channel members.
    prisma.organizationMember.findMany.mockResolvedValue([] as never);

    // $transaction: ejecutamos el callback con un tx mockeado para recorrer el
    // cuerpo real (incluido el gate del enqueueTx).
    prisma.$transaction.mockImplementation(async (cb: unknown) => {
      const tx = mockDeep<Prisma.TransactionClient>();
      tx.task.aggregate.mockResolvedValue({ _max: { position: 0 } } as never);
      tx.boardColumn.findFirst.mockResolvedValue(null as never);
      tx.task.create.mockResolvedValue({ id: 'task-1' } as never);
      tx.channel.create.mockResolvedValue({ id: 'channel-1' } as never);
      // generateTicketNumber: count + findFirst (sin colisión → primer candidato).
      tx.ticket.count.mockResolvedValue(0 as never);
      tx.ticket.findFirst.mockResolvedValue(null as never);
      tx.ticket.create.mockResolvedValue({
        id: CREATED_TICKET_ID,
        project: { id: PROJECT_ID, name: 'Proyecto Demo' },
        client: { id: CLIENT_ID, name: 'Cliente Demo' },
        task: { id: 'task-1', title: 't', status: 'BACKLOG' },
        channel: { id: 'channel-1', name: 'c' },
        categoryConfig: null,
      } as never);
      lastTx = tx; // los tests inspeccionan los args del ticket.create
      return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
    });
  });

  function makeDto(category: TicketCategoryDto): CreateAdminTicketDto {
    return {
      title: 'Ticket de prueba',
      description: 'desc',
      category,
      priority: TicketPriorityDto.MEDIUM,
      clientId: CLIENT_ID,
      projectId: PROJECT_ID,
      // sin categoryConfigId → se salta el cálculo de SLA.
    };
  }

  it('SUPPORT_REQUEST: encola TICKET_CREATED en el outbox', async () => {
    await service.createTicket(ORG_ID, makeDto(TicketCategoryDto.SUPPORT_REQUEST), CREATED_BY);

    expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
    const [, input] = outbox.enqueueTx.mock.calls[0];
    expect(input).toMatchObject({
      eventType: 'TICKET_CREATED',
      aggregateId: CREATED_TICKET_ID,
      organizationId: ORG_ID,
    });
  });

  it('NEW_DEVELOPMENT: NO encola al outbox (fuera del scope Onnix)', async () => {
    await service.createTicket(ORG_ID, makeDto(TicketCategoryDto.NEW_DEVELOPMENT), CREATED_BY);

    expect(outbox.enqueueTx).not.toHaveBeenCalled();
  });

  it('NEW_PROJECT: NO encola al outbox (fuera del scope Onnix)', async () => {
    await service.createTicket(ORG_ID, makeDto(TicketCategoryDto.NEW_PROJECT), CREATED_BY);

    expect(outbox.enqueueTx).not.toHaveBeenCalled();
  });

  // ── Feature #42 (Fase 1): conmutación del motor de SLA ────────────────────
  describe('feature flag SLA_CASCADE_ENABLED', () => {
    it('flag OFF (default): NO invoca la cascada ni escribe columnas SLA v2 (paridad con hoy)', async () => {
      await service.createTicket(ORG_ID, makeDto(TicketCategoryDto.SUPPORT_REQUEST), CREATED_BY);

      expect(slaResolver.resolveAndCalculateDeadlines).not.toHaveBeenCalled();
      const data = lastTx.ticket.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).not.toHaveProperty('slaPolicyId');
      expect(data).not.toHaveProperty('slaSource');
      expect(data).not.toHaveProperty('ticketTypeId');
    });

    it('flag ON: resuelve por cascada y congela slaPolicyId + slaSource + ticketTypeId', async () => {
      config.slaCascadeEnabled = true;
      prisma.ticketType.findFirst.mockResolvedValue({ id: 'type-1' } as never);
      slaResolver.resolveAndCalculateDeadlines.mockResolvedValue({
        policy: { id: 'policy-1' },
        source: 'CONTRACT',
        responseDeadline: new Date('2026-08-03T14:00:00Z'),
        resolutionDeadline: new Date('2026-08-03T20:00:00Z'),
      } as never);

      await service.createTicket(
        ORG_ID,
        { ...makeDto(TicketCategoryDto.SUPPORT_REQUEST), ticketTypeId: 'type-1' },
        CREATED_BY,
      );

      expect(slaResolver.resolveAndCalculateDeadlines).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          clientId: CLIENT_ID,
          projectId: PROJECT_ID,
          ticketTypeId: 'type-1',
        }),
      );
      const data = lastTx.ticket.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).toMatchObject({
        slaPolicyId: 'policy-1',
        slaSource: 'CONTRACT',
        ticketTypeId: 'type-1',
        responseDeadline: new Date('2026-08-03T14:00:00Z'),
        resolutionDeadline: new Date('2026-08-03T20:00:00Z'),
      });
    });

    it('flag ON: un tipo de solicitud de OTRA organización se rechaza (scoping)', async () => {
      config.slaCascadeEnabled = true;
      prisma.ticketType.findFirst.mockResolvedValue(null as never);

      await expect(
        service.createTicket(
          ORG_ID,
          { ...makeDto(TicketCategoryDto.SUPPORT_REQUEST), ticketTypeId: 'type-de-otra-org' },
          CREATED_BY,
        ),
      ).rejects.toMatchObject({ code: 'TICKET_TYPE_NOT_FOUND', statusCode: 404 });
      expect(slaResolver.resolveAndCalculateDeadlines).not.toHaveBeenCalled();
    });
  });
});
