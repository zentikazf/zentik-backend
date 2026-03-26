import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { CreateLabelDto, UpdateLabelDto } from './dto';

@Injectable()
export class LabelService {
  constructor(private readonly prisma: PrismaService) {}

  async create(orgId: string, dto: CreateLabelDto, userId: string) {
    return this.prisma.label.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        color: dto.color,
        createdById: userId,
      },
    });
  }

  async findAll(orgId: string) {
    return this.prisma.label.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    });
  }

  async update(labelId: string, dto: UpdateLabelDto) {
    const label = await this.prisma.label.findUnique({ where: { id: labelId } });

    if (!label) {
      throw new AppException('La etiqueta no existe', 'LABEL_NOT_FOUND', 404, { labelId });
    }

    return this.prisma.label.update({
      where: { id: labelId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.color !== undefined && { color: dto.color }),
      },
    });
  }

  async delete(labelId: string) {
    const label = await this.prisma.label.findUnique({ where: { id: labelId } });

    if (!label) {
      throw new AppException('La etiqueta no existe', 'LABEL_NOT_FOUND', 404, { labelId });
    }

    // Delete associated TaskLabel entries first, then the label
    await this.prisma.$transaction([
      this.prisma.taskLabel.deleteMany({ where: { labelId } }),
      this.prisma.label.delete({ where: { id: labelId } }),
    ]);

    return { deleted: true };
  }
}
