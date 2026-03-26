import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { ForbiddenException } from '../../../common/filters/app-exception';
import { AuthenticatedUser } from '../../../common/interfaces/request.interface';

@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser = request.user;

    if (!user) {
      throw new ForbiddenException('recurso protegido', 'acceder');
    }

    const userPermissions = user.permissions ?? [];

    // Wildcard: *:* grants everything
    if (userPermissions.includes('*:*')) {
      return true;
    }

    // Check if user has ALL required permissions
    // "manage:resource" implicitly grants "read:resource"
    const hasAll = requiredPermissions.every((required) => {
      if (userPermissions.includes(required)) return true;

      // If requiring "read:X", check if user has "manage:X"
      const [action, resource] = required.split(':');
      if (action === 'read') {
        return userPermissions.includes(`manage:${resource}`);
      }

      return false;
    });

    if (!hasAll) {
      this.logger.warn(
        `User ${user.id} lacks permissions: [${requiredPermissions.join(', ')}]. Has: [${userPermissions.join(', ')}]`,
      );
      throw new ForbiddenException(
        'recurso protegido',
        `acceder (requiere permisos: ${requiredPermissions.join(', ')})`,
      );
    }

    return true;
  }
}
