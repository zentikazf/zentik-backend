import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * #66 T2.4 — la superficie de datos del listado de clientes.
 *
 * EL BUG: `findAll` corría un `findMany` con `include` y SIN `select`. Prisma, en ese caso,
 * devuelve TODOS los escalares del modelo — o sea que el listado publicaba
 * `developmentHourlyRate`, `supportHourlyRate`, `taxRate`, `taxMode`, `notes`, `phone` y `email`
 * de todos los clientes de la organización. La ruta está en `read:projects`
 * (client.controller.ts:150-151) y el rol `Cliente` del PORTAL tiene ese permiso
 * (organization.service.ts:81 y `ensureClienteRole`): un usuario externo leía las tarifas de los
 * demás clientes. Fuga INTRA-ORG: el atacante es miembro legítimo de la org que va en la URL,
 * así que ningún guard de tenencia (`orgId ∈ user.organizationIds`) la cierra.
 *
 * POR QUE CADA AUSENCIA VA CON SU PRESENCIA. Un test que sólo verifique "el `select` no tiene
 * `taxRate`" queda VERDE si alguien rompe la proyección entera y deja de devolver todo — el
 * listado se vaciaría y la suite no diría nada. Por eso, para cada campo comercial, hay un caso
 * que exige que NO esté (rol bajo) y otro que exige que SI esté (rol con `read:members`).
 *
 * Se testea contra los args que cruzan hacia Prisma y no contra la respuesta: el `select` ES el
 * contrato. Con Prisma mockeado, mirar `data` no probaría nada.
 */
