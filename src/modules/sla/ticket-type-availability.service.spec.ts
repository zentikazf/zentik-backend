import { TicketCriticality } from '@prisma/client';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { TicketTypeAvailabilityService } from './ticket-type-availability.service';

/**
 * Tests de TicketTypeAvailabilityService (feature #42 — Fase 2).
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca una DB real.
 *
 * Foco: los 3 criterios de aceptación del blueprint —
 *  · proyecto CON contratos → solo los tipos contratados
 *  · proyecto SIN contratos → permisivo (todos los activos) + `fallback: true`
 *  · con criticidad → solo los contratos de políticas de ESA criticidad
 * …y el scoping multi-tenant en todas las queries.
 */
describe('TicketTypeAvailabilityService', () => {
  let service: TicketTypeAvailabilityService;
  let prisma: DeepMockProxy<PrismaService>;

  const ORG = 'org-1';
  const PROJECT = 'project-1';

  const incidencia = { id: 'type-inc', name: 'Incidencia', slug: 'incidencia' };
  const consulta = { id: 'type-con', name: 'Consulta', slug: 'consulta' };
  const mejora = { id: 'type-mej', name: 'Mejora', slug: 'mejora' };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new TicketTypeAvailabilityService(prisma);
  });

  describe('getAvailableTypes — proyecto CON contratos', () => {
    it('devuelve SOLO los tipos contratados (ordenados por nombre) y fallback=false', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: incidencia },
        { ticketType: consulta },
      ] as never);

      await expect(service.getAvailableTypes(ORG, PROJECT)).resolves.toEqual({
        types: [consulta, incidencia],
        fallback: false,
      });
      // no se consulta el catálogo completo: el contrato manda
      expect(prisma.ticketType.findMany).not.toHaveBeenCalled();
    });

    it('scopea por organización el proyecto, la política Y el tipo; solo contratos/políticas activos', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([{ ticketType: incidencia }] as never);

      await service.getAvailableTypes(ORG, PROJECT);

      const where = (prisma.projectTicketTypeSla.findMany.mock.calls[0][0] as { where: any }).where;
      expect(where).toMatchObject({
        projectId: PROJECT,
        isActive: true,
        project: { organizationId: ORG },
        slaPolicy: { organizationId: ORG, isActive: true },
        ticketType: { organizationId: ORG, isActive: true },
      });
      // sin filtro de criticidad no se agrega la clave
      expect(where.slaPolicy.criticality).toBeUndefined();
    });

    it('con criticidad filtra los contratos por la criticidad de la política (selector encadenado)', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([{ ticketType: incidencia }] as never);

      const result = await service.getAvailableTypes(ORG, PROJECT, TicketCriticality.HIGH);

      const where = (prisma.projectTicketTypeSla.findMany.mock.calls[0][0] as { where: any }).where;
      expect(where.slaPolicy.criticality).toBe(TicketCriticality.HIGH);
      expect(result).toEqual({ types: [incidencia], fallback: false });
    });
  });

  describe('getAvailableTypes — modo permisivo', () => {
    it('proyecto SIN contratos → todos los tipos activos de la org con fallback=true', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      prisma.ticketType.findMany.mockResolvedValue([consulta, incidencia, mejora] as never);

      await expect(service.getAvailableTypes(ORG, PROJECT)).resolves.toEqual({
        types: [consulta, incidencia, mejora],
        fallback: true,
      });
      expect(prisma.ticketType.findMany.mock.calls[0][0]).toMatchObject({
        where: { organizationId: ORG, isActive: true },
        orderBy: { name: 'asc' },
      });
    });

    it('criticidad que no matchea ningún contrato → permisivo (nunca un selector vacío)', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      prisma.ticketType.findMany.mockResolvedValue([consulta] as never);

      await expect(
        service.getAvailableTypes(ORG, PROJECT, TicketCriticality.LOW),
      ).resolves.toEqual({ types: [consulta], fallback: true });
    });

    it('org sin ningún tipo activo → lista vacía marcada como fallback', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      prisma.ticketType.findMany.mockResolvedValue([] as never);

      await expect(service.getAvailableTypes(ORG, PROJECT)).resolves.toEqual({
        types: [],
        fallback: true,
      });
    });
  });

  describe('isTypeAvailable — validación server-side de la creación desde el portal', () => {
    it('true si el tipo está contratado en el proyecto', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: incidencia },
      ] as never);

      await expect(service.isTypeAvailable(ORG, PROJECT, incidencia.id)).resolves.toBe(true);
    });

    it('false si el proyecto tiene contratos y el tipo NO está entre ellos', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: incidencia },
      ] as never);

      await expect(service.isTypeAvailable(ORG, PROJECT, consulta.id)).resolves.toBe(false);
    });

    it('true si el proyecto NO tiene contratos y el tipo existe/está activo en la org', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      prisma.ticketType.findMany.mockResolvedValue([consulta, incidencia] as never);

      await expect(service.isTypeAvailable(ORG, PROJECT, consulta.id)).resolves.toBe(true);
    });

    it('modo permisivo NO relaja el scoping: un tipo de OTRA org sigue siendo inválido', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      prisma.ticketType.findMany.mockResolvedValue([consulta] as never); // catálogo de ESTA org

      await expect(service.isTypeAvailable(ORG, PROJECT, 'type-de-otra-org')).resolves.toBe(false);
    });

    it('valida SIN filtrar por criticidad (la disponibilidad es del par proyecto+tipo)', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: incidencia },
      ] as never);

      await service.isTypeAvailable(ORG, PROJECT, incidencia.id);

      const where = (prisma.projectTicketTypeSla.findMany.mock.calls[0][0] as { where: any }).where;
      expect(where.slaPolicy.criticality).toBeUndefined();
    });
  });
});
