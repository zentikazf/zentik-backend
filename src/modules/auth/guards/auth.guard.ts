import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PrismaService } from '../../../database/prisma.service';
import { AppConfigService } from '../../../config/app.config';
import {
  AppException,
  ForbiddenException,
  UnauthorizedException,
} from '../../../common/filters/app-exception';
import { AuthenticatedUser } from '../../../common/interfaces/request.interface';
import { estaExento, resolverOrganizacion } from '../org-context.resolver';

const SESSION_TTL_HOURS = 5;
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
const SESSION_COOKIE = 'zentik.session_token';
// Nombre __Host- para el modo same-site (host-only). El re-set del sliding session
// DEBE usar el mismo nombre/flags que AuthController.setSessionCookie.
const SESSION_COOKIE_HOST = '__Host-zentik.session_token';

// Endpoints permitidos para usuarios con emailVerified=false. El resto se
// bloquea con 403 EMAIL_NOT_VERIFIED — el frontend redirige a /verify-pending.
const ALLOWED_PATHS_UNVERIFIED = [
  '/auth/verify-email',
  '/auth/resend-verification',
  '/auth/logout',
  '/auth/me',
];

/**
 * #68 F1b — La forma de una membership tal como la trae el `include` de `canActivate`.
 *
 * Se declara acá y no se importa de `@prisma/client` a propósito: lo que importa no es el modelo
 * completo, son los tres campos que la resolución de permisos necesita. Si el `select` del
 * include cambia, TypeScript rompe acá y no en runtime.
 */
interface MembershipCargada {
  organizationId: string;
  roleId: string;
  role: {
    name: string;
    rolePermissions: { permission: { action: string; resource: string } }[];
  } | null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const sessionToken = this.extractSessionToken(request);

    if (!sessionToken) {
      throw new UnauthorizedException('No se encontro un token de sesion valido');
    }

