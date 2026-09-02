import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { AppException } from '../../../common/filters/app-exception';
import { TaskController } from '../task.controller';

/**
 * #66 T1.2 — `GET projects/:projectId/available-hours` pedía `view:tasks`, un permiso INEXISTENTE.
 *
 * El mecanismo del bug: `PermissionsGuard` no valida que el permiso exigido exista en el
 * catálogo. Sólo compara strings, con un único fallback: `read:X` se satisface con `manage:X`
 * (permissions.guard.ts:44-53). Un permiso inventado no matchea nada ⇒ la ruta la pasaba
 * SÓLO el comodín `*:*`, o sea únicamente Owner. Y el consumidor
 * (`zentik/src/components/task/task-detail-content.tsx:162`) la come con `.catch(() => {})`,
 * así que el resto del staff veía la pantalla sin el bloque de horas y sin ningún error.
 *
 * Este archivo fija las dos mitades del fix:
 *   - el CAMINO NUEVO: `read:tasks` y `manage:tasks` entran;
 *   - el CAMINO VIEJO: sin ninguno de los dos, sigue habiendo 403.
 * Un assert de "ahora pasa" sin su assert de "sin permiso no pasa" no probaría nada: si alguien
 * borra el decorador, el guard devuelve `true` por el fail-open de `permissions.guard.ts:24` y
 * la primera mitad quedaría verde sobre una ruta abierta de par en par.
 */
describe('TaskController — permiso de available-hours (#66)', () => {
  const guard = new PermissionsGuard(new Reflector());

  const handler = TaskController.prototype.getAvailableHours;

  function ctx(permissions: string[]): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => TaskController,
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

  it('declara exactamente read:tasks — y NO el inexistente view:tasks', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler as object)).toEqual(['read:tasks']);
  });

  it('camino nuevo: read:tasks entra', () => {
    expect(guard.canActivate(ctx(['read:tasks']))).toBe(true);
  });

  it('camino nuevo derivado: manage:tasks entra por el fallback read→manage', () => {
    expect(guard.canActivate(ctx(['manage:tasks']))).toBe(true);
  });

  it('camino viejo: sin read:tasks ni manage:tasks sigue habiendo 403', () => {
    const err = capture(() => guard.canActivate(ctx(['read:boards', 'read:sprints'])));

    expect(err).toBeInstanceOf(AppException);
    expect(err!.statusCode).toBe(403);
  });

  it('sin ningún permiso: 403', () => {
    const err = capture(() => guard.canActivate(ctx([])));

    expect(err).toBeInstanceOf(AppException);
    expect(err!.statusCode).toBe(403);
  });

  it('Owner (*:*) entra, como entraba antes del fix', () => {
    expect(guard.canActivate(ctx(['*:*']))).toBe(true);
  });

  /**
   * La regresión exacta. Estos son los roles reales de `organization.service.ts:71-82` que
   * cargan horas y necesitan ver el saldo del cliente: NINGUNO tiene `read:members`, y con
   * `view:tasks` los seis comían 403 en silencio.
   */
  it.each([
    ['Tech Lead', ['read:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:time-entries', 'read:members', 'manage:chat']],
    ['Developer', ['read:projects', 'manage:tasks', 'read:sprints', 'read:boards', 'manage:time-entries', 'manage:chat']],
    ['QA Engineer', ['read:projects', 'manage:tasks', 'read:sprints', 'read:boards', 'manage:time-entries', 'manage:chat']],
    ['Designer', ['read:projects', 'manage:tasks', 'read:boards', 'manage:time-entries', 'manage:chat']],
    ['DevOps', ['read:projects', 'read:tasks', 'read:sprints', 'manage:time-entries', 'manage:chat']],
    ['Soporte', ['read:projects', 'read:tasks', 'manage:time-entries', 'manage:chat']],
  ])('el rol %s ahora ve las horas disponibles (antes: 403 mudo)', (_rol, permisos) => {
    expect(guard.canActivate(ctx(permisos))).toBe(true);
  });

  it('un permiso inventado NO lo satisface nadie salvo *:* — el mecanismo del bug', () => {
    // Se reproduce con un handler ficticio para no depender de que la ruta rota siga existiendo.
    const roto = function inventado() {};
    Reflect.defineMetadata(PERMISSIONS_KEY, ['view:tasks'], roto);

    const ctxRoto = (permissions: string[]) =>
      ({
        getHandler: () => roto,
        getClass: () => TaskController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', permissions } }) }),
      }) as unknown as ExecutionContext;

    // Ni el permiso más fuerte del recurso lo abre: no hay derivación hacia un permiso que no existe.
    expect(capture(() => guard.canActivate(ctxRoto(['manage:tasks'])))!.statusCode).toBe(403);
    expect(capture(() => guard.canActivate(ctxRoto(['read:tasks'])))!.statusCode).toBe(403);
    expect(guard.canActivate(ctxRoto(['*:*']))).toBe(true);
  });
});
