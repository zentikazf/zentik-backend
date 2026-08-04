import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService } from '../sync/outbox.service';
import { SlaResolverService } from '../sla/sla-resolver.service';
import { TicketService } from './ticket.service';
import { TicketEventsService } from './ticket-events.service';
import { TaskHoursGuardService } from './task-hours-guard.service';
import { plainToInstance } from 'class-transformer';
import { ListTicketsQueryDto, SlaOutcome } from './dto/list-tickets-query.dto';

/**
 * Tests del armado del `where` del listado de tickets.
 *
 * Nacen de dos hallazgos del barrido post-#42, ambos **400 duros** sobre el listado
 * principal — y pegajosos, porque los filtros se persisten en cookie 30 días:
 *
 *  - el panel "Más filtros" mandaba `projectId` y el DTO no lo declaraba; con
 *    `forbidNonWhitelisted: true` (main.ts) eso no se ignora, revienta;
 *  - el panel deja marcar VARIOS desenlaces SLA y los manda CSV, pero `slaOutcome`
 *    estaba tipado como valor único.
 *
 * Y de paso cubren la colisión que salió al arreglar el segundo: `COMPLIED` escribía
 * en `where.OR`, el MISMO array del buscador, anulándolo.
 *
 * Prisma MOCKEADO. Nunca toca una DB real.
 */
describe('TicketService — where del listado', () => {
  let service: TicketService;
  let prisma: DeepMockProxy<PrismaService>;

  const ORG = 'org-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new TicketService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<TicketEventsService>(),
      mockDeep<AppConfigService>(),
      mockDeep<OutboxService>(),
      mockDeep<TaskHoursGuardService>(),
      mockDeep<SlaResolverService>(),
    );
  });

  function buildWhere(query: Partial<ListTicketsQueryDto>): Prisma.TicketWhereInput {
    return service['buildOrgTicketsWhere'](ORG, query as ListTicketsQueryDto);
  }

  describe('projectId', () => {
    it('filtra por proyecto (antes el parámetro ni existía en el DTO → 400)', () => {
      expect(buildWhere({ projectId: 'project-9' })).toMatchObject({
        organizationId: ORG,
        projectId: 'project-9',
      });
    });

    it('sin projectId no agrega la condición (no restringe de más)', () => {
      expect(buildWhere({})).not.toHaveProperty('projectId');
    });
  });

  describe('slaOutcome', () => {
    it('un solo desenlace: la cláusula va sola, sin OR innecesario', () => {
      const where = buildWhere({ slaOutcome: [SlaOutcome.NO_SLA] });

      expect(where.AND).toEqual([{ responseDeadline: null, resolutionDeadline: null }]);
    });

    it('varios desenlaces: se combinan con OR (antes: 400)', () => {
      const where = buildWhere({
        slaOutcome: [SlaOutcome.NO_SLA, SlaOutcome.BREACHED_BOTH],
      });

      expect(where.AND).toEqual([
        {
          OR: [
            { responseDeadline: null, resolutionDeadline: null },
            { slaResponseBreached: true, slaResolutionBreached: true },
          ],
        },
      ]);
    });

    /**
     * El bug que apareció al arreglar el anterior: `COMPLIED` empujaba sus dos
     * cláusulas dentro de `where.OR`, que es el array que usa el buscador. El OR
     * resultante era "título coincide O id coincide O ticketNumber coincide O tiene
     * responseDeadline O tiene resolutionDeadline" → el texto buscado dejaba de
     * filtrar y aparecían tickets que no lo contenían.
     */
    it('COMPLIED + búsqueda: el OR del buscador queda INTACTO (no se mezclan)', () => {
      const where = buildWhere({ slaOutcome: [SlaOutcome.COMPLIED], search: 'factura' });

      // El OR de nivel superior sigue siendo SOLO el del buscador.
      expect(where.OR).toHaveLength(3);
      expect(where.OR).toEqual(
        expect.arrayContaining([
          { title: { contains: 'factura', mode: 'insensitive' } },
        ]),
      );
      // Y la condición de "tiene alguna deadline" quedó aislada dentro del AND.
      expect(where.AND).toEqual([
        {
          slaResponseBreached: false,
          slaResolutionBreached: false,
          status: 'RESOLVED',
          OR: [{ responseDeadline: { not: null } }, { resolutionDeadline: { not: null } }],
        },
      ]);
    });

    it('array vacío no filtra nada', () => {
      expect(buildWhere({ slaOutcome: [] })).not.toHaveProperty('AND');
    });
  });
});

/**
 * El `@Transform(toArray)` de los facets multi-select.
 *
 * El frontend los manda CSV (`?criticality=HIGH,LOW`). La versión original de
 * `toArray` solo envolvía el string entero (`["HIGH,LOW"]`), que
 * `@IsEnum(..., { each: true })` rechaza → **400 en el listado** apenas se marcaba
 * una segunda casilla. Con un solo valor funcionaba, y por eso pasó desapercibido
 * en los tres facets a la vez (criticidad, categoría y desenlace SLA).
 */
describe('ListTicketsQueryDto — facets CSV', () => {
  function transformOf(field: keyof ListTicketsQueryDto): (v: unknown) => unknown {
    return (raw: unknown) =>
      (plainToInstance(ListTicketsQueryDto, { [field]: raw }) as Record<string, unknown>)[field];
  }

  it.each(['criticality', 'category', 'slaOutcome'] as const)(
    '%s: un CSV se parte en varios valores (antes: 400)',
    (field) => {
      expect(transformOf(field)('HIGH,LOW')).toEqual(['HIGH', 'LOW']);
    },
  );

  it('un solo valor sigue llegando como array de uno', () => {
    expect(transformOf('criticality')('HIGH')).toEqual(['HIGH']);
  });

  it('tolera espacios alrededor de las comas', () => {
    expect(transformOf('criticality')('HIGH , LOW')).toEqual(['HIGH', 'LOW']);
  });

  it('string vacío no produce un valor fantasma que rompa el IsEnum', () => {
    expect(transformOf('criticality')('')).toEqual([]);
  });

  it('ausente sigue siendo undefined (no filtra)', () => {
    expect(transformOf('criticality')(undefined)).toBeUndefined();
  });
});