    try {
      const session = await this.prisma.session.findFirst({
        where: {
          token: sessionToken,
          expiresAt: { gt: new Date() },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              emailVerified: true,
              clientId: true,
              organizationMembers: {
                select: {
                  organizationId: true,
                  roleId: true,
                  role: {
                    select: {
                      name: true,
                      rolePermissions: {
                        select: {
                          permission: {
                            select: { action: true, resource: true },
                          },
                        },
                      },
                    },
                  },
                },
                // Feature #15 — cargar TODAS las memberships (sin take:1) para
                // poder exponer organizationIds[] al MCP y a cualquier modulo
                // que necesite scoping multi-tenant. El "membership primario"
                // (compat backwards) es el primer elemento.
                //
                // #68 F1 — ORDEN EXPLICITO. Sin este `orderBy`, Postgres devolvia las filas en
                // orden FISICO, que cambia con cualquier UPDATE sobre organization_members. O sea
                // que `[0]` —de donde salen los permisos de TODA la request, ver :99-108— era una
                // membership distinta segun el dia.
                //
                // POR QUE `desc` Y NO `asc`: la organizacion PERSONAL que `auth.service.ts:68-72`
                // le crea a cada registrado es, por construccion, la MAS ANTIGUA de ese usuario
                // (nace en el registro, antes de cualquier invitacion). Con `asc` esa org ganaria
                // SIEMPRE — y como ahi el usuario es Owner (organization.service.ts:95-104), el
                // atajo de :106-108 le pondria `*:*` en cada request contra la organizacion real.
                // `asc` no seria "determinista": seria determinISTAMENTE el peor caso. Con `desc`
                // gana la membership mas reciente, que es la organizacion a la que lo invitaron.
                //
                // ⚠️ EL orderBy POR SI SOLO NO ARREGLABA NADA: solo volvia predecible una eleccion
                // que no debia existir. Lo resolvio #68 F1b (los permisos salen de la organizacion
                // de la URL) y lo cerro #69 (el candado de tenencia + resolucion por recurso). El
                // orden se mantiene porque `organizationId` singular —campo legacy— sigue saliendo
                // de `[0]` cuando no hay organizacion determinable.
                orderBy: [{ createdAt: 'desc' }, { organizationId: 'asc' }],
              },
            },
          },
        },
      });

      if (!session || !session.user) {
        throw new UnauthorizedException('Sesion invalida o expirada');
      }

      const { user } = session;
      const organizationIds = user.organizationMembers.map((m) => m.organizationId);

      // #68 F1b — LOS PERMISOS SALEN DE LA ORGANIZACION DE LA QUE HABLA LA URL.
      //
      // Lo que habia: un unico array `permissions` derivado de `organizationMembers[0]`, o sea de
      // una membership elegida SIN CONTEXTO, que `PermissionsGuard` despues consumia como si
      // fuera la verdad para cualquier organizacion. Mientras existiera ese array global, el
      // `:orgId` de la URL no podia influir en la decision.
      //
      // F1 (c09202d) solo le puso `orderBy` a esa eleccion: la volvio predecible, no correcta.
      // F1b ELIMINA la eleccion — ver `resolverPermisos`.
      const { membership, permissions, modo } = await this.resolverPermisos(
        user.organizationMembers,
        request.params as Record<string, string> | undefined,
        request.path ?? request.url ?? '',
      );

      // #69 — La unica rama que queda sin organizacion determinable: multi-membership en una ruta
      // que NO trae `:orgId` NI ningun param del mapa de `org-context.resolver.ts`. Ya no incluye
      // `/tasks/:id` ni `/files/:id` —esos ahora resuelven por recurso—, asi que en la practica son
      // rutas exentas o sin ids. Se aplica la interseccion: lo unico verdadero que se puede afirmar
      // sin saber la organizacion. Hoy no se ejecuta para nadie (F0: cero usuarios multi-org).
      if (modo === 'interseccion') {
        this.logger.warn(
          `Usuario ${user.id} tiene ${user.organizationMembers.length} memberships y la ruta ` +
            `${request.path} no declara :orgId. Se aplica la INTERSECCION de sus permisos ` +
            `(${permissions.join(', ') || 'ninguno'}). Ver #69: no hay :orgId ni ningun param del mapa contra el cual resolver.`,
        );
      }

      // Validate client status for portal users.
      // #68 F1b: se pregunta por TODAS las memberships y no por la resuelta. Un usuario de portal
      // cuyo cliente esta inactivo tiene que quedar afuera aunque la URL apunte a otra
      // organizacion — si esto dependiera de `membership`, un `:orgId` ajeno saltearia el chequeo.
      if (user.organizationMembers.some((m) => m.role?.name === 'Cliente')) {
        const client = await this.prisma.client.findFirst({
          where: {
            OR: [
              { userId: user.id },
              { users: { some: { id: user.id } } },
            ],
          },
          select: { status: true },
        });

        if (client && client.status !== 'ACTIVE') {
          await this.prisma.session.delete({ where: { id: session.id } }).catch(() => {});
          throw new UnauthorizedException('Acceso deshabilitado - cliente inactivo');
        }
      }

      const authenticatedUser: AuthenticatedUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        organizationId: membership?.organizationId,
        organizationIds,
        clientId: user.clientId ?? null,
        roleId: membership?.roleId,
        roleName: membership?.role?.name,
        permissions,
      };

      (request as any).user = authenticatedUser;
      (request as any).sessionId = session.id;

      // Bloqueo duro: si email no verificado, solo permitir paths de verificacion +
      // logout + me (para que la UI pueda mostrar "Verifica tu correo" sin loopear).
      if (!user.emailVerified) {
        const path = request.path ?? request.url ?? '';
        const isAllowed = ALLOWED_PATHS_UNVERIFIED.some((p) => path.includes(p));
        if (!isAllowed) {
          throw new AppException(
            'Verifica tu correo electronico para acceder a esta funcionalidad',
            'EMAIL_NOT_VERIFIED',
            403,
          );
        }
      }

      // Sliding session: renew expiration on every authenticated request
      const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
      const response = context.switchToHttp().getResponse<Response>();

      this.prisma.session.update({
        where: { id: session.id },
        data: { expiresAt: newExpiresAt },
      }).catch((err) => this.logger.warn('Failed to extend session', err));

      const isProduction = this.configService.isProduction;
      // MISMO nombre y flags que AuthController.setSessionCookie (gated por
      // COOKIE_SAMESITE_LAX). Si difieren, este re-set de cada request pisa la cookie
      // del login con flags viejos y la sesión se corrompe de forma intermitente.
      const sameSiteLax = this.configService.cookieSameSiteLax;
      const useHostPrefix = isProduction && sameSiteLax;
      const sameSite: 'lax' | 'none' = !sameSiteLax && isProduction ? 'none' : 'lax';
      response.cookie(useHostPrefix ? SESSION_COOKIE_HOST : SESSION_COOKIE, session.token, {
        httpOnly: true,
        secure: isProduction,
        sameSite,
        maxAge: SESSION_TTL_MS,
        path: '/',
      });

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      if (error instanceof AppException) {
        throw error;
      }
      this.logger.error('Error validating session', error);
      throw new UnauthorizedException('Error al validar la sesion');
    }
  }

  /**
   * #68 F1b — Elige la membership con la que se evalua ESTA request, y sus permisos.
   *
   * EL BUG QUE CIERRA. `PermissionsGuard` consume un unico `user.permissions`. Ese array salia de
   * `organizationMembers[0]` —una membership elegida sin saber contra que organizacion se estaba
   * operando— y si su rol se llamaba 'Owner' se convertia en `['*:*']`. Como
   * `auth.service.ts:68-72` le crea a cada registrado una organizacion PERSONAL donde es Owner,
   * cualquiera con dos memberships podia arrastrar el comodin de su organizacion personal a
   * TODAS las requests contra la organizacion real.
   *
   * EL CRITERIO: el `orgId` de la URL es un input del ATACANTE, asi que nunca CONCEDE nada — se
   * usa para FILTRAR las memberships que el usuario ya tiene. Escribir un `orgId` ajeno no puede
   * sumar permisos, porque el filtro corre sobre memberships reales y no sobre el string.
   *
   * Los cuatro caminos, y el porque de cada uno:
   *
   *  - `unica`      — una sola membership. Es el 100% del trafico de hoy (F0 dio cero usuarios
   *                   multi-organizacion) y se comporta EXACTAMENTE como antes.
   *  - `por-url`    — la ruta trae `:orgId` y el usuario es miembro: se usan los permisos DE ESA
   *                   organizacion. Es el caso que arregla el bug.
   *  - `ajena`      — la ruta trae `:orgId` y el usuario NO es miembro: `permissions = []`. No se
   *                   lanza 403 desde aca a proposito: `AuthGuard` responde "¿quien sos?", y el
   *                   403 de autorizacion es de `PermissionsGuard` (permissions.guard.ts:56-60),
   *                   que ya sabe formatear el mensaje. Vaciar el array hace que toda ruta con
   *                   `@Permissions` devuelva 403 sola, sin tocar 16 controllers ni depender del
   *                   orden de guards. Lo que NO cubre es la ruta sin `@Permissions` (fail-open
   *                   de permissions.guard.ts:24) — eso lo cierra F2.
   *  - `interseccion` — la ruta NO dice de que organizacion habla (`/tasks/:id`,
   *                   `/notifications`) y hay mas de una membership. Ver `intersecar`.
   *
   * NO cuesta una consulta extra: los `rolePermissions` de TODAS las memberships ya vienen en el
   * `include` de arriba.
   */
  private async resolverPermisos(
    memberships: MembershipCargada[],
    params: Record<string, string> | undefined,
    path: string,
  ): Promise<{
    membership: MembershipCargada | undefined;
    permissions: string[];
    modo: 'sin-membership' | 'unica' | 'por-url' | 'por-recurso' | 'ajena' | 'interseccion' | 'exenta';
  }> {
    if (memberships.length === 0) {
      return { membership: undefined, permissions: [], modo: 'sin-membership' };
    }

    const unaSola = memberships.length === 1;

    /** Permisos de la membership de `orgId`, o el 403 si no es del usuario. */
    const contra = (orgId: string, modo: 'por-url' | 'por-recurso') => {
      const propia = memberships.find((m) => m.organizationId === orgId);

      if (!propia) {
        // #69 — EL CANDADO. Esto es lo que F1b no podia hacer: un 403 que no depende de que la
        // ruta declare `@Permissions`. Son 176 de las 302 rutas del repo, incluidas las 22 de
        // `ticket.controller.ts`, que ni siquiera monta `PermissionsGuard`.
        throw this.forbidden();
      }

      return { membership: propia, permissions: this.permisosDe(propia), modo };
    };

    // #69 — Las rutas exentas no tienen candado. Ver PREFIJOS_EXENTOS: el portal tiene scoping
    // propio por `clientId`, y /users y /notifications operan sobre el propio usuario (su tenencia
    // es `userId === session.userId`, otro eje). Se comportan como antes de #69.
    if (estaExento(path)) {
      return unaSola
        ? { membership: memberships[0], permissions: this.permisosDe(memberships[0]), modo: 'exenta' }
        : {
            membership: memberships[0],
            permissions: this.intersecar(memberships.map((m) => this.permisosDe(m))),
            modo: 'exenta',
          };
    }

    // 1. La URL lo dice. Se valida SIEMPRE, incluso con una sola membership: pedir `orgId` de otra
    //    organizacion tiene que dar 403 aunque el usuario pertenezca a una sola.
    if (params?.orgId) {
      const resultado = contra(params.orgId, 'por-url');

      // #70 — LA REGLA CRUZADA. `contra` acaba de responder "¿esta organizacion es tuya?", que es
      // el eje usuario->organizacion. Falta el otro: "¿y el recurso de la URL es de ESA
      // organizacion?".
      //
      // Sin esto quedan 43 rutas abiertas —las de `client`, `client-billing`, `botmaker-billing`,
      // `sla-config` y una de `ticket`, que traen `:orgId` Y un id de recurso—: se pone la
      // organizacion PROPIA en la URL y se pide un recurso ajeno. El resolver, por diseno, corta
      // apenas ve `orgId` y no mira el recurso nunca.
      //
      // ORDEN IMPORTANTE: primero la membresia (arriba), despues el recurso. Al reves, un
      // no-miembro podria deducir por el mensaje si el recurso existe.
      await this.verificarRecursoDeLaOrg(params, params.orgId);

      return resultado;
    }

    // 2. Sin `:orgId` y con UNA sola membership no hay nada que resolver: esa ES su organizacion.
    //    Este atajo es lo que hace que hoy #69 no agregue NI UNA consulta — F0 dio cero usuarios
    //    multi-organizacion, asi que el 100% del trafico actual sale por aca.
    //    (Que el RECURSO pertenezca a esa organizacion es el otro eje, y lo cierra #70.)
    if (unaSola) {
      return { membership: memberships[0], permissions: this.permisosDe(memberships[0]), modo: 'unica' };
    }

    // 3. Multi-membership sin `:orgId`: la organizacion sale del RECURSO. Una sola consulta.
    const resuelta = await resolverOrganizacion(this.prisma, params);

    if (resuelta.orgId) {
      return contra(resuelta.orgId, 'por-recurso');
    }

    if (resuelta.consulto) {
      // Habia un param del mapa pero el recurso no existe. EXACTAMENTE el mismo 403 que un
      // recurso ajeno — ver `forbidden()`.
      throw this.forbidden();
    }

    // 4. No hay ningun param que permita saber de que organizacion habla la request
    //    (`/some/route` sin ids conocidos). No hay nada que validar: se cae a la interseccion,
    //    que es lo mas conservador que se puede afirmar sin saber la organizacion.
    return {
      // El campo legacy `organizationId` sigue apuntando a la primera (la mas reciente por el
      // `orderBy`), que es lo que esperan los modulos que lo leen. Los PERMISOS, en cambio, no
      // salen de ella: salen de la interseccion.
      membership: memberships[0],
      permissions: this.intersecar(memberships.map((m) => this.permisosDe(m))),
      modo: 'interseccion',
    };
  }

  /**
   * #70 — El eje recurso -> organizacion.
   *
   * Cuando la URL trae `:orgId` Y un id de recurso del mapa, verifica que ese recurso pertenezca a
   * ESA organizacion. Es lo unico que quedaba fuera del candado despues de #69: las rutas SIN
   * `:orgId` ya resuelven por recurso —y eso ya es tenencia—, pero en las que traen las dos cosas
   * el `orgId` gana y el recurso no se mira.
   *
   * NO consulta si la ruta no trae ningun param del mapa, que es la mayoria: son 43 rutas de 215
   * con id, todas de `client` / `client-billing` / `botmaker-billing` / `sla-config` / `ticket`.
   * Ahi la consulta extra se paga con gusto: son datos de cliente, tarifas y facturacion.
   */
  private async verificarRecursoDeLaOrg(
    params: Record<string, string>,
    orgIdDeLaUrl: string,
  ): Promise<void> {
    const delRecurso = await resolverOrganizacion(this.prisma, params, { ignorarOrgId: true });

    // Sin param de recurso en la URL no hay nada que comparar: `consulto` es false y se sale sin
    // haber tocado la base.
    if (!delRecurso.consulto) return;

    // `encontrado: false` cubre el recurso inexistente Y la relacion rota. Los dos son el mismo
    // 403 que un recurso ajeno — ver `forbidden()`.
    if (!delRecurso.encontrado || delRecurso.orgId !== orgIdDeLaUrl) {
      throw this.forbidden();
    }
  }

  /**
   * #69 — UN SOLO 403 para todos los casos de tenencia.
   *
   * Los cuatro caminos que lo lanzan —organizacion ajena, organizacion inexistente, recurso ajeno
   * y recurso inexistente— tienen que ser INDISTINGUIBLES desde afuera. Con mensajes distintos, la
   * respuesta se vuelve un oraculo: probando ids se puede separar "existe pero no es tuyo" de "no
   * existe", que es justo lo que un atacante necesita para enumerar.
   *
   * Se aprendio en la suite: el primer intento usaba dos mensajes y el test de R4.6 lo cazo.
   */
  private forbidden() {
    return new ForbiddenException('este recurso', 'operar');
  }

  /** Los permisos de UNA membership, con el atajo de Owner acotado a su propia organizacion. */
  private permisosDe(membership: MembershipCargada): string[] {
    const permisos =
      membership.role?.rolePermissions?.map(
        (rp) => `${rp.permission.action}:${rp.permission.resource}`,
      ) ?? [];

    // Owner always gets full access — pero SOLO en la organizacion donde es Owner. Que este
    // atajo se aplicara a una membership elegida al azar era el corazon de la escalada.
    if (membership.role?.name === 'Owner' && !permisos.includes('*:*')) {
      return ['*:*'];
    }

    return permisos;
  }

  /**
   * #68 F1b — Lo que el usuario puede hacer en TODAS sus organizaciones a la vez.
   *
   * Es la respuesta a "no se contra que organizacion estas operando". Habia tres opciones y las
   * otras dos son peores: quedarse con la primera es el azar de hoy, y la UNION es literalmente
   * el bug (ser Owner en una organizacion te daria `*:*` en todas). La interseccion solo puede
   * QUITAR permisos, nunca agregarlos: equivocarse para abajo es un 403 molesto, equivocarse para
   * arriba es un agujero.
   *
   * `*:*` se expande a "todo", asi que no recorta: `['*:*'] ∩ ['read:projects']` es
   * `['read:projects']`, no vacio. Si TODAS las memberships tienen `*:*`, el resultado es `*:*`.
   *
   * Es un puente hasta F3, donde la organizacion sale del RECURSO (`:taskId` -> su proyecto -> su
   * organizacion) y esta rama desaparece. Hoy no se ejecuta para nadie.
   */
  private intersecar(conjuntos: string[][]): string[] {
    const concretos = conjuntos.filter((c) => !c.includes('*:*'));

    if (concretos.length === 0) return ['*:*'];

    return concretos.reduce((acumulado, actual) =>
      acumulado.filter((permiso) => actual.includes(permiso)),
    );
  }

  private extractSessionToken(request: Request): string | null {
    // 1. Check Authorization header (Bearer token)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    // 2. Check session cookies (__Host- primero para el modo same-site)
    const sessionCookie =
      request.cookies?.[SESSION_COOKIE_HOST] ||
      request.cookies?.['zentik.session_token'] ||
      request.cookies?.['better-auth.session_token'] ||
      request.cookies?.['__Secure-better-auth.session_token'];
    if (sessionCookie) {
      return sessionCookie;
    }

    return null;
  }
}
