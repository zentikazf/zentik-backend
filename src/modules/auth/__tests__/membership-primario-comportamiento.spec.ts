import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import { AppConfigService } from '../../../config/app.config';

/**
 * #68 F1 — el mismo cambio que `membership-primario-determinista.spec.ts`, pero probado por
 * COMPORTAMIENTO y no leyendo el fuente.
 *
 * Los dos hacen falta y prueban cosas distintas: aquel fija la INTENCION (que el orden sea `desc`
 * y no `asc`, que es la decisión de diseño); éste fija el EFECTO — que el `orderBy` efectivamente
 * cruce hacia Prisma y que el membership primario salga de ahí. Un `orderBy` escrito en el lugar
 * equivocado del `select` pasaría el test de texto y fallaría éste.
 *
 * El caso central es el que da nombre al bug: un usuario con dos memberships, `Owner` en su
 * organización personal y `Developer` en la real. Antes, cuál de las dos mandaba dependía del
 * orden físico de las filas en Postgres.
 */
describe('#68 F1 — comportamiento del membership primario', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let config: DeepMockProxy<AppConfigService>;
  let guard: AuthGuard;

  const ORG_PERSONAL = 'org-personal';
  const ORG_REAL = 'org-real';

  /** Una membership como la devuelve el include del guard. */
  const membership = (organizationId: string, roleName: string, permisos: string[]) => ({
    organizationId,
    roleId: `role-${roleName}`,
    role: {
      name: roleName,
      rolePermissions: permisos.map((p) => {
        const [action, resource] = p.split(':');
        return { permission: { action, resource } };
      }),
    },
  });

  /** El guard escribe el usuario resuelto en `request.user`. Esto lo devuelve. */
  async function usuarioResuelto(memberships: unknown[]) {
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer tok' },
      path: '/organizations/org-real/clients',
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
      permissions?: string[];
    };
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    config = mockDeep<AppConfigService>();
    guard = new AuthGuard(prisma, config);
    prisma.session.update.mockResolvedValue({} as never);
  });

  // ── El orderBy llega de verdad a Prisma ───────────────────────────────

  it('el include pide las memberships ordenadas por createdAt desc', async () => {
    await usuarioResuelto([membership(ORG_REAL, 'Developer', ['read:projects'])]);

    const args = prisma.session.findFirst.mock.calls.at(-1)![0] as {
      select?: Record<string, any>;
      include?: Record<string, any>;
    };
    const miembros =
      (args.include ?? args.select)?.user?.select?.organizationMembers ??
      (args.include ?? args.select)?.user?.include?.organizationMembers;

    // Si esto es undefined, la forma del query cambió y todo lo de abajo sería un falso verde.
    expect(miembros).toBeDefined();
    expect(miembros.orderBy).toEqual([{ createdAt: 'desc' }, { organizationId: 'asc' }]);
  });

  // ── El caso que da nombre al bug ──────────────────────────────────────

  describe('usuario con Owner en su org personal y Developer en la org real', () => {
    const personal = () => membership(ORG_PERSONAL, 'Owner', ['*:*']);
    const real = () => membership(ORG_REAL, 'Developer', ['read:projects', 'manage:tasks']);

    it('con la org real primera: se evalúa como Developer, sin comodín', async () => {
      const user = await usuarioResuelto([real(), personal()]);

      expect(user.roleName).toBe('Developer');
      expect(user.permissions).not.toContain('*:*');
      expect(user.organizationId).toBe(ORG_REAL);
    });

    it('las DOS organizaciones siguen expuestas en organizationIds', async () => {
      // El par del test de arriba. Acotar el membership primario no puede significar perder el
      // resto: `organizationIds` es lo que #15 dejó para el scoping multi-tenant, y F2 lo usa.
      const user = await usuarioResuelto([real(), personal()]);

      expect(user.organizationIds.sort()).toEqual([ORG_PERSONAL, ORG_REAL].sort());
    });

    it('el comodín de Owner sigue funcionando cuando ESA es la organización primaria', async () => {
      // No se rompió el atajo: un Owner de verdad sigue teniendo `*:*`. Sin este caso, los de
      // arriba pasarían igual con el comodín eliminado por completo.
      const user = await usuarioResuelto([personal()]);

      expect(user.permissions).toEqual(['*:*']);
      expect(user.roleName).toBe('Owner');
    });
  });

  // ── El caso real de hoy: una sola membership ──────────────────────────

  it('con una sola membership, nada cambió: sus permisos son los de siempre', async () => {
    // El diagnóstico F0 contra producción dio CERO usuarios con más de una membership, o sea que
    // ESTE es el camino que recorre el 100% del tráfico actual. Tiene que estar intacto.
    const user = await usuarioResuelto([
      membership(ORG_REAL, 'Soporte', ['read:projects', 'read:tasks', 'manage:time-entries']),
    ]);

    expect(user.permissions).toEqual(['read:projects', 'read:tasks', 'manage:time-entries']);
    expect(user.organizationId).toBe(ORG_REAL);
    expect(user.organizationIds).toEqual([ORG_REAL]);
  });

  it('sin ninguna membership no explota: permisos vacíos', async () => {
    const user = await usuarioResuelto([]);

    expect(user.permissions).toEqual([]);
    expect(user.organizationIds).toEqual([]);
    expect(user.organizationId).toBeUndefined();
  });
});
