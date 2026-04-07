import { IsOptional, IsEnum, IsString, IsInt, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ProjectStatus, ProjectLifecycleStatus } from '@prisma/client';

export class ProjectFilterDto {
  @ApiPropertyOptional({
    example: 'DEVELOPMENT',
    description: 'Filtrar por estado del proyecto',
    enum: ProjectStatus,
  })
  @IsOptional()
  @IsEnum(ProjectStatus, { message: 'El estado del proyecto no es valido' })
  status?: ProjectStatus;

  @ApiPropertyOptional({
    example: 'ACTIVE',
    description: 'Filtrar por estado de ciclo de vida',
    enum: ProjectLifecycleStatus,
  })
  @IsOptional()
  @IsEnum(ProjectLifecycleStatus, { message: 'El estado de ciclo de vida no es valido' })
  lifecycleStatus?: ProjectLifecycleStatus;

  @ApiPropertyOptional({
    example: 'rediseno',
    description: 'Busqueda por nombre o descripcion',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Numero de pagina',
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La pagina debe ser un numero entero' })
  @Min(1, { message: 'La pagina debe ser al menos 1' })
  page?: number = 1;

  @ApiPropertyOptional({
    example: 20,
    description: 'Cantidad de resultados por pagina',
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El limite debe ser un numero entero' })
  @Min(1, { message: 'El limite debe ser al menos 1' })
  @Max(100, { message: 'El limite no puede exceder 100' })
  limit?: number = 20;

  @ApiPropertyOptional({
    example: '-createdAt',
    description: 'Campo de ordenamiento (prefijo - para descendente)',
  })
  @IsOptional()
  @IsString()
  sort?: string = '-createdAt';
}
