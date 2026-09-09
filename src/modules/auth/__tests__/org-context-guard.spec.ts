import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import { AppConfigService } from '../../../config/app.config';
import { AppException } from '../../../common/filters/app-exception';

/**
 * #69 — el candado de tenencia.
 *
 * QUE CIERRA. #68 F1b hizo que los permisos salgan de la organización de la URL, pero el 403 lo
 * terminaba dando `PermissionsGuard` al ver el array vacío. Eso sólo alcanza para las rutas que
 * declaran `@Permissions`: **176 de las 302 del repo no declaran ninguna**, y para ésas
 * `permissions.guard.ts:24` devuelve `true` sin mirar nada. El caso más fuerte es
 * `ticket.controller.ts` — 22 rutas, 17 con `:orgId`, y ni siquiera monta `PermissionsGuard`.
 *
 * #69 mueve el 403 a `AuthGuard`, antes de que la pregunta de permisos exista, y le enseña a
 * resolver la organización desde el RECURSO cuando la URL no la trae.
 *
 * EL ATAJO QUE HACE QUE ESTO SEA GRATIS: con una sola membership no hay ambigüedad que resolver,
 * así que no se consulta nada. F0 dio cero usuarios multi-organización en producción, o sea que
 * hoy el 100% del tráfico no paga ni una query. Varios casos de acá cuentan las llamadas al mock
 * justamente para fijar eso.
 */
