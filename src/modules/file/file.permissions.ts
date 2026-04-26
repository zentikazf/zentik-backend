import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Verifica si un usuario puede gestionar documentos del proyecto:
 * subir, cambiar visibilidad, eliminar, subir versiones, cambiar categoría.
 *
 * Reglas:
 * - Owner de la organización
 * - Project Manager (rol)
 * - Responsable del proyecto (project.responsibleId)
 */
@Injectable()
export class FilePermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async canManageProjectDocument(userId: string, projectId: string): Promise<boolean> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true, responsibleId: true },
    });
    if (!project) return false;

    // Es el responsable del proyecto?
    if (project.responsibleId === userId) return true;

    // Es Owner o Project Manager en la organización?
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId,
        organizationId: project.organizationId,
      },
      select: { role: { select: { name: true } } },
    });
    if (!member) return false;
    const roleName = member.role?.name;
    return roleName === 'Owner' || roleName === 'Project Manager';
  }
}
