import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, TicketCriticality } from '@prisma/client';
import { PortalService } from '../portal.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { FileService } from '../../file/file.service';
import { StorageService } from '../../../infrastructure/storage/storage.service';
import { OutboxService } from '../../sync/outbox.service';
import { ClientBillingPdfService } from '../../client-billing/client-billing-pdf.service';
import { AppConfigService } from '../../../config/app.config';
import { SlaResolverService } from '../../sla/sla-resolver.service';
import { CriticalityConfigService } from '../../sla/criticality-config.service';
import { TicketTypeAvailabilityService } from '../../sla/ticket-type-availability.service';
import { CreateTicketDto, TicketCriticalityDto } from '../../ticket/dto/create-ticket.dto';

// Cast puntual documentado: los getters de AppConfigService son read-only; el mock
// los hace asignables en runtime pero TS sigue viendo el tipo real.
type WritableConfig = { -readonly [K in keyof AppConfigService]: AppConfigService[K] };

/**
 * Feature #42 — Fase 2: creación de ticket desde el portal con criticidad + tipo.
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca DATABASE_URL (prod).
 *
 * Foco del checklist de seguridad del blueprint: TODO lo que manda el cliente se
 * valida SERVER-SIDE (criticidad `clientVisible`, tipo disponible en el proyecto),
 * el contrato viejo `dynamic:<configId>` sigue funcionando, y sin criticidad entra
 * la default de la organización (modo 2B).
 */
