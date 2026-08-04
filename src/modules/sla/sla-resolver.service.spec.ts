import { EventEmitter2 } from '@nestjs/event-emitter';
import { SlaPolicy, SlaSource, TicketCriticality } from '@prisma/client';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { SlaResolverService } from './sla-resolver.service';
import { STANDARD_POLICY_NAMES } from './types/sla-resolution.types';

// El motor de horas hábiles (`sla.util`) tiene su propio spec (feature #17) y NO se
// re-testea acá: se mockea para que este spec verifique lo ÚNICO que aporta el
// resolver sobre el cálculo — la conversión horas → minutos y qué config le pasa.
jest.mock('./sla.util', () => ({
  calculateBusinessDeadline: jest.fn(
    (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000),
  ),
  parseBusinessDays: jest.fn(() => [1, 2, 3, 4, 5]),
}));
import { calculateBusinessDeadline } from './sla.util';

/**
 * Tests de SlaResolverService (feature #42 — Fase 1).
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca una DB real.
 *
 * Cubre los 6 caminos de la cascada (§2.4 del blueprint) + el scoping por
 * organización en TODOS los pasos.
 */
describe('SlaResolverService', () => {
  let service: SlaResolverService;
  let prisma: DeepMockProxy<PrismaService>;
  let events: DeepMockProxy<EventEmitter2>;

  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const CLIENT = 'client-1';
  const PROJECT = 'project-1';
  const TYPE = 'type-1';

  function makePolicy(over: Partial<SlaPolicy> = {}): SlaPolicy {
    return {
      id: 'policy-1',
      organizationId: ORG,
      name: 'Crítico 24/7',
      criticality: TicketCriticality.HIGH,
      firstResponseHours: 1,
      resolutionHours: 4,
      pausesOnWaiting: false,
      isActive: true,
      createdAt: new Date('2026-07-31T00:00:00Z'),
      updatedAt: new Date('2026-07-31T00:00:00Z'),
      ...over,
    };
  }

  /** Deja todos los pasos "sin respuesta"; cada test sobreescribe el suyo. */
  function stubEmptyCascade() {
    prisma.projectTicketTypeSla.findFirst.mockResolvedValue(null as never);
    prisma.project.findFirst.mockResolvedValue(null as never);
    prisma.client.findFirst.mockResolvedValue(null as never);
    prisma.slaPolicy.findFirst.mockResolvedValue(null as never);
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    events = mockDeep<EventEmitter2>();
    service = new SlaResolverService(prisma, events);
    stubEmptyCascade();
  });

  // ── Paso 1 — CONTRACT ────────────────────────────────────────────────────
  describe('paso 1: contrato (proyecto + tipo) → CONTRACT', () => {
    it('devuelve la política del contrato activo y NO consulta los pasos siguientes', async () => {
      const policy = makePolicy({ id: 'policy-contract' });
      prisma.projectTicketTypeSla.findFirst.mockResolvedValueOnce({ slaPolicy: policy } as never);

      const result = await service.resolve({
        organizationId: ORG,
        clientId: CLIENT,
        projectId: PROJECT,
        ticketTypeId: TYPE,
        criticality: TicketCriticality.HIGH,
      });

      expect(result).toEqual({ policy, source: SlaSource.CONTRACT });
      expect(prisma.project.findFirst).not.toHaveBeenCalled();
      expect(prisma.client.findFirst).not.toHaveBeenCalled();
      expect(prisma.slaPolicy.findFirst).not.toHaveBeenCalled();
    });

    it('el paso se saltea si no hay tipo de solicitud (portal en Fase 1)', async () => {
      await service.resolve({ organizationId: ORG, clientId: CLIENT, projectId: PROJECT });
      expect(prisma.projectTicketTypeSla.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Paso 2 — PROJECT ─────────────────────────────────────────────────────
  describe('paso 2: SLA propio del proyecto → PROJECT', () => {
    it('sin contrato, aplica la política del proyecto', async () => {
      const policy = makePolicy({ id: 'policy-project' });
      prisma.project.findFirst.mockResolvedValueOnce({ slaPolicy: policy } as never);

      const result = await service.resolve({
        organizationId: ORG,
        clientId: CLIENT,
        projectId: PROJECT,
        ticketTypeId: TYPE,
      });

      expect(result).toEqual({ policy, source: SlaSource.PROJECT });
      expect(prisma.client.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Paso 3 — CLIENT ──────────────────────────────────────────────────────
  describe('paso 3: SLA default del cliente → CLIENT', () => {
    it('sin contrato ni SLA de proyecto, aplica el default del cliente', async () => {
      const policy = makePolicy({ id: 'policy-client' });
      prisma.client.findFirst.mockResolvedValueOnce({ defaultSlaPolicy: policy } as never);

      const result = await service.resolve({
        organizationId: ORG,
        clientId: CLIENT,
        projectId: PROJECT,
        ticketTypeId: TYPE,
      });

      expect(result).toEqual({ policy, source: SlaSource.CLIENT });
      expect(prisma.slaPolicy.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Paso 4 — CRITICALITY (red de seguridad 3A) ───────────────────────────
  describe('paso 4: política de la criticidad → CRITICALITY', () => {
    it('sin ningún lazo, cae a la política de la criticidad del ticket', async () => {
      const policy = makePolicy({ id: 'policy-crit', criticality: TicketCriticality.MEDIUM });
      prisma.slaPolicy.findFirst.mockResolvedValueOnce(policy as never);

      const result = await service.resolve({
        organizationId: ORG,
        clientId: CLIENT,
        projectId: PROJECT,
        ticketTypeId: TYPE,
        criticality: TicketCriticality.MEDIUM,
      });

      expect(result).toEqual({ policy, source: SlaSource.CRITICALITY });
      expect(prisma.slaPolicy.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.slaPolicy.findFirst.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        criticality: TicketCriticality.MEDIUM,
        isActive: true,
      });
    });

    it('el paso se saltea si el ticket no tiene criticidad', async () => {
      await service.resolve({ organizationId: ORG, clientId: CLIENT, projectId: PROJECT });
      // Única llamada = paso 5 ("Estándar"), no la de criticidad.
      expect(prisma.slaPolicy.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.slaPolicy.findFirst.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        isActive: true,
        name: { in: STANDARD_POLICY_NAMES },
      });
    });
  });

  // ── Paso 5 — STANDARD ────────────────────────────────────────────────────
  describe('paso 5: política "Estándar" → STANDARD', () => {
    it('sin política para la criticidad, cae al fallback global "Estándar"', async () => {
      const standard = makePolicy({ id: 'policy-standard', name: 'Estándar' });
      prisma.slaPolicy.findFirst
        .mockResolvedValueOnce(null as never) // paso 4: no hay política de esa criticidad
        .mockResolvedValueOnce(standard as never); // paso 5

      const result = await service.resolve({
        organizationId: ORG,
        clientId: CLIENT,
        projectId: PROJECT,
        ticketTypeId: TYPE,
        criticality: TicketCriticality.LOW,
      });

      expect(result).toEqual({ policy: standard, source: SlaSource.STANDARD });
      expect(prisma.slaPolicy.findFirst).toHaveBeenCalledTimes(2);
    });

    it('acepta "Estandar" sin tilde (lo tipea un humano en la UI)', () => {
      expect(STANDARD_POLICY_NAMES).toEqual(expect.arrayContaining(['Estándar', 'Estandar']));
    });
  });

  // ── Sin resolución — NONE ────────────────────────────────────────────────
  describe('sin resolución → NONE', () => {
    it('devuelve policy null y source NONE cuando la org no tiene nada configurado', async () => {
      const result = await service.resolve({
        organizationId: ORG,
        clientId: CLIENT,
        projectId: PROJECT,
        ticketTypeId: TYPE,
        criticality: TicketCriticality.HIGH,
      });

      expect(result).toEqual({ policy: null, source: SlaSource.NONE });
    });
  });

  // ── Scoping multi-tenant ─────────────────────────────────────────────────
  describe('scoping por organización', () => {
    it('TODOS los pasos filtran por la organizationId del ticket + isActive', async () => {
      await service.resolve({
        organizationId: OTHER_ORG,
        clientId: CLIENT,
        projectId: PROJECT,
        ticketTypeId: TYPE,
        criticality: TicketCriticality.HIGH,
      });

      expect(prisma.projectTicketTypeSla.findFirst.mock.calls[0][0].where).toEqual({
        projectId: PROJECT,
        ticketTypeId: TYPE,
        isActive: true,
        project: { organizationId: OTHER_ORG },
        slaPolicy: { organizationId: OTHER_ORG, isActive: true },
      });
      expect(prisma.project.findFirst.mock.calls[0][0].where).toEqual({
        id: PROJECT,
        organizationId: OTHER_ORG,
        slaPolicy: { organizationId: OTHER_ORG, isActive: true },
      });
      expect(prisma.client.findFirst.mock.calls[0][0].where).toEqual({
        id: CLIENT,
        organizationId: OTHER_ORG,
        defaultSlaPolicy: { organizationId: OTHER_ORG, isActive: true },
      });
      for (const call of prisma.slaPolicy.findFirst.mock.calls) {
        expect(call[0].where).toMatchObject({ organizationId: OTHER_ORG, isActive: true });
      }
    });
  });

  // ── resolveAndCalculateDeadlines ─────────────────────────────────────────
  describe('resolveAndCalculateDeadlines', () => {
    const NOW = new Date('2026-08-03T12:00:00Z');

    beforeEach(() => {
      prisma.businessHoursConfig.findUnique.mockResolvedValue({
        businessHoursStart: '08:30',
        businessHoursEnd: '17:30',
        businessDays: '1,2,3,4,5',
        timezone: 'America/Asuncion',
      } as never);
      prisma.holiday.findMany.mockResolvedValue([{ date: new Date('2026-08-15T00:00:00Z') }] as never);
    });

    it('convierte horas → minutos y delega en el motor de horas hábiles existente', async () => {
      const policy = makePolicy({ firstResponseHours: 2, resolutionHours: 8 });
      prisma.projectTicketTypeSla.findFirst.mockResolvedValueOnce({ slaPolicy: policy } as never);

      const result = await service.resolveAndCalculateDeadlines(
        { organizationId: ORG, clientId: CLIENT, projectId: PROJECT, ticketTypeId: TYPE },
        NOW,
      );

      const bh = {
        start: '08:30',
        end: '17:30',
        days: [1, 2, 3, 4, 5],
        timezone: 'America/Asuncion',
      };
      const holidays = [new Date('2026-08-15T00:00:00Z')];
      expect(calculateBusinessDeadline).toHaveBeenCalledWith(NOW, 120, bh, holidays);
      expect(calculateBusinessDeadline).toHaveBeenCalledWith(NOW, 480, bh, holidays);
      expect(result.source).toBe(SlaSource.CONTRACT);
      expect(result.responseDeadline).toEqual(new Date('2026-08-03T14:00:00Z'));
      expect(result.resolutionDeadline).toEqual(new Date('2026-08-03T20:00:00Z'));
    });

    it('sin política (NONE) devuelve deadlines null y no calcula nada', async () => {
      const result = await service.resolveAndCalculateDeadlines(
        { organizationId: ORG, clientId: CLIENT, projectId: PROJECT },
        NOW,
      );

      expect(result).toEqual({
        policy: null,
        source: SlaSource.NONE,
        responseDeadline: null,
        resolutionDeadline: null,
      });
      expect(prisma.businessHoursConfig.findUnique).not.toHaveBeenCalled();
    });

    it('emite sla.resolved.fallback cuando la cascada cae a CRITICALITY', async () => {
      prisma.slaPolicy.findFirst.mockResolvedValueOnce(makePolicy({ id: 'p-crit' }) as never);

      await service.resolveAndCalculateDeadlines(
        {
          organizationId: ORG,
          clientId: CLIENT,
          projectId: PROJECT,
          ticketTypeId: TYPE,
          criticality: TicketCriticality.HIGH,
        },
        NOW,
      );

      expect(events.emit).toHaveBeenCalledWith(
        'sla.resolved.fallback',
        expect.objectContaining({
          source: SlaSource.CRITICALITY,
          projectId: PROJECT,
          ticketTypeId: TYPE,
          policyId: 'p-crit',
          organizationId: ORG,
        }),
      );
    });

    it('NO emite sla.resolved.fallback cuando resolvió por contrato', async () => {
      prisma.projectTicketTypeSla.findFirst.mockResolvedValueOnce({
        slaPolicy: makePolicy(),
      } as never);

      await service.resolveAndCalculateDeadlines(
        { organizationId: ORG, clientId: CLIENT, projectId: PROJECT, ticketTypeId: TYPE },
        NOW,
      );

      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});

/**
 * `findLegacySlaConfig` — el path que corre mientras `SLA_CASCADE_ENABLED` está
 * APAGADO, es decir el estado con el que la feature #42 se mergea a producción.
 *
 * Existe por el hallazgo C1' del review post-#42: la reincidencia de C1 con otra
 * llave. Los llamadores hacían `findUnique` + `if (row) { calcular }` **sin `else`**;
 * si la organización no tenía fila para esa criticidad el ticket se guardaba sin
 * deadlines, en silencio y para siempre. Y `CRITICAL` nunca tiene fila: nació con
 * el enum en Fase 3 sin backfill, y la única pantalla que administra `SlaConfig`
 * tiene HIGH/MEDIUM/LOW hardcodeadas.
 */
describe('SlaResolverService.findLegacySlaConfig', () => {
  let service: SlaResolverService;
  let prisma: DeepMockProxy<PrismaService>;

  const ORG = 'org-1';
  const ROW = { responseTimeMinutes: 240, resolutionTimeMinutes: 1440 };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new SlaResolverService(prisma, mockDeep<EventEmitter2>());
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  it('devuelve la fila exacta cuando existe (comportamiento de siempre)', async () => {
    prisma.slaConfig.findUnique.mockResolvedValue(ROW as never);

    const res = await service.findLegacySlaConfig(ORG, TicketCriticality.HIGH);

    expect(res).toEqual(ROW);
    expect(prisma.slaConfig.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.slaConfig.findUnique).toHaveBeenCalledWith({
      where: { organizationId_criticality: { organizationId: ORG, criticality: TicketCriticality.HIGH } },
    });
  });

  it('CRITICAL sin fila: cae a MEDIUM y avisa, en vez de dejar el ticket sin deadlines', async () => {
    prisma.slaConfig.findUnique
      .mockResolvedValueOnce(null as never) // CRITICAL: no existe (nunca se creó)
      .mockResolvedValueOnce(ROW as never); // MEDIUM: la de fallback

    const res = await service.findLegacySlaConfig(ORG, TicketCriticality.CRITICAL);

    expect(res).toEqual(ROW);
    expect(prisma.slaConfig.findUnique).toHaveBeenNthCalledWith(2, {
      where: { organizationId_criticality: { organizationId: ORG, criticality: TicketCriticality.MEDIUM } },
    });
    // El aviso NO es opcional: sin él la degradación sería invisible.
    expect(service['logger'].warn).toHaveBeenCalled();
  });

  it('org sin NINGUNA SlaConfig: devuelve null pero lo loguea como error (no en silencio)', async () => {
    prisma.slaConfig.findUnique.mockResolvedValue(null as never);

    const res = await service.findLegacySlaConfig(ORG, TicketCriticality.CRITICAL);

    expect(res).toBeNull();
    expect(service['logger'].error).toHaveBeenCalled();
  });

  it('MEDIUM sin fila: no se consulta dos veces a sí misma', async () => {
    prisma.slaConfig.findUnique.mockResolvedValue(null as never);

    await service.findLegacySlaConfig(ORG, TicketCriticality.MEDIUM);

    expect(prisma.slaConfig.findUnique).toHaveBeenCalledTimes(1);
  });
});
