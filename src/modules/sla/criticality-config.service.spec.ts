import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, TicketCriticality } from '@prisma/client';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { CriticalityConfigService, parseCriticality } from './criticality-config.service';

/**
 * Tests de CriticalityConfigService (feature #42 — Fase 2).
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca una DB real.
 *
 * Foco: el default EXCLUYENTE (dos defaults dejarían `getDefault` ambiguo) y el
 * modo 2B — si ninguna criticidad es `clientVisible`, el portal no muestra el
 * selector y entra la criticidad por defecto de la organización.
 */
describe('CriticalityConfigService', () => {
  let service: CriticalityConfigService;
  let prisma: DeepMockProxy<PrismaService>;
  let tx: DeepMockProxy<Prisma.TransactionClient>;
  let events: DeepMockProxy<EventEmitter2>;

  const ORG = 'org-1';
  const USER = 'user-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    tx = mockDeep<Prisma.TransactionClient>();
    events = mockDeep<EventEmitter2>();
    service = new CriticalityConfigService(prisma, events);
    prisma.$transaction.mockImplementation((cb: unknown) =>
      (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx),
    );
    tx.ticketCriticalityConfig.upsert.mockResolvedValue({
      criticality: TicketCriticality.HIGH,
      clientVisible: true,
      isDefault: true,
    } as never);
  });

  describe('upsert — isDefault es EXCLUYENTE', () => {
    it('marcar isDefault=true desmarca las otras criticidades en la MISMA transacción', async () => {
      await service.upsert(ORG, TicketCriticality.HIGH, { isDefault: true }, USER);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.ticketCriticalityConfig.updateMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG,
          criticality: { not: TicketCriticality.HIGH },
          isDefault: true,
        },
        data: { isDefault: false },
      });
      // el upsert de la fila elegida también va dentro de la tx
      expect(tx.ticketCriticalityConfig.upsert).toHaveBeenCalledTimes(1);
    });

    it('sin isDefault (o con isDefault=false) NO toca las demás filas', async () => {
      await service.upsert(ORG, TicketCriticality.LOW, { clientVisible: false }, USER);
      await service.upsert(ORG, TicketCriticality.LOW, { isDefault: false }, USER);

      expect(tx.ticketCriticalityConfig.updateMany).not.toHaveBeenCalled();
    });

    it('scopea el upsert por (organización, criticidad) y aplica solo los campos enviados', async () => {
      await service.upsert(ORG, TicketCriticality.HIGH, { clientLabel: 'Urgente' }, USER);

      const arg = tx.ticketCriticalityConfig.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({
        organizationId_criticality: { organizationId: ORG, criticality: TicketCriticality.HIGH },
      });
      expect(arg.update).toEqual({ clientLabel: 'Urgente' });
      // create: defaults del catálogo cuando la fila todavía no existe
      expect(arg.create).toMatchObject({
        organizationId: ORG,
        criticality: TicketCriticality.HIGH,
        displayName: 'Alta',
        clientLabel: 'Urgente',
        clientVisible: true,
        level: 3,
        isDefault: false,
      });
    });

    it('clientLabel: null limpia la etiqueta de cara al cliente', async () => {
      await service.upsert(ORG, TicketCriticality.HIGH, { clientLabel: null }, USER);

      expect(tx.ticketCriticalityConfig.upsert.mock.calls[0][0].update).toEqual({
        clientLabel: null,
      });
    });

    it('emite criticality.config.updated dentro de la transacción', async () => {
      await service.upsert(ORG, TicketCriticality.HIGH, { clientVisible: true }, USER);

      expect(events.emit).toHaveBeenCalledWith(
        'criticality.config.updated',
        expect.objectContaining({
          organizationId: ORG,
          criticality: TicketCriticality.HIGH,
          userId: USER,
        }),
      );
    });
  });

  describe('getClientVisible', () => {
    it('devuelve solo las visibles, de más a menos urgente, con clientLabel si existe', async () => {
      prisma.ticketCriticalityConfig.findMany.mockResolvedValue([
        {
          criticality: TicketCriticality.HIGH,
          displayName: 'Alta',
          clientLabel: 'Urgente',
          level: 3,
        },
        { criticality: TicketCriticality.MEDIUM, displayName: 'Media', clientLabel: null, level: 2 },
      ] as never);

      await expect(service.getClientVisible(ORG)).resolves.toEqual([
        { criticality: TicketCriticality.HIGH, label: 'Urgente', level: 3 },
        // sin clientLabel cae al nombre interno
        { criticality: TicketCriticality.MEDIUM, label: 'Media', level: 2 },
      ]);

      const arg = prisma.ticketCriticalityConfig.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        orderBy: Record<string, unknown>;
      };
      expect(arg.where).toMatchObject({ organizationId: ORG, clientVisible: true });
      expect(arg.orderBy).toEqual({ level: 'desc' });
    });

    it('modo 2B: ninguna visible → [] (el front no renderiza el selector)', async () => {
      prisma.ticketCriticalityConfig.findMany.mockResolvedValue([] as never);

      await expect(service.getClientVisible(ORG)).resolves.toEqual([]);
    });
  });

  describe('getDefault — la criticidad que entra si el cliente no elige', () => {
    it('modo 2B: sin visibles, el default configurado de la org es el que aplica', async () => {
      prisma.ticketCriticalityConfig.findMany.mockResolvedValue([] as never);
      prisma.ticketCriticalityConfig.findFirst.mockResolvedValue({
        criticality: TicketCriticality.LOW,
      } as never);

      await expect(service.getClientVisible(ORG)).resolves.toEqual([]);
      await expect(service.getDefault(ORG)).resolves.toBe(TicketCriticality.LOW);
      expect(prisma.ticketCriticalityConfig.findFirst.mock.calls[0][0]).toMatchObject({
        where: { organizationId: ORG, isDefault: true },
      });
    });

    it('org sin ninguna fila configurada → fallback MEDIUM (ningún ticket queda sin criticidad)', async () => {
      prisma.ticketCriticalityConfig.findFirst.mockResolvedValue(null as never);

      await expect(service.getDefault(ORG)).resolves.toBe(TicketCriticality.MEDIUM);
    });
  });

  describe('parseCriticality — los path/query params no pasan por el ValidationPipe', () => {
    it('devuelve null para vacío/ausente y el enum para un valor válido', () => {
      expect(parseCriticality(undefined)).toBeNull();
      expect(parseCriticality('')).toBeNull();
      expect(parseCriticality('HIGH')).toBe(TicketCriticality.HIGH);
    });

    it('rechaza un valor que no existe en el enum', () => {
      expect(() => parseCriticality('CRITICAL')).toThrow(
        expect.objectContaining({ code: 'CRITICALITY_INVALID', statusCode: 400 }),
      );
    });
  });
});
