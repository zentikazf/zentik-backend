import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { AppException } from '../../../common/filters/app-exception';
import { ClientController } from '../client.controller';

/**
 * #65 T4 (R6.2) — UNA prueba por ruta, no una de muestra.
 *
 * El bug que estas pruebas existen para cazar no es "el permiso está mal elegido", es
 * **"la ruta no tiene decorador"**: `PermissionsGuard` devuelve `true` cuando el handler no
 * declara permisos (permissions.guard.ts:24). Ese fail-open es lo que dejaba 16 de las 17 rutas
 * de este controller —incluido el archivado de un cliente y el borrado de movimientos del
 * ledger— exigiendo nada más que una sesión válida.
 *
 * Por eso cada ruta lleva DOS aserciones, y las dos hacen falta:
 *
 *   1. `guard.canActivate(...)` con un permiso ajeno → 403.
 *   2. `Reflect.getMetadata(PERMISSIONS_KEY, handler)` es EXACTAMENTE el permiso esperado.
 *
 * La (1) sola daría un falso verde si alguien borra el decorador: sin metadata el guard
 * devuelve `true`, `canActivate` no lanza… y la aserción "no lanzó 403" habría que escribirla
 * al revés. La (2) sola no probaría que el guard efectivamente rechaza. Juntas fijan las dos
 * mitades: que el decorador está, y que hace lo que dice.
 *
 * No es un test de metadata muerta: corre el `PermissionsGuard` REAL con un `Reflector` REAL
 * contra los handlers REALES del controller. Verificado a mano borrando un decorador: el caso
 * de esa ruta se pone rojo por las dos aserciones a la vez.
 *
 * `SIN_PERMISO` es `read:boards` a propósito: no lo pide ninguna ruta de este controller y no
 * satisface a ninguna por el fallback `read:X → manage:X` del guard (permissions.guard.ts:45-51),
 * ni siquiera a la única que pide `read:projects`.
 */