describe('#69 — candado de tenencia en AuthGuard', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let guard: AuthGuard;

  const ORG_A = 'org-a';
  const ORG_B = 'org-b';
  const AJENA = 'org-de-otro';

  const PERMS_DEV = ['read:projects', 'manage:tasks'];
  const PERMS_SOPORTE = ['read:projects', 'read:tasks'];

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

  const DEV_A = () => membership(ORG_A, 'Developer', PERMS_DEV);
  const OWNER_B = () => membership(ORG_B, 'Owner', ['*:*']);

  async function correr(
    memberships: unknown[],
    params: Record<string, string> = {},
    path = '/organizations/x/clients',
  ) {
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer tok' },
      path,
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
    return request.user as { organizationId?: string; permissions: string[]; roleName?: string };
  }

  const esperar403 = async (
    memberships: unknown[],
    params: Record<string, string> = {},
    path?: string,
  ) => {
    const err = await correr(memberships, params, path).catch((e) => e);

    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).statusCode).toBe(403);
    return err as AppException;
  };

  /** Llamadas a `findUnique` en cualquier modelo — para verificar el atajo. */
  const consultasDeResolucion = () =>
    Object.values(
      prisma as unknown as Record<string, { findUnique?: { mock?: { calls: unknown[] } } }>,
    ).reduce((n, d) => n + (d?.findUnique?.mock?.calls.length ?? 0), 0);

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    guard = new AuthGuard(prisma, mockDeep<AppConfigService>());
    prisma.session.update.mockResolvedValue({} as never);
  });

  // ── R4.1 / R4.2 — el candado por :orgId, con su par ───────────────────

  it('R4.1 — organización ajena en la URL ⇒ 403, sin importar si la ruta pide permisos', async () => {
    await esperar403([DEV_A()], { orgId: AJENA });
  });

  it('R4.2 — organización propia ⇒ pasa, con los permisos DE ESA organización', async () => {
    // El par de R4.1: sin este caso, aquel pasaría igual con el guard rechazando a todo el mundo.
    const user = await correr([DEV_A(), OWNER_B()], { orgId: ORG_A });

    expect(user.permissions).toEqual(PERMS_DEV);
    expect(user.organizationId).toBe(ORG_A);
  });

  it('la otra organización del mismo usuario también pasa, con SUS permisos', async () => {
    const user = await correr([DEV_A(), OWNER_B()], { orgId: ORG_B });

    expect(user.permissions).toEqual(['*:*']);
    expect(user.organizationId).toBe(ORG_B);
  });

  // ── R4.3 — resolución por recurso ─────────────────────────────────────

  describe('R4.3 — ruta SIN :orgId: la organización sale del recurso', () => {
    it('recurso de una organización suya ⇒ pasa con los permisos de esa', async () => {
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: ORG_A } } as never);

      const user = await correr([DEV_A(), OWNER_B()], { taskId: 't-1' }, '/tasks/t-1');

      expect(user.permissions).toEqual(PERMS_DEV);
      expect(consultasDeResolucion()).toBe(1);
    });

    it('recurso de una organización AJENA ⇒ 403', async () => {
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: AJENA } } as never);

      await esperar403([DEV_A(), OWNER_B()], { taskId: 't-1' }, '/tasks/t-1');
    });

    it('R4.6 — recurso INEXISTENTE ⇒ el mismo 403 que uno ajeno', async () => {
      prisma.task.findUnique.mockResolvedValue(null as never);
      const inexistente = await esperar403([DEV_A(), OWNER_B()], { taskId: 'no-existe' }, '/tasks/x');

      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: AJENA } } as never);
      const ajeno = await esperar403([DEV_A(), OWNER_B()], { taskId: 't-1' }, '/tasks/t-1');

      // Si los mensajes difirieran, la respuesta serviría para saber qué IDs existen.
      expect(inexistente.message).toEqual(ajeno.message);
    });

    it('un proyecto se resuelve directo, sin pasar por otro modelo', async () => {
      prisma.project.findUnique.mockResolvedValue({ organizationId: ORG_B } as never);

      const user = await correr([DEV_A(), OWNER_B()], { projectId: 'p-1' }, '/projects/p-1/files');

      expect(user.permissions).toEqual(['*:*']);
    });
  });

  // ── R4.5 — el caso de #68, ahora en una ruta sin :orgId ───────────────

  describe('R4.5 — Owner en la personal + Developer en la real, en una ruta SIN :orgId', () => {
    it.each([
      ['la real primero', () => [DEV_A(), OWNER_B()]],
      ['la personal primero', () => [OWNER_B(), DEV_A()]],
    ])('un recurso de la organización real se evalúa como Developer (%s)', async (_o, ms) => {
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: ORG_A } } as never);

      const user = await correr(ms(), { taskId: 't-1' }, '/tasks/t-1');

      // Antes de #69 esto caía a la intersección; antes de #68 F1b, al comodín de la personal.
      expect(user.permissions).toEqual(PERMS_DEV);
      expect(user.permissions).not.toContain('*:*');
    });

    it('y un recurso de la organización personal sí da el comodín', async () => {
      // El par: el atajo de Owner sigue vivo donde corresponde.
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: ORG_B } } as never);

      const user = await correr([DEV_A(), OWNER_B()], { taskId: 't-2' }, '/tasks/t-2');

      expect(user.permissions).toEqual(['*:*']);
    });
  });

  // ── R4.4 — el atajo: hoy no se paga ni una consulta ───────────────────

  describe('R4.4 — con UNA sola membership no se consulta nada', () => {
    it.each([
      ['ruta con su propio :orgId', { orgId: ORG_A }, '/organizations/org-a/clients'],
      ['ruta sin :orgId, con recurso', { taskId: 't-1' }, '/tasks/t-1'],
      ['ruta sin params', {}, '/algo'],
    ])('%s ⇒ cero consultas de resolución', async (_caso, params, path) => {
      const user = await correr([DEV_A()], params, path);

      expect(consultasDeResolucion()).toBe(0);
      expect(user.permissions).toEqual(PERMS_DEV);
    });

    it('pero el candado por :orgId SIGUE aplicando con una sola membership', async () => {
      // El par del anterior: "no consultar" no puede significar "no validar". Éste era
      // exactamente el agujero que F1b dejó abierto.
      await esperar403([DEV_A()], { orgId: AJENA });
    });
  });

  // ── Las rutas exentas ─────────────────────────────────────────────────

  describe('rutas exentas: el guard no interfiere', () => {
    it.each([
      ['/portal/tickets/t-1', { ticketId: 't-1' }],
      ['/users/me/tasks', {}],
      ['/notifications', {}],
    ])('%s pasa aunque los params apunten a otro lado', async (path, params) => {
      const user = await correr([DEV_A()], params, path);

      expect(user.permissions).toEqual(PERMS_DEV);
      expect(consultasDeResolucion()).toBe(0);
    });

    it('el portal NO recibe 403 aunque mande un orgId ajeno', async () => {
      // Es la razón por la que `/portal` está exento: tiene scoping propio por `clientId`.
      // Sin la exención, #69 rompería el portal entero de golpe.
      const user = await correr([DEV_A()], { orgId: AJENA }, '/portal/hours');

      expect(user.permissions).toEqual(PERMS_DEV);
    });
  });

  // ── Cuando no hay nada que resolver ───────────────────────────────────

  describe('sin organización determinable', () => {
    it('multi-membership y ningún param conocido ⇒ intersección, sin 403', async () => {
      const user = await correr(
        [membership(ORG_A, 'Developer', PERMS_DEV), membership(ORG_B, 'Soporte', PERMS_SOPORTE)],
        {},
        '/algo/raro',
      );

      // Developer ∩ Soporte = read:projects. Es la rama de F1b, que #69 conserva: no hay
      // organización contra la cual validar, así que se afirma lo mínimo en vez de bloquear.
      expect(user.permissions).toEqual(['read:projects']);
      expect(consultasDeResolucion()).toBe(0);
    });

    it('sin ninguna membership ⇒ permisos vacíos, sin explotar', async () => {
      const user = await correr([], { orgId: ORG_A });

      expect(user.permissions).toEqual([]);
    });
  });
});
