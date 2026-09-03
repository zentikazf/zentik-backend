import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PrismaService } from '../../../database/prisma.service';
import { AppConfigService } from '../../../config/app.config';
import { AppException, UnauthorizedException } from '../../../common/filters/app-exception';
import { AuthenticatedUser } from '../../../common/interfaces/request.interface';

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
                // ⚠️ ESTO NO ARREGLA EL BUG, LO VUELVE PREDECIBLE Y MENOS DAÑINO. Sigue sin mirar
                // el `:orgId` de la URL: un usuario invitado a DOS organizaciones reales sigue
                // operando con los permisos de la mas nueva en las dos. El fix de verdad es
                // resolver la membership contra el `:orgId` (#68 F2, OrgContextGuard).
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
      const { membership, permissions, modo } = this.resolverPermisos(
        user.organizationMembers,
        (request.params as Record<string, string> | undefined)?.orgId,
      );

      // La unica rama que queda sin resolver: multi-membership en una ruta que no dice de que
      // organizacion habla (`/tasks/:id`, `/notifications`, `/files/:id`). Cae a la interseccion,
      // que es segura pero imprecisa. F3 la cierra resolviendo la organizacion desde el RECURSO.
      // Hoy no se ejecuta para nadie: el diagnostico F0 contra produccion dio cero usuarios con
      // mas de una membership.
      if (modo === 'interseccion') {
        this.logger.warn(
          `Usuario ${user.id} tiene ${user.organizationMembers.length} memberships y la ruta ` +
            `${request.path} no declara :orgId. Se aplica la INTERSECCION de sus permisos ` +
            `(${permissions.join(', ') || 'ninguno'}). Ver #68 F3.`,
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
  private resolverPermisos(
    memberships: MembershipCargada[],
    orgIdDeLaUrl: string | undefined,
  ): {
    membership: MembershipCargada | undefined;
    permissions: string[];
    modo: 'sin-membership' | 'unica' | 'por-url' | 'ajena' | 'interseccion';
  } {
    if (memberships.length === 0) {
      return { membership: undefined, permissions: [], modo: 'sin-membership' };
    }

    if (memberships.length === 1) {
      return {
        membership: memberships[0],
        permissions: this.permisosDe(memberships[0]),
        modo: 'unica',
      };
    }

    if (orgIdDeLaUrl) {
      const propia = memberships.find((m) => m.organizationId === orgIdDeLaUrl);

      // Una organizacion ajena y una inexistente dan el MISMO resultado, asi que la respuesta no
      // sirve para enumerar organizaciones.
      return propia
        ? { membership: propia, permissions: this.permisosDe(propia), modo: 'por-url' }
        : { membership: undefined, permissions: [], modo: 'ajena' };
    }

    return {
      // El campo legacy `organizationId` sigue apuntando a la primera (la mas reciente por el
      // `orderBy`), que es lo que esperan los modulos que lo leen. Los PERMISOS, en cambio, no
      // salen de ella: salen de la interseccion.
      membership: memberships[0],
      permissions: this.intersecar(memberships.map((m) => this.permisosDe(m))),
      modo: 'interseccion',
    };
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
