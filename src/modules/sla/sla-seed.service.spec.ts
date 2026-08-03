import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, TicketCriticality } from '@prisma/client';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { SlaSeedService } from './sla-seed.service';

/**
 * Tests de SlaSeedService (feature #42 — Fase 1).
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca una DB real.
 *
 * Foco: IDEMPOTENCIA (correr el import dos veces no duplica nada) + el guardarraíl
 * de la política "Estándar" + readiness del feature flag.
 */
describe('SlaSeedService', () => {
  let service: SlaSeedService;
  let prisma: DeepMockProxy<PrismaService>;
  let tx: DeepMockProxy<Prisma.TransactionClient>;
  let events: DeepMockProxy<EventEmitter2>;

  const ORG = 'org-1';
  const USER = 'user-1';

  const slaConfigs = [
    {
      id: 'sc-high',
      organizationId: ORG,
      criticality: TicketCriticality.HIGH,
      responseTimeMinutes: 60,
      resolutionTimeMinutes: 240,
    },
    {
      id: 'sc-medium',
      organizationId: ORG,
      criticality: TicketCriticality.MEDIUM,
      responseTimeMinutes: 240,
      resolutionTimeMinutes: 1440,
    },
  ];

  const categories = [
    { id: 'cat-1', name: 'Incidencia Crítica' },
    { id: 'cat-2', name: 'Consulta' },
  ];

  /**
   * Prepara la foto de la DB para una corrida.
   * @param existingPolicyNames nombres de políticas YA existentes en la org
   * @param existingTypeSlugs slugs de tipos YA existentes en la org
   * @param existingCriticalities criticidades con config YA existente (Fase 2)
   */
  function stubRun(
    existingPolicyNames: string[] = [],
    existingTypeSlugs: string[] = [],
    existingCriticalities: TicketCriticality[] = [],
  ) {
    prisma.slaConfig.findMany.mockResolvedValueOnce(slaConfigs as never);
    prisma.ticketCategoryConfig.findMany.mockResolvedValueOnce(categories as never);
    prisma.slaPolicy.findMany.mockResolvedValueOnce(
      existingPolicyNames.map((name) => ({ name })) as never,
    );
    prisma.ticketType.findMany.mockResolvedValueOnce(
      existingTypeSlugs.map((slug) => ({ slug })) as never,
    );
    prisma.ticketCriticalityConfig.findMany.mockResolvedValueOnce(
      existingCriticalities.map((criticality) => ({ criticality })) as never,
    );
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    tx = mockDeep<Prisma.TransactionClient>();
    events = mockDeep<EventEmitter2>();
    service = new SlaSeedService(prisma, events);
    prisma.$transaction.mockImplementation((cb: unknown) =>
      (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx),
    );
  });

  describe('importCurrentConfig — primera corrida', () => {
    it('crea una política por SlaConfig (horas redondeadas hacia arriba) y un tipo por categoría activa', async () => {
      stubRun();

      const result = await service.importCurrentConfig(ORG, USER);

      expect(result).toEqual({
        policiesCreated: 2,
        typesCreated: 2,
        criticalityConfigsCreated: 3,
        alreadyExisting: 0,
      });

      const policyData = tx.slaPolicy.createMany.mock.calls[0][0].data;
      expect(policyData).toEqual([
        {
          organizationId: ORG,
          name: 'Crítico',
          criticality: TicketCriticality.HIGH,
          firstResponseHours: 1,
          resolutionHours: 4,
        },
        {
          organizationId: ORG,
          name: 'Estándar',
          criticality: TicketCriticality.MEDIUM,
          firstResponseHours: 4,
          resolutionHours: 24,
        },
      ]);

      const typeData = tx.ticketType.createMany.mock.calls[0][0].data;
      expect(typeData).toEqual([
        { organizationId: ORG, name: 'Incidencia Crítica', slug: 'incidencia-critica' },
        { organizationId: ORG, name: 'Consulta', slug: 'consulta' },
      ]);
    });

    it('emite sla.config.imported dentro de la transacción', async () => {
      stubRun();

      await service.importCurrentConfig(ORG, USER);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        'sla.config.imported',
        expect.objectContaining({
          organizationId: ORG,
          policiesCreated: 2,
          typesCreated: 2,
          userId: USER,
        }),
      );
    });

    it('garantiza la política "Estándar" aunque la org no tenga SlaConfig de MEDIUM (default 4h/24h)', async () => {
      prisma.slaConfig.findMany.mockResolvedValueOnce([slaConfigs[0]] as never); // solo HIGH
      prisma.ticketCategoryConfig.findMany.mockResolvedValueOnce([] as never);
      prisma.slaPolicy.findMany.mockResolvedValueOnce([] as never);
      prisma.ticketType.findMany.mockResolvedValueOnce([] as never);
      prisma.ticketCriticalityConfig.findMany.mockResolvedValueOnce([] as never);

      const result = await service.importCurrentConfig(ORG, USER);

      expect(result.policiesCreated).toBe(2); // "Crítico" + la "Estándar" garantizada
      expect(tx.slaPolicy.createMany.mock.calls[0][0].data).toContainEqual({
        organizationId: ORG,
        name: 'Estándar',
        criticality: TicketCriticality.MEDIUM,
        firstResponseHours: 4,
        resolutionHours: 24,
      });
    });
  });

  describe('importCurrentConfig — idempotencia (correr 2 veces NO duplica)', () => {
    it('segunda corrida: 0 creadas, todo reportado como alreadyExisting', async () => {
      stubRun();
      const first = await service.importCurrentConfig(ORG, USER);
      expect(first).toEqual({
        policiesCreated: 2,
        typesCreated: 2,
        criticalityConfigsCreated: 3,
        alreadyExisting: 0,
      });

      // La DB ahora tiene lo que creó la primera corrida.
      stubRun(
        ['Crítico', 'Estándar'],
        ['incidencia-critica', 'consulta'],
        [TicketCriticality.HIGH, TicketCriticality.MEDIUM, TicketCriticality.LOW],
      );
      const second = await service.importCurrentConfig(ORG, USER);

      expect(second).toEqual({
        policiesCreated: 0,
        typesCreated: 0,
        criticalityConfigsCreated: 0,
        alreadyExisting: 7, // 2 políticas + 2 tipos + 3 criticidades
      });
      // Una sola transacción con createMany: la de la primera corrida.
      expect(tx.slaPolicy.createMany).toHaveBeenCalledTimes(1);
      expect(tx.ticketType.createMany).toHaveBeenCalledTimes(1);
      expect(tx.ticketCriticalityConfig.createMany).toHaveBeenCalledTimes(1);
    });

    it('siembra las 3 criticidades (Alta/Media/Baja) con MEDIUM como default y todas visibles', async () => {
      stubRun();

      await service.importCurrentConfig(ORG, USER);

      expect(tx.ticketCriticalityConfig.createMany.mock.calls[0][0].data).toEqual([
        {
          organizationId: ORG,
          criticality: TicketCriticality.HIGH,
          displayName: 'Alta',
          clientVisible: true,
          level: 3,
          isDefault: false,
        },
        {
          organizationId: ORG,
          criticality: TicketCriticality.MEDIUM,
          displayName: 'Media',
          clientVisible: true,
          level: 2,
          isDefault: true,
        },
        {
          organizationId: ORG,
          criticality: TicketCriticality.LOW,
          displayName: 'Baja',
          clientVisible: true,
          level: 1,
          isDefault: false,
        },
      ]);
    });

    it('con UNA sola criticidad ya configurada NO siembra ninguna (el admin ya opinó)', async () => {
      stubRun([], [], [TicketCriticality.HIGH]);

      const result = await service.importCurrentConfig(ORG, USER);

      expect(result.criticalityConfigsCreated).toBe(0);
      expect(tx.ticketCriticalityConfig.createMany).not.toHaveBeenCalled();
    });

    it('NO borra ni modifica nada existente (solo createMany, nunca update/delete)', async () => {
      stubRun(['Crítico'], []);

      await service.importCurrentConfig(ORG, USER);

      expect(tx.slaPolicy.update).not.toHaveBeenCalled();
      expect(tx.slaPolicy.delete).not.toHaveBeenCalled();
      expect(tx.slaPolicy.deleteMany).not.toHaveBeenCalled();
      expect(tx.ticketType.update).not.toHaveBeenCalled();
      expect(tx.ticketType.deleteMany).not.toHaveBeenCalled();
    });

    it('reconoce "Estandar" sin tilde como la política de fallback ya existente', async () => {
      stubRun(['Estandar'], []);

      const result = await service.importCurrentConfig(ORG, USER);

      const names = (
        tx.slaPolicy.createMany.mock.calls[0][0].data as { name: string }[]
      ).map((p) => p.name);
      // Crea la de HIGH; NO agrega una segunda "Estándar" con tilde.
      expect(names).toEqual(['Crítico']);
      expect(result.policiesCreated).toBe(1);
    });
  });

  describe('getReadiness — guardarraíl del feature flag', () => {
    it('canEnable = true cuando existe una política "Estándar" activa', async () => {
      prisma.slaPolicy.count.mockResolvedValueOnce(3 as never);
      prisma.ticketType.count.mockResolvedValueOnce(2 as never);
      prisma.slaPolicy.findFirst.mockResolvedValueOnce({ id: 'p-std' } as never);

      await expect(service.getReadiness(ORG)).resolves.toEqual({
        hasStandardPolicy: true,
        policiesCount: 3,
        typesCount: 2,
        canEnable: true,
      });
    });

    it('canEnable = false sin política "Estándar" (activar el flag dejaría tickets sin SLA)', async () => {
      prisma.slaPolicy.count.mockResolvedValueOnce(1 as never);
      prisma.ticketType.count.mockResolvedValueOnce(0 as never);
      prisma.slaPolicy.findFirst.mockResolvedValueOnce(null as never);

      await expect(service.getReadiness(ORG)).resolves.toEqual({
        hasStandardPolicy: false,
        policiesCount: 1,
        typesCount: 0,
        canEnable: false,
      });
    });
  });
});
