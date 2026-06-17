import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { TicketStatus } from '@prisma/client';
import { OnnixMappingService } from './onnix-mapping.service';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OnnixClientService } from './onnix-client.service';
import { OnnixCatalogos } from './types/onnix.types';

// Cast puntual documentado: los getters de AppConfigService son read-only; el
// mock los hace asignables en runtime pero TS sigue viendo el tipo real.
type WritableConfig = { -readonly [K in keyof AppConfigService]: AppConfigService[K] };

/**
 * Tests de OnnixMappingService (feature #13).
 *
 * Prisma MOCKEADO (jest-mock-extended) y OnnixClientService MOCKEADO (catalogos).
 * NUNCA toca DATABASE_URL ni HTTP real.
 *
 * Cubre: T19 (R15/R16/R17/R18 mapeo cliente y proyecto), + R19/R20/R21.
 */
describe('OnnixMappingService', () => {
  let service: OnnixMappingService;
  let prisma: DeepMockProxy<PrismaService>;
  let config: DeepMockProxy<AppConfigService> & WritableConfig;
  let onnix: DeepMockProxy<OnnixClientService>;

  const TRACE = 'trace-1';
  const ORG = 'org-test';

  const catalogos: OnnixCatalogos = {
    estados: [
      { id: 1, name: 'Nuevo', slug: 'nuevo' },
      { id: 2, name: 'En proceso', slug: 'en_proceso' },
      { id: 3, name: 'Resuelto', slug: 'resuelto' },
    ],
    tipos: [{ id: 10, name: 'Soporte', slug: 'soporte' }],
    categorias: [{ id: 20, name: 'General', slug: 'general' }],
    prioridades: [{ id: 30, name: 'Media', slug: 'media' }],
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & WritableConfig;
    onnix = mockDeep<OnnixClientService>();
    config.onnixCatalogCacheTtlSec = 600;
    onnix.getCatalogos.mockResolvedValue(catalogos);
    service = new OnnixMappingService(prisma, config, onnix);
  });

  describe('resolveClientId — R15/R16 (scoped por org)', () => {
    it('R15: cliente mapeado -> devuelve el onnix_id de la tabla de mapeo', async () => {
      // Partial: el service solo selecciona onnixId; cast porque Prisma tipa el modelo completo.
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce({ onnixId: 555 } as never);
      const id = await service.resolveClientId(ORG, 'zentik_client_1');
      expect(id).toBe(555);
      const arg = prisma.onnixEntityMapping.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({
        organizationId_entityType_zentikId: {
          organizationId: ORG,
          entityType: 'client',
          zentikId: 'zentik_client_1',
        },
      });
    });

    it('R16: cliente NO mapeado -> null (la fila ira a failed en el dispatcher)', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce(null);
      const id = await service.resolveClientId(ORG, 'zentik_client_desconocido');
      expect(id).toBeNull();
    });
  });

  describe('resolveProjectId — R17/R18 (scoped por org)', () => {
    it('R17: proyecto mapeado -> devuelve el project_id de Onnix', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce({ onnixId: 777 } as never);
      const id = await service.resolveProjectId(ORG, 'zentik_project_1');
      expect(id).toBe(777);
      const arg = prisma.onnixEntityMapping.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({
        organizationId_entityType_zentikId: {
          organizationId: ORG,
          entityType: 'project',
          zentikId: 'zentik_project_1',
        },
      });
    });

    it('R18: proyecto NO mapeado -> null (best-effort, no bloquea, no failed)', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce(null);
      const id = await service.resolveProjectId(ORG, 'zentik_project_x');
      expect(id).toBeNull();
    });

    it('R18: proyecto null/undefined -> null sin tocar la DB', async () => {
      const id = await service.resolveProjectId(ORG, null);
      expect(id).toBeNull();
      expect(prisma.onnixEntityMapping.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('resolveStatusSlug — R21', () => {
    it('R21: estado Zentik -> slug Onnix validado contra el catalogo', async () => {
      const slug = await service.resolveStatusSlug(TicketStatus.IN_PROGRESS, TRACE);
      expect(slug).toBe('en_proceso');
      expect(catalogos.estados.some((e) => e.slug === slug)).toBe(true);
    });

    it('mapea OPEN -> nuevo y RESOLVED -> resuelto', async () => {
      expect(await service.resolveStatusSlug(TicketStatus.OPEN, TRACE)).toBe('nuevo');
      expect(await service.resolveStatusSlug(TicketStatus.RESOLVED, TRACE)).toBe('resuelto');
    });
  });

  describe('resolveCatalogIds — R19 (scoped por org)', () => {
    it('R19: usa mapeo explicito de tipo/categoria/prioridad si existe', async () => {
      prisma.onnixEntityMapping.findUnique
        .mockResolvedValueOnce({ onnixId: 11 } as never) // ticket_type
        .mockResolvedValueOnce({ onnixId: 22 } as never) // ticket_category
        .mockResolvedValueOnce({ onnixId: 33 } as never); // ticket_priority
      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE);
      expect(ids).toEqual({ ticketTypeId: 11, ticketCategoryId: 22, ticketPriorityId: 33 });
      // El lookup del catalogo tambien va scoped por org (clave compuesta).
      const arg = prisma.onnixEntityMapping.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({
        organizationId_entityType_zentikId: {
          organizationId: ORG,
          entityType: 'ticket_type',
          zentikId: 'SUPPORT_REQUEST',
        },
      });
    });

    it('R19: sin mapeo -> fallback al primer item del catalogo (default + warn)', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValue(null);
      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE);
      expect(ids).toEqual({ ticketTypeId: 10, ticketCategoryId: 20, ticketPriorityId: 30 });
    });
  });

  describe('cache de catalogos — R20', () => {
    it('R20: sirve catalogos desde cache (no llama getCatalogos por cada resolucion)', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValue(null);
      await service.resolveStatusSlug(TicketStatus.OPEN, TRACE);
      await service.resolveStatusSlug(TicketStatus.RESOLVED, TRACE);
      await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE);
      // Multiples resoluciones -> una sola llamada HTTP a catalogos (TTL vigente).
      expect(onnix.getCatalogos).toHaveBeenCalledTimes(1);
    });
  });
});
