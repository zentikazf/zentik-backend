import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import { AppConfigService } from '../../../config/app.config';

/**
 * #68 F1b — los permisos salen de la organización de la que habla la URL.
 *
 * EL BUG. `PermissionsGuard` consume un único `user.permissions`. Ese array salía de
 * `organizationMembers[0]` —una membership elegida sin saber contra qué organización se estaba
 * operando— y si su rol se llamaba 'Owner' se convertía en `['*:*']`. Como `auth.service.ts:68-72`
 * le crea a cada registrado una organización PERSONAL donde es Owner, cualquiera con dos
 * memberships arrastraba ese comodín a todas las requests contra la organización real.
 *
 * F1 (`c09202d`) sólo le puso `orderBy` a esa elección: la volvió predecible, no correcta. Este
 * archivo prueba F1b, que **elimina la elección**.
 *
 * CADA CASO VA CON SU PAR. El test central —"pegándole a la organización real se evalúa como
 * Developer, sin comodín"— pasaría igual si alguien borrara el atajo de Owner por completo. Por
 * eso al lado está su espejo: pegándole a la organización personal, `*:*` tiene que seguir
 * apareciendo.
 */
describe('#68 F1b — permisos resueltos por la organización de la URL', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let guard: AuthGuard;

  const ORG_PERSONAL = 'org-personal';
  const ORG_REAL = 'org-real';
  const ORG_AJENA = 'org-de-otro';

  const PERMISOS_DEVELOPER = [
    'read:projects',
    'manage:tasks',
    'read:sprints',
    'read:boards',
    'manage:time-entries',
    'manage:chat',
  ];
  const PERMISOS_SOPORTE = ['read:projects', 'read:tasks', 'manage:time-entries', 'manage:chat'];

  const membership = (organizationId: string, roleName: string, permisos: string[]) => ({
    organizationId,
    roleId: `role-${organizationId}`,
    role: {
      name: roleName,
      rolePermissions: permisos.map((p) => {
        const [action, resource] = p.split(':');
        return { permission: { action, resource } };
      }),
    },
  });

  const OWNER_PERSONAL = () => membership(ORG_PERSONAL, 'Owner', ['*:*']);
  const DEVELOPER_REAL = () => membership(ORG_REAL, 'Developer', PERMISOS_DEVELOPER);

  /**
   * Corre el guard y devuelve el usuario que dejó en `request.user`.
   * `params` es lo que Express pone tras enrutar — verificado con un Nest real en
   * `guard-params-disponibles.spec.ts`.
   */
  async function resolver(memberships: unknown[], params: Record<string, string> = {}) {
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer tok' },
      path: '/loquesea',
      params,
      cookies: {},
    };

    prisma.session.findFirst.mockResolvedValue({
      id: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000),
      user: {
        id: 'u1',
        email: 'staff@zentik.test',
        name: 'Staff',
        emailVerified: true,
        clientId: null,
        organizationMembers: memberships,
      },
    } as never);

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ cookie: () => {} }),
      }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);

    return request.user as {
      organizationId?: string;
      organizationIds: string[];
      roleName?: string;
      permissions: string[];
    };
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    guard = new AuthGuard(prisma, mockDeep<AppConfigService>());
    prisma.session.update.mockResolvedValue({} as never);
  });

  // ── EL CASO QUE DA NOMBRE AL SPEC ─────────────────────────────────────

  describe('Owner en su organización personal + Developer en la organización real', () => {
    it.each([
      ['la real primero', () => [DEVELOPER_REAL(), OWNER_PERSONAL()]],
      ['la personal primero', () => [OWNER_PERSONAL(), DEVELOPER_REAL()]],
    ])(
      'pegándole a la organización REAL se evalúa como Developer, sin comodín (%s)',
      async (_orden, memberships) => {
        const user = await resolver(memberships(), { orgId: ORG_REAL });

        expect(user.permissions).toEqual(PERMISOS_DEVELOPER);
        expect(user.permissions).not.toContain('*:*');
        expect(user.roleName).toBe('Developer');
        expect(user.organizationId).toBe(ORG_REAL);
      },
    );

    it.each([
      ['la real primero', () => [DEVELOPER_REAL(), OWNER_PERSONAL()]],
      ['la personal primero', () => [OWNER_PERSONAL(), DEVELOPER_REAL()]],
    ])(
      'pegándole a la organización PERSONAL sí es Owner con comodín (%s)',
      async (_orden, memberships) => {
        // El PAR del anterior. Sin este caso, aquel pasaría igual con el atajo de Owner
        // eliminado por completo — y ahí habríamos roto a todos los Owner del sistema.
        const user = await resolver(memberships(), { orgId: ORG_PERSONAL });

        expect(user.permissions).toEqual(['*:*']);
        expect(user.roleName).toBe('Owner');
        expect(user.organizationId).toBe(ORG_PERSONAL);
      },
    );

    it('el orden de las memberships ya no cambia NADA cuando la URL trae :orgId', async () => {
      const unOrden = await resolver([DEVELOPER_REAL(), OWNER_PERSONAL()], { orgId: ORG_REAL });
      const otroOrden = await resolver([OWNER_PERSONAL(), DEVELOPER_REAL()], { orgId: ORG_REAL });

      expect(unOrden.permissions).toEqual(otroOrden.permissions);
    });
  });

  // ── La organización ajena ─────────────────────────────────────────────

  describe('cuando el :orgId no es del usuario', () => {
    it('se queda sin permisos: PermissionsGuard devuelve 403 solo', async () => {
      const user = await resolver([DEVELOPER_REAL(), OWNER_PERSONAL()], { orgId: ORG_AJENA });

      expect(user.permissions).toEqual([]);
    });

    it('el comodín de su organización personal NO viaja a la ajena', async () => {
      // La escalada original, escrita como test: antes, con la personal en `[0]`, este mismo
      // request salía con `['*:*']` sobre una organización de la que no es miembro.
      const user = await resolver([OWNER_PERSONAL(), DEVELOPER_REAL()], { orgId: ORG_AJENA });

      expect(user.permissions).not.toContain('*:*');
      expect(user.permissions).toEqual([]);
    });

    it('una organización INEXISTENTE da el mismo resultado que una ajena: no filtra existencia', async () => {
      const ajena = await resolver([DEVELOPER_REAL(), OWNER_PERSONAL()], { orgId: ORG_AJENA });
      const inventada = await resolver([DEVELOPER_REAL(), OWNER_PERSONAL()], { orgId: 'no-existe' });

      expect(ajena.permissions).toEqual(inventada.permissions);
    });

    it('organizationIds sigue exponiendo las dos: acotar los permisos no es perder el resto', async () => {
      const user = await resolver([DEVELOPER_REAL(), OWNER_PERSONAL()], { orgId: ORG_AJENA });

      expect(user.organizationIds.sort()).toEqual([ORG_PERSONAL, ORG_REAL].sort());
    });
  });

  // ── La intersección: rutas que no dicen de qué organización hablan ────

  describe('ruta sin :orgId con más de una membership (intersección)', () => {
    it('el comodín NO gana: recorta contra el conjunto concreto', async () => {
      // `['*:*'] ∩ Developer` = Developer. Si acá saliera `['*:*']`, sería la UNION — o sea el
      // bug original, pero en las rutas sin orgId.
      const user = await resolver([OWNER_PERSONAL(), DEVELOPER_REAL()]);

      expect(user.permissions).toEqual(PERMISOS_DEVELOPER);
      expect(user.permissions).not.toContain('*:*');
    });

    it('entre dos roles concretos queda lo que comparten', async () => {
      const user = await resolver([
        membership('org-a', 'Developer', PERMISOS_DEVELOPER),
        membership('org-b', 'Soporte', PERMISOS_SOPORTE),
      ]);

      // Developer ∩ Soporte = lo que está en los dos.
      expect(user.permissions.sort()).toEqual(
        ['read:projects', 'manage:time-entries', 'manage:chat'].sort(),
      );
    });

    it('si TODAS son Owner, el resultado sigue siendo el comodín', async () => {
      // El par del primero: la intersección sólo puede quitar, pero no tiene que quitar de más.
      const user = await resolver([
        membership('org-a', 'Owner', ['*:*']),
        membership('org-b', 'Owner', ['*:*']),
      ]);

      expect(user.permissions).toEqual(['*:*']);
    });

    it('sin permisos en común, queda vacío', async () => {
      const user = await resolver([
        membership('org-a', 'Developer', ['manage:tasks']),
        membership('org-b', 'Cliente', ['read:projects']),
      ]);

      expect(user.permissions).toEqual([]);
    });
  });

  // ── El camino del 100% del tráfico de hoy ─────────────────────────────

  describe('una sola membership — el 100% del tráfico actual (F0 dio cero multi-org)', () => {
    it.each([
      ['sin :orgId en la ruta', {}],
      ['con su propio :orgId', { orgId: ORG_REAL }],
      ['con un :orgId ajeno', { orgId: ORG_AJENA }],
    ])('%s: sus permisos son los de siempre', async (caso, params) => {
      const user = await resolver([DEVELOPER_REAL()], params);

      // OJO: con una sola membership no se filtra por `:orgId`. Es deliberado — cambiarlo sería
      // meter tenencia en `AuthGuard`, y la tenencia es F2 (`OrgContextGuard`), que devuelve un
      // 403 explícito y también cubre las rutas sin `@Permissions`. F1b resuelve QUE permisos,
      // no SI la organización es tuya.
      expect([caso, user.permissions]).toEqual([caso, PERMISOS_DEVELOPER]);
      expect(user.organizationId).toBe(ORG_REAL);
    });

    it('un Owner con una sola membership conserva su comodín', async () => {
      const user = await resolver([membership(ORG_REAL, 'Owner', ['*:*'])]);

      expect(user.permissions).toEqual(['*:*']);
    });

    it('el rol Owner sin el permiso cargado igual recibe el comodín (atajo por nombre)', async () => {
      // Comportamiento preexistente que NO se tocó: `auth.guard.ts` deriva `*:*` del NOMBRE del
      // rol, no sólo de sus rolePermissions.
      const user = await resolver([membership(ORG_REAL, 'Owner', [])]);

      expect(user.permissions).toEqual(['*:*']);
    });
  });

  // ── Bordes ────────────────────────────────────────────────────────────

  it('sin ninguna membership: permisos vacíos, sin explotar', async () => {
    const user = await resolver([], { orgId: ORG_REAL });

    expect(user.permissions).toEqual([]);
    expect(user.organizationIds).toEqual([]);
    expect(user.organizationId).toBeUndefined();
  });

  it('un :orgId vacío se trata como ausente (cae a intersección, no a "ajena")', async () => {
    const user = await resolver([OWNER_PERSONAL(), DEVELOPER_REAL()], { orgId: '' });

    expect(user.permissions).toEqual(PERMISOS_DEVELOPER);
  });
});
