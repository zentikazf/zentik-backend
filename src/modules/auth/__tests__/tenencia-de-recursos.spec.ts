import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import { AppConfigService } from '../../../config/app.config';
import { AppException } from '../../../common/filters/app-exception';

/**
 * #70 — el eje recurso → organización.
 *
 * QUE CIERRA. #69 valida *usuario → organización*: "¿esta organización es tuya?". Pero
 * `org-context.resolver.ts` corta apenas ve `orgId` —correcto para RESOLVER, la URL ya lo dijo— y
 * entonces el recurso no se mira nunca. Eso deja el ataque:
 *
 *     sos miembro de A  →  ponés orgId=A (legítimo)  →  pedís el cliente 123, que es de B
 *     #69: ✅ sos miembro de A                        →  hoy: te lo devuelve
 *
 * Son **43 rutas** de 215 con id: las de `client`, `client-billing`, `botmaker-billing`,
 * `sla-config` y una de `ticket`. Las otras 172 ya las cerró #69 — las que NO traen `:orgId`
 * resuelven por recurso, y eso ya ES tenencia de recurso.
 *
 * Por eso #70 no son "210 fixes en 35 services": es una regla cruzada en el guard.
 */
describe('#70 — el recurso tiene que ser de la organización de la URL', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let guard: AuthGuard;

  const MI_ORG = 'org-mia';
  const OTRA = 'org-de-otro';
  const PERMS = ['read:projects', 'manage:members'];

  const membership = (organizationId: string) => ({
    organizationId,
    roleId: `role-${organizationId}`,
    role: {
      name: 'Project Manager',
      rolePermissions: PERMS.map((p) => {
        const [action, resource] = p.split(':');
        return { permission: { action, resource } };
      }),
    },
  });

  async function correr(params: Record<string, string>, path = '/organizations/org-mia/clients/c-1') {
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
        email: 'pm@zentik.test',
        name: 'PM',
        emailVerified: true,
        clientId: null,
        organizationMembers: [membership(MI_ORG)],
      },
    } as never);

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ cookie: () => {} }),
      }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    return request.user as { permissions: string[]; organizationId?: string };
  }

  const esperar403 = async (params: Record<string, string>, path?: string) => {
    const err = await correr(params, path).catch((e) => e);

    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).statusCode).toBe(403);
    return err as AppException;
  };

  const consultas = () =>
    Object.values(
      prisma as unknown as Record<string, { findUnique?: { mock?: { calls: unknown[] } } }>,
    ).reduce((n, d) => n + (d?.findUnique?.mock?.calls.length ?? 0), 0);

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    guard = new AuthGuard(prisma, mockDeep<AppConfigService>());
    prisma.session.update.mockResolvedValue({} as never);
  });

  // ── El ataque que cierra, y su par ────────────────────────────────────

  it('R3.1 — mi organización en la URL + un cliente de OTRA ⇒ 403', async () => {
    prisma.client.findUnique.mockResolvedValue({ organizationId: OTRA } as never);

    await esperar403({ orgId: MI_ORG, clientId: 'c-de-otro' });
  });

  it('R3.2 — mi organización + un cliente MIO ⇒ pasa, con mis permisos', async () => {
    // El par de R3.1. Sin este caso, aquel pasaría igual con la regla rechazando todo — y
    // habríamos roto las 43 rutas de clientes y facturación de una.
    prisma.client.findUnique.mockResolvedValue({ organizationId: MI_ORG } as never);

    const user = await correr({ orgId: MI_ORG, clientId: 'c-mio' });

    expect(user.permissions).toEqual(PERMS);
    expect(user.organizationId).toBe(MI_ORG);
  });

  // ── Un caso por cada param real de las 43 rutas ───────────────────────

  describe('los tres params que aparecen en esas rutas', () => {
    it.each([
      ['clientId', 'client', 'client.controller.ts (16) + client-billing (14) + botmaker (5)'],
      ['projectId', 'project', 'sla-config.controller.ts'],
      ['ticketId', 'ticket', 'ticket.controller.ts'],
    ])('%s ajeno ⇒ 403 (%s)', async (param, modelo, _donde) => {
      const delegate = (prisma as unknown as Record<string, { findUnique: jest.Mock }>)[modelo];
      delegate.findUnique.mockResolvedValue({ organizationId: OTRA } as never);

      await esperar403({ orgId: MI_ORG, [param]: 'r-1' });
    });

    it.each([
      ['clientId', 'client'],
      ['projectId', 'project'],
      ['ticketId', 'ticket'],
    ])('%s propio ⇒ pasa', async (param, modelo) => {
      const delegate = (prisma as unknown as Record<string, { findUnique: jest.Mock }>)[modelo];
      delegate.findUnique.mockResolvedValue({ organizationId: MI_ORG } as never);

      const user = await correr({ orgId: MI_ORG, [param]: 'r-1' });

      expect(user.permissions).toEqual(PERMS);
    });
  });

  // ── No filtrar existencia ─────────────────────────────────────────────

  it('R3.3 — recurso INEXISTENTE da el mismo 403 que uno ajeno', async () => {
    prisma.client.findUnique.mockResolvedValue(null as never);
    const inexistente = await esperar403({ orgId: MI_ORG, clientId: 'no-existe' });

    prisma.client.findUnique.mockResolvedValue({ organizationId: OTRA } as never);
    const ajeno = await esperar403({ orgId: MI_ORG, clientId: 'c-de-otro' });

    expect(inexistente.message).toEqual(ajeno.message);
  });

  it('R3.4 — y el mismo 403 que una ORGANIZACION ajena (#69)', async () => {
    // Los cuatro caminos de tenencia tienen que ser indistinguibles: organización ajena,
    // organización inexistente, recurso ajeno, recurso inexistente.
    const orgAjena = await esperar403({ orgId: OTRA });

    prisma.client.findUnique.mockResolvedValue({ organizationId: OTRA } as never);
    const recursoAjeno = await esperar403({ orgId: MI_ORG, clientId: 'c-1' });

    expect(orgAjena.message).toEqual(recursoAjeno.message);
    expect(orgAjena.statusCode).toEqual(recursoAjeno.statusCode);
  });

  it('una relación rota tampoco pasa', async () => {
    prisma.task.findUnique.mockResolvedValue({ project: null } as never);

    await esperar403({ orgId: MI_ORG, taskId: 't-1' });
  });

  // ── El orden de las dos preguntas ─────────────────────────────────────

  it('con una organización ajena NO se llega a consultar el recurso', async () => {
    // El orden importa: primero la membresía, después el recurso. Al revés, un no-miembro podría
    // deducir por el comportamiento si el recurso existe.
    await esperar403({ orgId: OTRA, clientId: 'c-1' });

    expect(consultas()).toBe(0);
  });

  // ── Lo que NO cambió ──────────────────────────────────────────────────

  it('R3.6 — con :orgId y SIN param de recurso: cero consultas', async () => {
    const user = await correr({ orgId: MI_ORG }, '/organizations/org-mia/members');

    expect(consultas()).toBe(0);
    expect(user.permissions).toEqual(PERMS);
  });

  it('R3.5 — una ruta sin :orgId sigue resolviendo como en #69', async () => {
    // Con una sola membership, #69 ni consulta: esa es su organización. #70 no lo toca.
    const user = await correr({ taskId: 't-1' }, '/tasks/t-1');

    expect(consultas()).toBe(0);
    expect(user.permissions).toEqual(PERMS);
  });

  it('R3.7 — una ruta exenta no interfiere ni consulta', async () => {
    const user = await correr({ orgId: OTRA, clientId: 'c-1' }, '/portal/hours');

    expect(consultas()).toBe(0);
    expect(user.permissions).toEqual(PERMS);
  });

  it('la tenencia del recurso NO depende de cuántas organizaciones tenga el usuario', async () => {
    // Este usuario tiene UNA sola membership y el candado aplica igual. La tenencia del recurso es
    // un eje independiente del multi-organización.
    prisma.client.findUnique.mockResolvedValue({ organizationId: OTRA } as never);

    await esperar403({ orgId: MI_ORG, clientId: 'c-1' });
    expect(consultas()).toBe(1);
  });
});
