import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { SessionValidityService } from './session-validity.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * Tests de SessionValidityService (#19 ALTO-2).
 *
 * `isSessionLive` detecta a la vez revocacion (fila borrada → null) y expiracion
 * TTL (expiresAt <= now → null) con UN findFirst. El caso CRITICO es FAIL-OPEN:
 * una excepcion de DB devuelve `true` para no matar sockets por un blip de infra.
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod).
 */
describe('SessionValidityService (#19 ALTO-2)', () => {
  const SESSION_ID = 'sess-1';

  let prisma: DeepMockProxy<PrismaService>;
  let service: SessionValidityService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new SessionValidityService(prisma);
  });

  it('sesion viva (fila existe, no expirada) → true', async () => {
    prisma.session.findFirst.mockResolvedValue({ id: SESSION_ID } as never);

    await expect(service.isSessionLive(SESSION_ID)).resolves.toBe(true);

    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: { id: SESSION_ID, expiresAt: { gt: expect.any(Date) } },
      select: { id: true },
    });
  });

  it('sesion expirada o revocada (findFirst → null) → false', async () => {
    // `expiresAt: { gt: now }` excluye las expiradas; una fila borrada tampoco
    // matchea. Ambos casos colapsan en null → false.
    prisma.session.findFirst.mockResolvedValue(null as never);

    await expect(service.isSessionLive(SESSION_ID)).resolves.toBe(false);
  });

  it('sessionId vacio → false sin pegarle a la DB', async () => {
    await expect(service.isSessionLive('')).resolves.toBe(false);
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: excepcion de DB → true (no desconecta por blip de infra)', async () => {
    prisma.session.findFirst.mockRejectedValue(new Error('PG connection timeout') as never);

    await expect(service.isSessionLive(SESSION_ID)).resolves.toBe(true);
  });
});