describe('ClientController — permisos por ruta (#65 T4 / C1)', () => {
  const guard = new PermissionsGuard(new Reflector());

  /** Un permiso real del seed que no abre NINGUNA ruta de este controller. */
  const SIN_PERMISO = ['read:boards'];

  function ctx(permissions: string[], handler: unknown): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => ClientController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', permissions } }) }),
    } as unknown as ExecutionContext;
  }

  function capture(fn: () => unknown): AppException | null {
    try {
      fn();
      return null;
    } catch (e) {
      return e as AppException;
    }
  }

  // [ nombre legible, handler del controller, permiso que la ruta DEBE exigir ]
  const RUTAS: Array<[string, unknown, string]> = [
    ['POST   /                                    (crear cliente)', ClientController.prototype.create, 'manage:members'],
    ['GET    /                                    (listar clientes)', ClientController.prototype.findAll, 'read:projects'],
    ['GET    :clientId                            (detalle)', ClientController.prototype.findById, 'read:members'],
    ['PATCH  :clientId                            (editar, incluye tarifas e IVA)', ClientController.prototype.update, 'manage:members'],
    ['PATCH  :clientId/status                     (habilitar/deshabilitar)', ClientController.prototype.changeStatus, 'manage:members'],
    ['DELETE :clientId                            (archivar cliente)', ClientController.prototype.remove, 'manage:members'],
    ['POST   :clientId/create-user                (crear usuario de portal)', ClientController.prototype.createUser, 'manage:members'],
    ['PATCH  :clientId/portal                     (toggle portal)', ClientController.prototype.togglePortal, 'manage:members'],
    ['POST   :clientId/users                      (crear sub-usuario)', ClientController.prototype.createSubUser, 'manage:members'],
    ['GET    :clientId/users                      (listar sub-usuarios)', ClientController.prototype.listSubUsers, 'read:members'],
    ['DELETE :clientId/users/:userId              (borrar sub-usuario)', ClientController.prototype.deleteSubUser, 'manage:members'],
    ['POST   :clientId/users/:userId/resend-activation', ClientController.prototype.resendActivation, 'manage:members'],
    ['GET    :clientId/hours                      (ledger: tarifas y montos)', ClientController.prototype.getHoursSummary, 'read:billing'],
    ['POST   :clientId/hours                      (cargar horas)', ClientController.prototype.addHours, 'manage:projects'],
    ['POST   :clientId/hours/:txId/delete         (borrar movimiento)', ClientController.prototype.deleteHoursTransaction, 'manage:projects'],
    // La 16ª ya tenía decorador antes de #65. Va igual: si alguien lo saca, esto lo caza.
    ['POST   :clientId/hours/:txId/edit           (editar movimiento)', ClientController.prototype.editHoursTransaction, 'manage:projects'],
  ];

  describe.each(RUTAS)('%s', (_nombre, handler, permisoEsperado) => {
    it(`sin el permiso → 403 (requiere ${permisoEsperado})`, () => {
      const err = capture(() => guard.canActivate(ctx(SIN_PERMISO, handler)));

      expect(err).toBeInstanceOf(AppException);
      expect(err!.statusCode).toBe(403);
    });

    it(`declara exactamente ${permisoEsperado}`, () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler as object)).toEqual([permisoEsperado]);
    });

    it(`con ${permisoEsperado} → pasa`, () => {
      expect(guard.canActivate(ctx([permisoEsperado], handler))).toBe(true);
    });
  });

  describe('bordes del guard que estas rutas dependen de', () => {
    it('un usuario sin ningún permiso no entra a ninguna ruta', () => {
      for (const [nombre, handler] of RUTAS) {
        const err = capture(() => guard.canActivate(ctx([], handler)));
        expect([nombre, err?.statusCode]).toEqual([nombre, 403]);
      }
    });

    it('Owner (*:*) entra a todas', () => {
      for (const [nombre, handler] of RUTAS) {
        expect([nombre, guard.canActivate(ctx(['*:*'], handler))]).toEqual([nombre, true]);
      }
    });

    it('manage:members satisface a read:members por el fallback read→manage', () => {
      expect(guard.canActivate(ctx(['manage:members'], ClientController.prototype.findById))).toBe(true);
      expect(guard.canActivate(ctx(['manage:members'], ClientController.prototype.listSubUsers))).toBe(true);
    });

    it('manage:billing satisface a read:billing en el ledger de horas', () => {
      expect(guard.canActivate(ctx(['manage:billing'], ClientController.prototype.getHoursSummary))).toBe(true);
    });

    it('el fallback NO va al revés: read:members no abre una ruta de manage:members', () => {
      const err = capture(() => guard.canActivate(ctx(['read:members'], ClientController.prototype.remove)));
      expect(err).toBeInstanceOf(AppException);
      expect(err!.statusCode).toBe(403);
    });

    it('el rol Cliente (usuario del portal) no llega al ledger de horas', () => {
      // `ensureClienteRole` (client.service.ts:1410) le da read:projects + read:tasks. Por eso el
      // ledger pide read:billing y no read:projects: con read:projects este caso pasaría.
      const err = capture(() =>
        guard.canActivate(ctx(['read:projects', 'read:tasks'], ClientController.prototype.getHoursSummary)),
      );
      expect(err).toBeInstanceOf(AppException);
      expect(err!.statusCode).toBe(403);
    });

    it('borrar y editar un movimiento del ledger piden lo mismo (no hay puerta más barata)', () => {
      const del = Reflect.getMetadata(PERMISSIONS_KEY, ClientController.prototype.deleteHoursTransaction);
      const edit = Reflect.getMetadata(PERMISSIONS_KEY, ClientController.prototype.editHoursTransaction);
      expect(del).toEqual(edit);
    });

    it('archivar un cliente pide lo mismo que cambiarle el estado (comparten implementación)', () => {
      // `remove` es `changeStatus(..., 'ARCHIVED')` (client.controller.ts). Con permisos distintos,
      // el DELETE sería un bypass del PATCH.
      const del = Reflect.getMetadata(PERMISSIONS_KEY, ClientController.prototype.remove);
      const patch = Reflect.getMetadata(PERMISSIONS_KEY, ClientController.prototype.changeStatus);
      expect(del).toEqual(patch);
    });

    it('el tombstone de sync sigue SIN permiso, a propósito (410 explicativo, no 403 mudo)', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, ClientController.prototype.syncHours)).toBeUndefined();
    });
  });
});

