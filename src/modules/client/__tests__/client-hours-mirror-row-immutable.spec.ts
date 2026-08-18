import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * #54 — la FILA ESPEJO de una nota de crédito: no se edita, y se borra SIN tocar cupo.
 *
 * La espejo (`rebilledFromTransactionId != null`) es una COPIA derivada del movimiento
 * original, congelada al emitir la NC. Nace con type USAGE/LOAN y `billedCycleId` NULL, así
 * que pasaba los dos guards viejos — y nunca movió el cupo. Reglas cubiertas acá:
 *
 *   1. `deleteHoursTransaction` sobre una espejo → SE PERMITE (soft-delete + audit), pero
 *      SIN revertir contadores: el `decrement` correría sobre horas que la espejo nunca
 *      descontó = regalarle cupo al cliente. Se permite porque no existe flujo para
 *      "corregir el origen" (no hay anulación ni reemisión de NC), y borrarla no
 *      desincroniza nada: el CreditNoteLine congelado sigue intacto.
 *   2. `editHoursTransaction` sobre una espejo → 409 MIRROR_ROW_READONLY
 *      (editarla aplicaba el `increment` del delta sobre un contador que nunca tocó, y la
 *      desincroniza del original que copia). La salida es eliminarla.
 *   3. FAIL-CLOSED en cupo: ni el edit rechazado ni el delete permitido llaman `client.update`.
 *   4. NO REGRESIÓN: una fila normal (`rebilledFromTransactionId` null) se sigue editando
 *      y borrando exactamente como antes.
 *   5. PRECEDENCIA: espejo + facturada → TRANSACTION_BILLED (el guard de `billedCycleId` va
 *      primero), que es lo que el usuario necesita saber para desbloquearla.
 *   6. ALCANCE: el guard mira `rebilledFromTransactionId` (espejo de NC, H9b) y NO
 *      `reversesTransactionId` (REFUND de reversa, H9a). Son campos DISTINTOS.
 *
 * Prisma MOCKEADO (jest-mock-extended) — nunca toca la DB.
 */