describe('ClientService — superficie de datos de findAll (#66)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: ClientService;

  const ORG = 'org-1';

  /** Campos comerciales: los que la ruta de al lado (`findById`) niega con 403. */
  const COMERCIALES = [
    'email',
    'phone',
    'notes',
    'developmentHourlyRate',
    'supportHourlyRate',
    'currency',
    'taxRate',
    'taxMode',
  ];

  /** El `select` con el que se llamó a `client.findMany`. */
  const selectDe = (): Record<string, unknown> =>
    (prisma.client.findMany.mock.calls.at(-1)![0] as { select: Record<string, unknown> }).select;

  const whereDe = (): Record<string, unknown> =>
    (prisma.client.findMany.mock.calls.at(-1)![0] as { where: Record<string, unknown> }).where;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new ClientService(
      prisma,
      mockDeep<AuditService>(),
      mockDeep<EmailInvitationService>(),
      mockDeep<OnboardingService>(),
    );
    prisma.$transaction.mockResolvedValue([[], 0] as never);
  });

  // ── El corte, en sus dos direcciones ──────────────────────────────────

  describe('con read:projects y SIN read:members (Developer / QA / Designer / DevOps / Soporte / Cliente)', () => {
    beforeEach(async () => {
      await service.findAll(ORG, { actorPermissions: ['read:projects', 'read:tasks'] });
    });

    it.each(COMERCIALES)('NO pide %s', (campo) => {
      expect(selectDe()[campo]).toBeUndefined();
    });

    it('tampoco pide los campos que no usa ningún consumidor', () => {
      for (const campo of [
        'organizationId',
        'userId',
        'portalBillingEnabled',
        'botmakerAccountId',
        'createdAt',
        'updatedAt',
        'defaultSlaPolicyId',
      ]) {
        expect([campo, selectDe()[campo]]).toEqual([campo, undefined]);
      }
    });

    it('el select reducido es EXACTAMENTE esta lista y nada más', () => {
      // Test de cerrojo: el día que alguien agregue una columna sensible al modelo `Client`,
      // este caso se pone rojo y obliga a decidir de qué lado del corte va.
      expect(Object.keys(selectDe()).sort()).toEqual(
        [
          '_count',
          'contractedHours',
          'id',
          'loanedHours',
          'name',
          'portalEnabled',
          'status',
          'usedHours',
          'user',
        ].sort(),
      );
    });
  });

  describe('con read:members (Tech Lead / Product Owner)', () => {
    beforeEach(async () => {
      await service.findAll(ORG, { actorPermissions: ['read:projects', 'read:members'] });
    });

    it.each(COMERCIALES)('SI pide %s', (campo) => {
      // El par del assert de ausencia de arriba. Sin esto, aquel pasaría con la proyección rota.
      expect(selectDe()[campo]).toBe(true);
    });

    it('sigue trayendo lo básico', () => {
      expect(selectDe().id).toBe(true);
      expect(selectDe().name).toBe(true);
      expect(selectDe().contractedHours).toBe(true);
      expect(selectDe()._count).toEqual({ select: { projects: true } });
    });
  });

  // ── Derivación de permisos: el mismo criterio que el guard ────────────

  it.each([
    ['manage:members (Project Manager) — derivación read←manage', ['read:projects', 'manage:members']],
    ['*:* (Owner)', ['*:*']],
    ['undefined — llamador interno, comportamiento de siempre', undefined],
  ])('%s recibe el payload completo', async (_caso, permisos) => {
    await service.findAll(ORG, { actorPermissions: permisos as string[] | undefined });

    for (const campo of COMERCIALES) {
      expect([campo, selectDe()[campo]]).toEqual([campo, true]);
    }
  });

  it('un array VACIO cae del lado seguro (reducido), no del completo', async () => {
    // No debería ocurrir —el guard exige `read:projects` para llegar acá— pero si ocurre, el
    // default tiene que ser el que menos publica. `[]` es distinto de `undefined` a propósito.
    await service.findAll(ORG, { actorPermissions: [] });

    for (const campo of COMERCIALES) {
      expect([campo, selectDe()[campo]]).toEqual([campo, undefined]);
    }
  });

  // ── withUsers: no depende del permiso ─────────────────────────────────

  describe('?withUsers=true (vista de miembros, use-members-data.ts:51)', () => {
    const CAMPOS_USER = {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      createdAt: true,
      image: true,
    };

    it.each([
      ['sin read:members', ['read:projects']],
      ['con read:members', ['read:projects', 'read:members']],
    ])('%s: devuelve user y users con sus 6 campos', async (_caso, permisos) => {
      await service.findAll(ORG, { withUsers: true, actorPermissions: permisos });

      expect(selectDe().user).toEqual({ select: CAMPOS_USER });
      expect(selectDe().users).toEqual({ select: CAMPOS_USER });
    });

    it('sin withUsers: user viene acotado a email y users no viene', async () => {
      await service.findAll(ORG, { actorPermissions: ['read:projects'] });

      expect(selectDe().user).toEqual({ select: { email: true } });
      expect(selectDe().users).toBeUndefined();
    });
  });

  // ── El oráculo del search ─────────────────────────────────────────────

  describe('?search — no puede ser un oráculo de emails', () => {
    it('sin read:members busca SOLO por nombre', async () => {
      await service.findAll(ORG, { search: 'a@b.com', actorPermissions: ['read:projects'] });

      // Si el email siguiera en el OR, esconderlo del `select` no serviría: se adivina probando
      // strings y mirando qué filas vuelven.
      expect(whereDe().OR).toEqual([{ name: { contains: 'a@b.com', mode: 'insensitive' } }]);
    });

    it('con read:members sigue buscando por nombre Y email, como siempre', async () => {
      await service.findAll(ORG, {
        search: 'a@b.com',
        actorPermissions: ['read:projects', 'read:members'],
      });

      expect(whereDe().OR).toEqual([
        { name: { contains: 'a@b.com', mode: 'insensitive' } },
        { email: { contains: 'a@b.com', mode: 'insensitive' } },
      ]);
    });
  });

  // ── Lo que NO cambió ──────────────────────────────────────────────────

  it('el corte no toca la paginación ni el filtro por organización', async () => {
    await service.findAll(ORG, {
      page: 3,
      limit: 25,
      status: 'ACTIVE',
      actorPermissions: ['read:projects'],
    });

    const args = prisma.client.findMany.mock.calls.at(-1)![0] as {
      skip: number;
      take: number;
      orderBy: unknown;
    };
    expect([args.skip, args.take]).toEqual([50, 25]);
    expect(args.orderBy).toEqual({ name: 'asc' });
    expect(whereDe()).toMatchObject({ organizationId: ORG, status: 'ACTIVE' });
  });

  it('nunca se usa `include`: con select serían mutuamente excluyentes y Prisma tiraría', async () => {
    await service.findAll(ORG, { actorPermissions: ['read:projects'] });

    expect((prisma.client.findMany.mock.calls.at(-1)![0] as Record<string, unknown>).include).toBeUndefined();
  });
});