/**
 * #65 T4 (R6.2 / C2.1) — el actor del borrado sale de la SESIÓN, no del body.
 *
 * Antes la firma era `@Body() body: { reason: string; deletedById: string }` y el service
 * recibía `body.deletedById` tal cual: quien llamaba al endpoint elegía a nombre de quién
 * quedaba registrado el borrado. `deleteHoursTransaction` escribe ese id en `deleted_by_id` y
 * en la auditoría, así que el único rastro de quién sacó horas de una factura era un dato que
 * el propio autor podía falsificar.
 *
 * Se testea el controller directo (con el service mockeado) porque el bug vivía exactamente
 * ahí: en qué argumento se le pasa al service.
 */
describe('ClientController — el actor del borrado de horas (#65 T4 / C2.1)', () => {
  const service = { deleteHoursTransaction: jest.fn() };
  const controller = new ClientController(service as never);

  const sesion = { id: 'user-de-la-sesion', email: 'admin@zentik.io' };

  beforeEach(() => service.deleteHoursTransaction.mockReset());

  it('ignora el deletedById del body y usa el usuario de la sesión', () => {
    controller.deleteHoursTransaction(
      'org-1',
      'client-1',
      'tx-1',
      { reason: 'cargado sobre el ticket equivocado', deletedById: 'otra-persona' },
      sesion as never,
    );

    expect(service.deleteHoursTransaction).toHaveBeenCalledWith(
      'org-1',
      'client-1',
      'tx-1',
      'user-de-la-sesion', // ← NO 'otra-persona'
      'cargado sobre el ticket equivocado',
    );
  });

  it('sin deletedById en el body funciona igual (el frontend nuevo ya no lo manda)', () => {
    controller.deleteHoursTransaction(
      'org-1',
      'client-1',
      'tx-1',
      { reason: 'motivo' },
      sesion as never,
    );

    expect(service.deleteHoursTransaction).toHaveBeenCalledWith(
      'org-1',
      'client-1',
      'tx-1',
      'user-de-la-sesion',
      'motivo',
    );
  });
});

/**
 * #65 (review) — TENENCIA del recurso en las rutas de sub-usuarios.
 *
 * Casi todos los métodos de `ClientService` arrancan con `findById(orgId, clientId)`, que filtra
 * `{ id: clientId, organizationId: orgId }` y tira 404 si el cliente no es de esa organización.
 * Tres NO lo hacían: `listSubUsers` (que ni siquiera recibía `orgId`), `deleteSubUser` y
 * `resendActivation`. Ahí el par `(clientId, userId)` nunca se comparaba contra la org de la URL.
 *
 * `deleteSubUser` es un `user.delete` DURO —borra usuario, cuentas y sesiones—, así que cualquiera
 * con `manage:members` en su propia organización podía borrar físicamente al usuario de portal de
 * un cliente de otro tenant con sólo conocer los dos ids.
 *
 * El `OrgMembershipGuard` del backlog NO habría cubierto esto: ése valida usuario→organización, y
 * acá el atacante es miembro legítimo de la organización que escribe en la URL. Es el otro eje —
 * la tenencia del RECURSO.
 */
describe('ClientService — tenencia en las rutas de sub-usuarios (#65 review)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mockDeep } = require('jest-mock-extended');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ClientService } = require('../client.service');

  const ORG = 'org-propia';
  const CLIENT_AJENO = 'client-de-otra-org';

  function makeService() {
    const prisma = mockDeep();
    const service = new ClientService(prisma, mockDeep(), mockDeep(), mockDeep());
    // findById: el cliente NO pertenece a esta organización.
    prisma.client.findFirst.mockResolvedValue(null);
    return { prisma, service };
  }

  it('listSubUsers de un cliente de otra org → 404, sin leer un solo usuario', async () => {
    const { prisma, service } = makeService();

    await expect(service.listSubUsers(ORG, CLIENT_AJENO)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('deleteSubUser de un cliente de otra org → 404, sin borrar NADA', async () => {
    const { prisma, service } = makeService();

    await expect(
      service.deleteSubUser(ORG, CLIENT_AJENO, 'user-ajeno'),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Fail-closed: ni siquiera se busca el usuario, y el $transaction del borrado duro no corre.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('resendActivation de un cliente de otra org → 404, sin mandar ningún mail', async () => {
    const { prisma, service } = makeService();

    await expect(
      service.resendActivation(ORG, CLIENT_AJENO, 'user-ajeno'),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