describe('ClientService — inmutabilidad de la fila espejo de una NC (#54)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let service: ClientService;
  let tx: DeepMockProxy<Prisma.TransactionClient>;

  const ORG = 'org-1';
  const CLIENT = 'client-1';

  /** Movimiento base del ledger. Por defecto NO es espejo y NO está facturado. */
  const hoursTx = (overrides: Record<string, unknown> = {}) => ({
    id: 'h1',
    clientId: CLIENT,
    type: 'USAGE',
    hours: 2,
    priceAmount: null,
    priceRate: null,
    priceCurrency: null,
    billedCycleId: null,
    // Campos DISTINTOS: `rebilledFromTransactionId` marca la ESPEJO de una NC (H9b, el que mira
    // el guard); `reversesTransactionId` marca el REFUND de una reversa (H9a, que el guard NO
    // debe mirar — endurecerlo dejaría indeleteables todos los REFUND de hours.listener).
    rebilledFromTransactionId: null,
    reversesTransactionId: null,
    ...overrides,
  });

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    tx = mockDeep<Prisma.TransactionClient>();
    service = new ClientService(
      prisma,
      audit,
      mockDeep<EmailInvitationService>(),
      mockDeep<OnboardingService>(),
    );

    // findById → cliente válido.
    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      organizationId: ORG,
      currency: 'PYG',
      contractedHours: 100,
      usedHours: 10,
      loanedHours: 0,
    } as never);
    // El autor del edit/delete (se lee sólo para el log y la auditoría).
    prisma.user.findUnique.mockResolvedValue({ name: 'Admin', email: 'admin@zentik.io' } as never);
    // $transaction ejecuta el callback de verdad: así el test ve los updates internos.
    prisma.$transaction.mockImplementation((cb: unknown) =>
      (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx),
    );
  });

  describe('la espejo no se edita (caso 2)', () => {
    it('editar una fila espejo → 409 MIRROR_ROW_READONLY con el detalle del origen', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(
        hoursTx({ rebilledFromTransactionId: 'orig-1' }) as never,
      );

      await expect(
        service.editHoursTransaction(ORG, CLIENT, 'h1', { hours: 5 }, 'user-1'),
      ).rejects.toMatchObject({
        code: 'MIRROR_ROW_READONLY',
        statusCode: 409,
        message:
          'La fila espejo de una nota de crédito no se edita: es una copia derivada del movimiento original. Si la devolución de horas fue un error, eliminá la fila.',
        details: { transactionId: 'h1', rebilledFromTransactionId: 'orig-1' },
      });
    });
  });

  describe('la espejo SÍ se borra, pero sin tocar el cupo (caso 1)', () => {
    it('eliminar una fila espejo → soft-delete escrito y NINGÚN client.update', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(
        hoursTx({ rebilledFromTransactionId: 'orig-1' }) as never,
      );

      await expect(
        service.deleteHoursTransaction(ORG, CLIENT, 'h1', 'user-1', 'la NC fue un error'),
      ).resolves.toBeUndefined();

      // El soft-delete SÍ se escribe (fuera del $transaction: no hay contadores que atomizar).
      expect(prisma.hoursTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'h1' },
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
            deletedById: 'user-1',
            deleteReason: 'la NC fue un error',
          }),
        }),
      );
      // El cupo NO se toca: la espejo nunca lo movió, revertirlo lo regalaría.
      expect(prisma.client.update).not.toHaveBeenCalled();
      expect(tx.client.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('la auditoría deja constancia de que era espejo y de que NO se revirtió cupo', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(
        hoursTx({ rebilledFromTransactionId: 'orig-1', note: 'Soporte mayo' }) as never,
      );

      await service.deleteHoursTransaction(ORG, CLIENT, 'h1', 'user-1', 'motivo');

      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          action: 'client.hours.deleted',
          resource: 'client',
          resourceId: CLIENT,
          oldData: expect.objectContaining({
            transactionId: 'h1',
            rebilledFromTransactionId: 'orig-1',
          }),
          newData: expect.objectContaining({ mirrorRow: true, quotaReverted: false }),
        }),
      );
    });

    it('la espejo tipo LOAN también se borra sin decrementar loanedHours', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(
        hoursTx({ type: 'LOAN', rebilledFromTransactionId: 'orig-2' }) as never,
      );

      await service.deleteHoursTransaction(ORG, CLIENT, 'h1', 'user-1', 'motivo');

      expect(prisma.hoursTransaction.update).toHaveBeenCalled();
      expect(prisma.client.update).not.toHaveBeenCalled();
      expect(tx.client.update).not.toHaveBeenCalled();
    });
  });

  describe('el guard de edit es fail-closed: el cupo no se toca ni parcialmente (caso 3)', () => {
    it('edit rechazado → ni $transaction, ni client.update, ni update de la fila', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(
        hoursTx({ rebilledFromTransactionId: 'orig-1' }) as never,
      );

      await expect(
        service.editHoursTransaction(ORG, CLIENT, 'h1', { hours: 5 }, 'user-1'),
      ).rejects.toMatchObject({ code: 'MIRROR_ROW_READONLY' });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.client.update).not.toHaveBeenCalled();
      expect(tx.client.update).not.toHaveBeenCalled(); // el increment del delta
      expect(tx.hoursTransaction.update).not.toHaveBeenCalled();
      expect(audit.create).not.toHaveBeenCalled();
    });

    it('la espejo tipo LOAN tampoco entra (el guard no depende del type)', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(
        hoursTx({ type: 'LOAN', rebilledFromTransactionId: 'orig-2' }) as never,
      );

      await expect(
        service.editHoursTransaction(ORG, CLIENT, 'h1', { hours: 5 }, 'user-1'),
      ).rejects.toMatchObject({ code: 'MIRROR_ROW_READONLY', statusCode: 409 });
      expect(tx.client.update).not.toHaveBeenCalled();
    });
  });

  describe('no hay regresión: la fila normal sigue funcionando igual (caso 4)', () => {
    it('eliminar una fila normal USAGE → soft-delete + decrement de usedHours', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(hoursTx() as never); // espejo null

      await service.deleteHoursTransaction(ORG, CLIENT, 'h1', 'user-1', 'me equivoqué');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.hoursTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'h1' },
          data: expect.objectContaining({ deleteReason: 'me equivoqué' }),
        }),
      );
      expect(tx.client.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { usedHours: { decrement: 2 } } }),
      );
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'client.hours.deleted' }),
      );
    });

    it('editar una fila normal USAGE → update de la fila + increment del delta', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(hoursTx() as never); // 2 h, espejo null

      const res = await service.editHoursTransaction(ORG, CLIENT, 'h1', { hours: 5 }, 'user-1');

      expect(res).toEqual({ success: true, transactionId: 'h1' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.hoursTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'h1' },
          data: expect.objectContaining({ hours: 5 }),
        }),
      );
      expect(tx.client.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { usedHours: { increment: 3 } } }), // 5 - 2
      );
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'client.hours.edited' }),
      );
    });
  });

  describe('precedencia: facturada gana sobre espejo (caso 5)', () => {
    it('eliminar una fila espejo Y facturada → TRANSACTION_BILLED, no MIRROR_ROW_READONLY', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(
        hoursTx({ billedCycleId: 'cyc1', rebilledFromTransactionId: 'orig-1' }) as never,
      );

      await expect(
        service.deleteHoursTransaction(ORG, CLIENT, 'h1', 'user-1', 'motivo'),
      ).rejects.toMatchObject({
        code: 'TRANSACTION_BILLED',
        statusCode: 409,
        details: { transactionId: 'h1', billedCycleId: 'cyc1' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('editar una fila espejo Y facturada → TRANSACTION_BILLED, no MIRROR_ROW_READONLY', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(
        hoursTx({ billedCycleId: 'cyc1', rebilledFromTransactionId: 'orig-1' }) as never,
      );

      await expect(
        service.editHoursTransaction(ORG, CLIENT, 'h1', { hours: 5 }, 'user-1'),
      ).rejects.toMatchObject({
        code: 'TRANSACTION_BILLED',
        statusCode: 409,
        details: { transactionId: 'h1', billedCycleId: 'cyc1' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('alcance del guard: espejo ≠ linaje de reversa H9a (caso 6)', () => {
    it('un REFUND con reversesTransactionId (y espejo null) se borra normal, sin MIRROR_ROW_READONLY', async () => {
      // Si alguien "endurece" el guard a
      // `tx.rebilledFromTransactionId || tx.reversesTransactionId`, TODOS los REFUND que crea
      // hours.listener quedan indeleteables en runtime. Este test fija esa frontera.
      prisma.hoursTransaction.findFirst.mockResolvedValue(
        hoursTx({ type: 'REFUND', reversesTransactionId: 'usage-1', rebilledFromTransactionId: null }) as never,
      );

      await expect(
        service.deleteHoursTransaction(ORG, CLIENT, 'h1', 'user-1', 'motivo'),
      ).resolves.toBeUndefined();

      // Recorrió el camino normal: $transaction con reversa de contadores.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.client.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { contractedHours: { decrement: 2 } } }),
      );
    });
  });
});
