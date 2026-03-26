import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { ForbiddenException } from '../../../common/filters/app-exception';
import { PrismaService } from '../../../database/prisma.service';
import { AuthenticatedUser } from '../../../common/interfaces/request.interface';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no roles are required, allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser = request.user;

    if (!user) {
      throw new ForbiddenException('recurso protegido', 'acceder');
    }

    if (!user.roleId) {
      this.logger.warn(`User ${user.id} has no role assigned`);
      throw new ForbiddenException('recurso protegido', 'acceder sin rol asignado');
    }

    try {
      const role = await this.prisma.role.findUnique({
        where: { id: user.roleId },
        select: { name: true },
      });

      if (!role) {
        throw new ForbiddenException('recurso protegido', 'acceder con rol inexistente');
      }

      const hasRole = requiredRoles.some(
        (required) => required.toLowerCase() === role.name.toLowerCase(),
      );

      if (!hasRole) {
        this.logger.warn(
          `User ${user.id} with role "${role.name}" attempted to access resource requiring roles: [${requiredRoles.join(', ')}]`,
        );
        throw new ForbiddenException(
          'recurso protegido',
          `acceder (requiere rol: ${requiredRoles.join(' o ')})`,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      this.logger.error('Error checking roles', error);
      throw new ForbiddenException('recurso protegido', 'acceder');
    }
  }
}
