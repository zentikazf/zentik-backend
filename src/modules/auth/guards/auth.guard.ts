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
 * La forma de una membership, tal como la trae el `include` de `canActivate`.
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
                // Se cargan TODAS las memberships (sin `take: 1`): `resolverPermisos` elige
                // cual aplica segun la organizacion de la request, y `organizationIds[]` alimenta
                // el scoping multi-tenant del MCP.
                //
                // EL ORDEN ES EXPLICITO Y NO DECORATIVO. `[0]` es el valor del campo legacy
                // `organizationId` (singular) para los modulos que todavia lo leen, y para el
                // frontend, que entra a `organizations[0]` cuando no tiene una organizacion
                // guardada (`org-provider.tsx:46`).
                //
                // `desc` y no `asc`: la organizacion PERSONAL que `auth.service.ts:68-72` le crea
                // a cada registrado nace EN EL REGISTRO, o sea que es siempre la mas antigua del
                // usuario. Con `asc` ganaria siempre y la persona entraria a una organizacion
                // vacia. Con `desc` gana la mas reciente, que es aquella a la que la invitaron.
                // El desempate por `organizationId` evita que dos memberships del mismo instante
                // alternen entre requests.
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

      // El corazon de la autorizacion multi-tenant: de que organizacion habla esta request, si el
      // usuario pertenece a ella, y con que permisos sigue. Lanza 403 si la organizacion o el
      // recurso no son suyos. Ver el docblock de `resolverPermisos`.
      const { membership, permissions, modo } = await this.resolverPermisos(
        user.organizationMembers,
        request.params as Record<string, string> | undefined,
        request.path ?? request.url ?? '',
      );

      // La interseccion es el ultimo recurso: un usuario multi-organizacion en una ruta que no
      // trae `:orgId` NI ningun id del mapa, o sea que no hay nada contra que resolver. Se avisa
      // porque es impreciso por definicion —se le dan los permisos que tiene en TODAS sus
      // organizaciones— y conviene saber que rutas caen ahi. Hoy no lo toma nadie: no hay usuarios
      // multi-organizacion en produccion.
      if (modo === 'interseccion') {
        this.logger.warn(
          `Usuario ${user.id} tiene ${user.organizationMembers.length} memberships y la ruta ` +
            `${request.path} no trae :orgId ni ningun id conocido contra el cual resolver la ` +
            `organizacion. Se aplica la INTERSECCION de sus permisos ` +
            `(${permissions.join(', ') || 'ninguno'}).`,
        );
      }

      // Usuario de portal con su cliente desactivado: se le corta la sesion.
      // Se pregunta por TODAS las memberships y no por la resuelta a proposito — si dependiera de
      // la resuelta, apuntar la URL a otra organizacion saltearia el chequeo.
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
   * De que organizacion habla esta request, si el usuario pertenece a ella, y con que permisos
   * sigue.
   *
   * ── EL PRINCIPIO ──────────────────────────────────────────────────────────────────────────
   * Todo lo que viene en la URL es input del ATACANTE, asi que nunca CONCEDE nada: se usa para
   * FILTRAR las memberships que el usuario ya tiene. Escribir un `orgId` ajeno o el id de un
   * recurso ajeno no puede sumar permisos, porque el filtro corre sobre datos reales del usuario
   * y no sobre el string de la URL.
   *
   * ── LOS SEIS CAMINOS ──────────────────────────────────────────────────────────────────────
   *
   *  `sin-membership`  El usuario no pertenece a ninguna organizacion. Permisos vacios.
   *
   *  `exenta`          La ruta esta en `PREFIJOS_EXENTOS`. No hay candado: son rutas publicas,
   *                    del propio usuario, o con scoping propio (el portal filtra por `clientId`).
   *
   *  `por-url`         La ruta trae `:orgId`. Se valida membresia (403 si no) y, si ademas trae
   *                    un id de recurso, que ESE recurso sea de ESA organizacion (403 si no).
   *
   *  `unica`           Sin `:orgId` y el usuario tiene UNA sola membership: esa es su
   *                    organizacion, sin ambiguedad. NO se consulta nada.
   *
   *  `por-recurso`     Sin `:orgId` y multi-membership: la organizacion sale del recurso
   *                    (`:taskId` -> su proyecto -> su organizacion). Una sola consulta.
   *
   *  `interseccion`    No hay `:orgId` NI ningun id conocido: no se puede saber de que
   *                    organizacion habla. Se afirma lo minimo verdadero — lo que el usuario
   *                    puede hacer en TODAS sus organizaciones. Ver `intersecar`.
   *
   * ── LO QUE CUESTA ─────────────────────────────────────────────────────────────────────────
   * Los `rolePermissions` de TODAS las memberships ya vienen en el `include` de `canActivate`,
   * asi que decidir los permisos es gratis. Se consulta la base UNICAMENTE para resolver un
   * recurso: en `por-recurso`, y en `por-url` cuando la ruta trae ademas un id del mapa.
   * Con una sola membership y sin recurso en la URL, cero consultas.
   *
   * ── LO QUE NO RESUELVE ────────────────────────────────────────────────────────────────────
   * Las fugas INTRA-organizacion: si el atacante es miembro legitimo de la organizacion, esto lo
   * deja pasar y hace bien — la pregunta "¿este dato de tu organizacion te corresponde a VOS?" se
   * contesta con permisos y proyeccion de campos, caso por caso (ver `client.service.findAll`).
   */
  private async resolverPermisos(
    memberships: MembershipCargada[],
    params: Record<string, string> | undefined,
    path: string,
  ): Promise<{
    membership: MembershipCargada | undefined;
    permissions: string[];
    modo: 'sin-membership' | 'unica' | 'por-url' | 'por-recurso' | 'interseccion' | 'exenta';
  }> {
    if (memberships.length === 0) {
      return { membership: undefined, permissions: [], modo: 'sin-membership' };
    }

    const unaSola = memberships.length === 1;

    /** Permisos de la membership de `orgId`, o el 403 si no es del usuario. */
    const contra = (orgId: string, modo: 'por-url' | 'por-recurso') => {
      const propia = memberships.find((m) => m.organizationId === orgId);

      if (!propia) {
        // EL CANDADO. El 403 sale de aca y NO de `PermissionsGuard`, porque aquel devuelve `true`
        // cuando el handler no declara `@Permissions` (permissions.guard.ts:24) — y son 176 de las
        // 302 rutas del repo, incluidas las 22 de `ticket.controller.ts`, que ni siquiera lo monta.
        throw this.forbidden();
      }

      return { membership: propia, permissions: this.permisosDe(propia), modo };
    };

    // Rutas sin candado de organizacion. Ver `PREFIJOS_EXENTOS`: el portal tiene scoping propio
    // por `clientId`, y `/users` y `/notifications` operan sobre el propio usuario (su tenencia es
    // `userId === session.userId`, otro eje).
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

      // LA REGLA CRUZADA. `contra` responde el eje usuario->organizacion ("¿esta organizacion es
      // tuya?"). Esto responde el otro: "¿y el recurso de la URL es de ESA organizacion?" — porque
      // ser miembro de A no te habilita a pedir un recurso de B poniendo A en la URL.
      //
      // ORDEN IMPORTANTE: primero la membresia (arriba), despues el recurso. Al reves, un
      // no-miembro podria deducir por el comportamiento si el recurso existe.
      await this.verificarRecursoDeLaOrg(params, params.orgId);

      return resultado;
    }

    // 2. Sin `:orgId` y con UNA sola membership no hay nada que resolver: esa ES su organizacion.
    //    Es el atajo que evita la consulta, y hoy lo toma el 100% del trafico (no hay usuarios
    //    multi-organizacion en produccion).
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
   * El eje recurso -> organizacion.
   *
   * Cuando la URL trae `:orgId` Y un id de recurso del mapa, verifica que ese recurso pertenezca a
   * ESA organizacion. Hace falta porque el resolver, por diseno, corta apenas ve `orgId` — que es
   * lo correcto para RESOLVER, pero dejaria pasar a quien pone su propia organizacion en la URL y
   * pide un recurso de otra.
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
   * UN SOLO 403 para todos los casos de tenencia.
   *
   * Los cuatro caminos que lo lanzan —organizacion ajena, organizacion inexistente, recurso ajeno
   * y recurso inexistente— tienen que ser INDISTINGUIBLES desde afuera. Con mensajes distintos, la
   * respuesta se vuelve un oraculo: probando ids se puede separar "existe pero no es tuyo" de "no
   * existe", que es justo lo que un atacante necesita para enumerar.
   *
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
   * Lo que el usuario puede hacer en TODAS sus organizaciones a la vez.
   *
   * Es la respuesta a "no se contra que organizacion estas operando". De las tres opciones
   * posibles es la unica segura: quedarse con la primera membership es arbitrario, y la UNION
   * seria una escalada (ser Owner en una organizacion daria `*:*` en todas). La interseccion solo
   * puede QUITAR permisos, nunca agregarlos — equivocarse para abajo es un 403 molesto,
   * equivocarse para arriba es un agujero.
   *
   * `*:*` se expande a "todo", asi que no recorta: `['*:*'] ∩ ['read:projects']` es
   * `['read:projects']`, no vacio. Si TODAS las memberships tienen `*:*`, el resultado es `*:*`.
   *
   * Es el ultimo recurso: solo se llega aca cuando la ruta no trae `:orgId` NI ningun id del mapa
   * de `org-context.resolver.ts`. Hoy no lo toma nadie (no hay usuarios multi-organizacion).
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