describe('PortalService.createTicket (feature #42 — Fase 2)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let config: DeepMockProxy<AppConfigService> & WritableConfig;
  let slaResolver: DeepMockProxy<SlaResolverService>;
  let criticalityConfig: DeepMockProxy<CriticalityConfigService>;
  let availability: DeepMockProxy<TicketTypeAvailabilityService>;
  let service: PortalService;
  let lastTx: DeepMockProxy<Prisma.TransactionClient>;

  const USER = 'user-portal-1';
  const CLIENT = 'client-1';
  const ORG = 'org-1';
  const PROJECT = 'project-1';

  /** Datos con los que se creó el ticket dentro de la transacción. */
  function createdTicketData(): Record<string, unknown> {
    return lastTx.ticket.create.mock.calls[0][0].data as Record<string, unknown>;
  }

  function makeDto(over: Partial<CreateTicketDto> = {}): CreateTicketDto {
    return { title: 'No carga la factura', description: 'error 500', ...over } as CreateTicketDto;
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & WritableConfig;
    slaResolver = mockDeep<SlaResolverService>();
    criticalityConfig = mockDeep<CriticalityConfigService>();
    availability = mockDeep<TicketTypeAvailabilityService>();

    service = new PortalService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<AuditService>(),
      mockDeep<FileService>(),
      mockDeep<StorageService>(),
      mockDeep<OutboxService>(),
      mockDeep<ClientBillingPdfService>(),
      config,
      slaResolver,
      criticalityConfig,
      availability,
    );

    // Default del sistema: cascada APAGADA (mockDeep devolvería un mock truthy).
    config.slaCascadeEnabled = false;

    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      organizationId: ORG,
      name: 'Cliente Demo',
    } as never);
    prisma.project.findFirst.mockResolvedValue({
      id: PROJECT,
      name: 'Proyecto Demo',
      organizationId: ORG,
      createdById: 'user-admin',
      responsibleId: null,
      members: [],
    } as never);
    prisma.organizationMember.findMany.mockResolvedValue([] as never);
    // Sin SlaConfig el path viejo no calcula deadlines (no es lo que se testea acá).
    prisma.slaConfig.findUnique.mockResolvedValue(null as never);

    availability.isTypeAvailable.mockResolvedValue(true);
    criticalityConfig.getClientVisible.mockResolvedValue([]);
    criticalityConfig.getDefault.mockResolvedValue(TicketCriticality.MEDIUM);

    prisma.$transaction.mockImplementation(async (cb: unknown) => {
      const tx = mockDeep<Prisma.TransactionClient>();
      tx.task.aggregate.mockResolvedValue({ _max: { position: 0 } } as never);
      tx.boardColumn.findFirst.mockResolvedValue(null as never);
      tx.task.create.mockResolvedValue({ id: 'task-1' } as never);
      tx.channel.create.mockResolvedValue({ id: 'channel-1' } as never);
      // generateTicketNumber: count + findFirst (sin colisión → primer candidato).
      tx.ticket.count.mockResolvedValue(0 as never);
      tx.ticket.findFirst.mockResolvedValue(null as never);
      tx.ticket.create.mockResolvedValue({ id: 'ticket-1' } as never);
      lastTx = tx;
      return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
    });
  });

  describe('validación server-side (no confiar en el front)', () => {
    it('rechaza una criticidad que NO está marcada clientVisible', async () => {
      criticalityConfig.getClientVisible.mockResolvedValue([
        { criticality: TicketCriticality.MEDIUM, label: 'Media', level: 2 },
      ]);

      await expect(
        service.createTicket(USER, PROJECT, makeDto({ criticality: TicketCriticalityDto.HIGH })),
      ).rejects.toMatchObject({ code: 'CRITICALITY_NOT_CLIENT_VISIBLE', statusCode: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('acepta una criticidad que SÍ está visible y la persiste', async () => {
      criticalityConfig.getClientVisible.mockResolvedValue([
        { criticality: TicketCriticality.HIGH, label: 'Urgente', level: 3 },
      ]);

      await service.createTicket(USER, PROJECT, makeDto({ criticality: TicketCriticalityDto.HIGH }));

      expect(createdTicketData()).toMatchObject({ criticality: TicketCriticality.HIGH });
      expect(criticalityConfig.getDefault).not.toHaveBeenCalled();
    });

    it('rechaza un tipo de solicitud NO disponible en el proyecto', async () => {
      availability.isTypeAvailable.mockResolvedValue(false);

      await expect(
        service.createTicket(USER, PROJECT, makeDto({ ticketTypeId: 'type-de-otro-proyecto' })),
      ).rejects.toMatchObject({ code: 'TICKET_TYPE_NOT_AVAILABLE', statusCode: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('valida el tipo contra la ORG del proyecto, no contra lo que mande el cliente', async () => {
      await service.createTicket(USER, PROJECT, makeDto({ ticketTypeId: 'type-1' }));

      expect(availability.isTypeAvailable).toHaveBeenCalledWith(ORG, PROJECT, 'type-1');
      expect(createdTicketData()).toMatchObject({ ticketTypeId: 'type-1' });
    });
  });

  describe('criticidad por defecto (modo 2B: el cliente no elige)', () => {
    it('sin criticidad en el request entra la default de la organización', async () => {
      criticalityConfig.getDefault.mockResolvedValue(TicketCriticality.LOW);

      await service.createTicket(USER, PROJECT, makeDto({ ticketTypeId: 'type-1' }));

      expect(criticalityConfig.getDefault).toHaveBeenCalledWith(ORG);
      expect(createdTicketData()).toMatchObject({ criticality: TicketCriticality.LOW });
    });

    it('sin criticidad NO consulta las visibles (no hay nada que validar)', async () => {
      await service.createTicket(USER, PROJECT, makeDto());

      expect(criticalityConfig.getClientVisible).not.toHaveBeenCalled();
    });
  });

  describe('compatibilidad con el contrato viejo (dynamic:<configId>)', () => {
    it('sigue resolviendo la categoría dinámica: categoryConfigId + su criticidad', async () => {
      prisma.ticketCategoryConfig.findFirst.mockResolvedValue({
        id: 'cfg-1',
        criticality: TicketCriticality.HIGH,
      } as never);

      await service.createTicket(USER, PROJECT, makeDto({ category: 'dynamic:cfg-1' }));

      expect(prisma.ticketCategoryConfig.findFirst.mock.calls[0][0]).toMatchObject({
        where: { id: 'cfg-1', organizationId: ORG, isActive: true },
      });
      expect(createdTicketData()).toMatchObject({
        categoryConfigId: 'cfg-1',
        criticality: TicketCriticality.HIGH,
        category: 'SUPPORT_REQUEST',
      });
      // la criticidad la fija la categoría: no se pisa con la default
      expect(criticalityConfig.getDefault).not.toHaveBeenCalled();
    });

    it('el enum viejo SUPPORT_REQUEST sigue creando el ticket (sin tipo ni categoría)', async () => {
      await service.createTicket(USER, PROJECT, makeDto({ category: 'SUPPORT_REQUEST' }));

      const data = createdTicketData();
      expect(data).toMatchObject({ category: 'SUPPORT_REQUEST' });
      expect(data).not.toHaveProperty('ticketTypeId');
      expect(data).not.toHaveProperty('categoryConfigId');
    });

    it('el ticket del portal se encola SIEMPRE al outbox Onnix (gate intacto)', async () => {
      await service.createTicket(USER, PROJECT, makeDto({ ticketTypeId: 'type-1' }));

      expect(createdTicketData()).toMatchObject({ category: 'SUPPORT_REQUEST' });
    });
  });

  describe('declaración del cliente congelada (#42 Fase 2.1)', () => {
    it('graba reportedTicketTypeId + reportedCriticality con lo que mandó el cliente', async () => {
      criticalityConfig.getClientVisible.mockResolvedValue([
        { criticality: TicketCriticality.HIGH, label: 'Urgente', level: 3 },
      ]);

      await service.createTicket(
        USER,
        PROJECT,
        makeDto({ ticketTypeId: 'type-1', criticality: TicketCriticalityDto.HIGH }),
      );

      expect(createdTicketData()).toMatchObject({
        // lo que el equipo va a poder reclasificar…
        ticketTypeId: 'type-1',
        criticality: TicketCriticality.HIGH,
        // …y el espejo congelado de lo que declaró el cliente
        reportedTicketTypeId: 'type-1',
        reportedCriticality: TicketCriticality.HIGH,
      });
    });

    it('sin ticketTypeId no escribe reportedTicketTypeId (queda null en la fila)', async () => {
      await service.createTicket(USER, PROJECT, makeDto());

      const data = createdTicketData();
      expect(data).not.toHaveProperty('reportedTicketTypeId');
      expect(data).not.toHaveProperty('ticketTypeId');
    });

    it('sin criticidad congela la DEFAULT resuelta, no un null', async () => {
      criticalityConfig.getDefault.mockResolvedValue(TicketCriticality.LOW);

      await service.createTicket(USER, PROJECT, makeDto({ ticketTypeId: 'type-1' }));

      expect(createdTicketData()).toMatchObject({
        criticality: TicketCriticality.LOW,
        reportedCriticality: TicketCriticality.LOW,
      });
    });

    it('contrato viejo (dynamic:): congela la criticidad que traía la categoría', async () => {
      prisma.ticketCategoryConfig.findFirst.mockResolvedValue({
        id: 'cfg-1',
        criticality: TicketCriticality.HIGH,
      } as never);

      await service.createTicket(USER, PROJECT, makeDto({ category: 'dynamic:cfg-1' }));

      expect(createdTicketData()).toMatchObject({
        reportedCriticality: TicketCriticality.HIGH,
      });
    });

    it('el flag SLA_CASCADE_ENABLED no las gatea: son clasificación, no SLA', async () => {
      config.slaCascadeEnabled = false;

      await service.createTicket(USER, PROJECT, makeDto({ ticketTypeId: 'type-1' }));

      expect(createdTicketData()).toMatchObject({
        reportedTicketTypeId: 'type-1',
        reportedCriticality: TicketCriticality.MEDIUM,
      });
    });
  });

  describe('cascada de SLA', () => {
    it('flag OFF: NO invoca la cascada ni escribe slaPolicyId/slaSource (paridad con hoy)', async () => {
      await service.createTicket(USER, PROJECT, makeDto({ ticketTypeId: 'type-1' }));

      expect(slaResolver.resolveAndCalculateDeadlines).not.toHaveBeenCalled();
      const data = createdTicketData();
      expect(data).not.toHaveProperty('slaPolicyId');
      expect(data).not.toHaveProperty('slaSource');
      // el tipo es clasificación, no salida del motor: se persiste igual
      expect(data).toMatchObject({ ticketTypeId: 'type-1' });
    });

    /**
     * REGRESIÓN C1 (review #42). El form nuevo del portal manda `ticketTypeId` +
     * `criticality` y ya NO manda `category`, así que `categoryConfigId` queda
     * undefined. El path legacy estaba gateado por `categoryConfigId && criticality`
     * → con el flag APAGADO (el default, y el estado al que lleva el rollback) el
     * ticket no entraba ni a la cascada ni al path viejo y se guardaba SIN
     * deadlines, en silencio y de forma permanente (se congelan al crear).
     *
     * Este test es el que faltaba: el de arriba solo verificaba que NO se
     * escribieran los campos nuevos, nunca que SÍ siguieran existiendo los
     * deadlines. Por eso los 466 tests pasaban con el bug adentro.
     */
    it('flag OFF + payload NUEVO (sin `category`): igual calcula los deadlines por SlaConfig', async () => {
      slaResolver.findLegacySlaConfig.mockResolvedValue({
        responseTimeMinutes: 240,
        resolutionTimeMinutes: 1440,
      } as never);
      // El path legacy lee horario hábil + feriados para el motor de horas hábiles.
      prisma.businessHoursConfig.findUnique.mockResolvedValue({
        organizationId: ORG,
        businessHoursStart: '08:30',
        businessHoursEnd: '17:30',
        businessDays: '1,2,3,4,5',
        timezone: 'America/Asuncion',
      } as never);
      prisma.holiday.findMany.mockResolvedValue([] as never);

      await service.createTicket(USER, PROJECT, makeDto({ ticketTypeId: 'type-1' }));

      // Se consultó el SlaConfig por criticidad (el path viejo SÍ corrió)...
      expect(slaResolver.findLegacySlaConfig).toHaveBeenCalledWith(
        ORG,
        TicketCriticality.MEDIUM,
      );
      // ...y ambos deadlines quedaron persistidos.
      const data = createdTicketData();
      expect(data.responseDeadline).toBeInstanceOf(Date);
      expect(data.resolutionDeadline).toBeInstanceOf(Date);
    });

    it('flag ON: pasa el ticketTypeId al resolver (el paso 1 —contrato— aplica desde el portal)', async () => {
      config.slaCascadeEnabled = true;
      slaResolver.resolveAndCalculateDeadlines.mockResolvedValue({
        policy: { id: 'policy-1' },
        source: 'CONTRACT',
        responseDeadline: new Date('2026-08-03T14:00:00Z'),
        resolutionDeadline: new Date('2026-08-03T20:00:00Z'),
      } as never);

      await service.createTicket(USER, PROJECT, makeDto({ ticketTypeId: 'type-1' }));

      expect(slaResolver.resolveAndCalculateDeadlines).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          clientId: CLIENT,
          projectId: PROJECT,
          ticketTypeId: 'type-1',
          criticality: TicketCriticality.MEDIUM,
        }),
      );
      expect(createdTicketData()).toMatchObject({
        slaPolicyId: 'policy-1',
        slaSource: 'CONTRACT',
        ticketTypeId: 'type-1',
      });
    });
  });
});

/**
 * Feature #42 — Fase 2: endpoints de apoyo del form del portal.
 */
describe('PortalService — criticidades y tipos del portal (#42 Fase 2)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let criticalityConfig: DeepMockProxy<CriticalityConfigService>;
  let availability: DeepMockProxy<TicketTypeAvailabilityService>;
  let service: PortalService;

  const USER = 'user-portal-1';
  const CLIENT = 'client-1';
  const ORG = 'org-1';
  const PROJECT = 'project-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    criticalityConfig = mockDeep<CriticalityConfigService>();
    availability = mockDeep<TicketTypeAvailabilityService>();
    service = new PortalService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<AuditService>(),
      mockDeep<FileService>(),
      mockDeep<StorageService>(),
      mockDeep<OutboxService>(),
      mockDeep<ClientBillingPdfService>(),
      mockDeep<AppConfigService>(),
      mockDeep<SlaResolverService>(),
      criticalityConfig,
      availability,
    );
    prisma.client.findFirst.mockResolvedValue({ id: CLIENT, organizationId: ORG } as never);
  });

  it('getCriticalities scopea por la organización del cliente logueado', async () => {
    criticalityConfig.getClientVisible.mockResolvedValue([
      { criticality: TicketCriticality.HIGH, label: 'Urgente', level: 3 },
    ]);

    await expect(service.getCriticalities(USER)).resolves.toEqual([
      { criticality: TicketCriticality.HIGH, label: 'Urgente', level: 3 },
    ]);
    expect(criticalityConfig.getClientVisible).toHaveBeenCalledWith(ORG);
  });

  it('getCriticalities devuelve [] cuando ninguna es visible (el front no muestra el selector)', async () => {
    criticalityConfig.getClientVisible.mockResolvedValue([]);

    await expect(service.getCriticalities(USER)).resolves.toEqual([]);
  });

  it('getProjectTicketTypes exige que el proyecto sea DEL cliente logueado', async () => {
    prisma.project.findFirst.mockResolvedValue(null as never);

    await expect(service.getProjectTicketTypes(USER, 'project-de-otro')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
    expect(availability.getAvailableTypes).not.toHaveBeenCalled();
  });

  it('getProjectTicketTypes delega en la disponibilidad con la org del proyecto y la criticidad', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: PROJECT, organizationId: ORG } as never);
    availability.getAvailableTypes.mockResolvedValue({ types: [], fallback: true });

    await expect(service.getProjectTicketTypes(USER, PROJECT, 'HIGH')).resolves.toEqual({
      types: [],
      fallback: true,
    });
    expect(prisma.project.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: PROJECT, clientId: CLIENT },
    });
    // #48 T3: el portal pregunta SIEMPRE como CLIENTE — es la lectura que filtra
    // por `clientVisible`. Sin default en la firma, elegirlo es obligatorio acá.
    expect(availability.getAvailableTypes).toHaveBeenCalledWith(ORG, PROJECT, {
      criticality: TicketCriticality.HIGH,
      audience: 'CLIENT',
    });
  });

  it('getProjectTicketTypes rechaza una criticidad que no existe en el enum', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: PROJECT, organizationId: ORG } as never);

    await expect(service.getProjectTicketTypes(USER, PROJECT, 'URGENTISIMA')).rejects.toMatchObject({
      code: 'CRITICALITY_INVALID',
      statusCode: 400,
    });
  });

  describe('getTicketDetail — qué ve el cliente (#42 Fase 2.1)', () => {
    /**
     * `select` con el que el portal pide el detalle. Antes era `include` — y ese fue
     * exactamente el bug (fix 2026-08-05): `include` sin `select` de nivel superior
     * devuelve TODOS los escalares del ticket, `adminNotes` (notas internas del
     * staff) incluido, y el portal lo renderizaba como "Respuesta del equipo".
     */
    function detailSelect(): Record<string, unknown> {
      return prisma.ticket.findFirst.mock.calls[0][0]!.select as Record<string, unknown>;
    }

    beforeEach(() => {
      prisma.ticket.findFirst.mockResolvedValue({
        id: 'ticket-1',
        criticality: TicketCriticality.HIGH,
        reportedCriticality: TicketCriticality.HIGH,
        ticketType: { id: 'type-error', name: 'Error del sistema' },
        reportedTicketType: { id: 'type-consulta', name: 'Consulta' },
      } as never);
    });

    it('trae el tipo tipificado por el equipo y el que declaró el cliente', async () => {
      await expect(service.getTicketDetail(USER, 'ticket-1')).resolves.toMatchObject({
        ticketType: { id: 'type-error', name: 'Error del sistema' },
        reportedTicketType: { id: 'type-consulta', name: 'Consulta' },
        reportedCriticality: TicketCriticality.HIGH,
      });
      expect(detailSelect()).toMatchObject({
        ticketType: { select: { id: true, name: true } },
        reportedTicketType: { select: { id: true, name: true } },
      });
    });

    it('NO expone la categoría interna ni la política de SLA al cliente', async () => {
      await service.getTicketDetail(USER, 'ticket-1');

      const select = detailSelect();
      expect(select).not.toHaveProperty('categoryConfig');
      expect(select).not.toHaveProperty('slaPolicy');
    });

    /**
     * REGRESIÓN de la fuga de notas internas (fix 2026-08-05). El staff escribe
     * `adminNotes` bajo la promesa "no son visibles para el cliente"; el portal las
     * mostraba destacadas como "Respuesta del equipo". Si alguien vuelve a `include`
     * (que no admite recortar escalares) o agrega el campo al `select`, este test
     * revienta. Cubre el detalle Y el listado.
     */
    it('NO expone adminNotes ni closeNote/closeReason (campos internos del staff) ni en el detalle ni en el listado', async () => {
      // #43 R1b.3: `closeNote` es el comentario de cancelación (interno) — se suma
      // a la lista prohibida junto a `adminNotes`. El cliente ve el estado
      // «Cancelado» pero nunca el motivo interno de la cancelación / cierre.
      await service.getTicketDetail(USER, 'ticket-1');

      const detail = prisma.ticket.findFirst.mock.calls[0][0]!;
      expect(detail.include).toBeUndefined(); // include = todos los escalares → prohibido acá
      for (const campo of ['adminNotes', 'closeNote', 'closeReason', 'closedAt', 'closedByUserId']) {
        expect(detail.select).not.toHaveProperty(campo);
      }

      prisma.ticket.findMany.mockResolvedValue([] as never);
      await service.getTickets(USER);

      const list = prisma.ticket.findMany.mock.calls[0][0]!;
      expect(list.include).toBeUndefined();
      for (const campo of ['adminNotes', 'closeNote', 'closeReason', 'closedAt', 'closedByUserId']) {
        expect(list.select).not.toHaveProperty(campo);
      }
    });

    it('sigue scopeado al cliente logueado (un ticket ajeno es 404)', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null as never);

      await expect(service.getTicketDetail(USER, 'ticket-ajeno')).rejects.toMatchObject({
        code: 'TICKET_NOT_FOUND',
        statusCode: 404,
      });
      expect(prisma.ticket.findFirst.mock.calls[0][0]).toMatchObject({
        where: { id: 'ticket-ajeno', clientId: CLIENT },
      });
    });
  });
});
