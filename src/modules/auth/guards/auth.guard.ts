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
              },
            },
          },
        },
      });

      if (!session || !session.user) {
        throw new UnauthorizedException('Sesion invalida o expirada');
      }

      const { user } = session;
      // Primer membership = "primario" para campos legacy (organizationId,
      // roleId, roleName, permissions). Se mantiene la semantica previa para
      // backwards-compat con modulos que leen user.organizationId singular.
      const membership = user.organizationMembers[0];
      const organizationIds = user.organizationMembers.map((m) => m.organizationId);

      let permissions = membership?.role?.rolePermissions?.map(
        (rp) => `${rp.permission.action}:${rp.permission.resource}`,
      ) ?? [];

      // Owner always gets full access
      if (membership?.role?.name === 'Owner' && !permissions.includes('*:*')) {
        permissions = ['*:*'];
      }

      // Validate client status for portal users
      if (membership?.role?.name === 'Cliente') {
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
