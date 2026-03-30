# Backend Patterns — NestJS (Senior Feature Builder)

Referencia de patrones senior para implementar módulos NestJS. Aplica estas reglas durante la Fase 4.

---

## Estructura de Módulo (Obligatoria)

```
modules/
└── feature-name/
    ├── dto/
    │   ├── create-feature.dto.ts
    │   ├── update-feature.dto.ts
    │   └── index.ts
    ├── feature.controller.ts
    ├── feature.service.ts
    └── feature.module.ts
```

**Regla:** Siempre en este orden de creación: dto → service → controller → module → AppModule.

---

## DTOs con class-validator

```typescript
import { IsString, IsNotEmpty, IsOptional, IsEnum, MinLength, MaxLength } from 'class-validator';

export class CreateFeatureDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(StatusEnum)
  status: StatusEnum;
}
```

**Reglas:**
- Siempre `@IsNotEmpty()` en campos obligatorios
- Siempre `@IsOptional()` en campos opcionales
- NUNCA aceptes tipos `any`
- Campos de fecha: `@IsDateString()`
- IDs relacionales: `@IsString()` o `@IsUUID()`

---

## Service — Estructura Obligatoria

```typescript
@Injectable()
export class FeatureService {
  private readonly logger = new Logger(FeatureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateFeatureDto, userId: string) {
    // 1. Validaciones de negocio ANTES de la transacción
    const existing = await this.prisma.feature.findFirst({ where: { name: dto.name } });
    if (existing) {
      throw new AppException('Ya existe un item con ese nombre', 'FEATURE_DUPLICATE', 409, { name: dto.name });
    }

    // 2. Lógica principal en transacción
    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.feature.create({ data: { ...dto, createdById: userId } });
      return created;
    });

    // 3. Emitir evento DESPUÉS de la transacción exitosa (fuera del $transaction)
    //    Esto asegura que el evento solo se emite si el commit fue exitoso.
    this.eventEmitter.emit('feature.created', { feature: result, userId });
    this.logger.log(`Feature created: ${result.id}`);

    return result;
  }

  async findAll(params: { page?: number; limit?: number; search?: string }) {
    const page = params.page || 1;
    const limit = Math.min(params.limit || 20, 100); // Cap máximo de 100
    const skip = (page - 1) * limit;

    const where: Prisma.FeatureWhereInput = {
      deletedAt: null, // Soft delete filter — SIEMPRE
      ...(params.search && {
        OR: [
          { name: { contains: params.search, mode: 'insensitive' } },
          { description: { contains: params.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.feature.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { createdBy: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.feature.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
```

**Reglas críticas:**
- Logger en TODOS los servicios: `private readonly logger = new Logger(FeatureService.name)`
- Siempre usa `AppException` para errores de negocio (NUNCA `throw new Error()` genérico)
- Usa `$transaction` cuando la operación toca 2+ tablas
- Emite eventos de dominio DESPUÉS de la transacción exitosa, nunca dentro del `$transaction`
- Toda la lógica de negocio va en el Service, NUNCA en el Controller
- Endpoints de listado (`findAll`) SIEMPRE con paginación (`page`, `limit`, `search`)
- Si el modelo tiene `deletedAt`, SIEMPRE filtra `deletedAt: null` en las queries

---

## AppException (Patrón de Errores)

```typescript
// Uso correcto siempre:
throw new AppException(
  'Mensaje legible para el usuario',  // message
  'ERROR_CODE_UPPERCASE',              // code (para el frontend)
  404,                                 // HTTP status
  { id: resourceId }                   // detalles opcionales para debugging
);

// Errores comunes por tipo:
throw new AppException('No encontrado', 'NOT_FOUND', 404, { id });
throw new AppException('Sin permiso', 'FORBIDDEN', 403, { resource });
throw new AppException('Ya existe', 'DUPLICATE', 409, { field: value });
throw new AppException('Input inválido', 'VALIDATION_ERROR', 400, { field });
```

---

## Controller — Estructura Obligatoria

```typescript
@Controller('features')
@UseGuards(AuthGuard)                // Guard en el controller, no en cada endpoint
export class FeatureController {
  constructor(private readonly featureService: FeatureService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateFeatureDto,
    @CurrentUser() user: User,        // Decorator custom para obtener el usuario
  ) {
    return this.featureService.create(dto, user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.featureService.findById(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFeatureDto,
    @CurrentUser() user: User,
  ) {
    return this.featureService.update(id, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.featureService.delete(id, user.id);
  }
}
```

**Reglas:**
- `@UseGuards(AuthGuard)` en el nivel del controller, no en cada endpoint (excepto rutas públicas)
- `@HttpCode(HttpStatus.CREATED)` en POST
- `@HttpCode(HttpStatus.NO_CONTENT)` en DELETE
- Controllers SIN lógica — solo llaman al service

---

## Module — Estructura Obligatoria

```typescript
@Module({
  imports: [PrismaModule],  // Importa los módulos que necesita
  controllers: [FeatureController],
  providers: [FeatureService],
  exports: [FeatureService],  // Exporta si otros módulos lo necesitan
})
export class FeatureModule {}
```

---

## Prisma Schema — Convenciones

```prisma
model Feature {
  id          String   @id @default(cuid())
  name        String
  description String?
  status      FeatureStatus @default(ACTIVE)

  // Auditoría — SIEMPRE estos campos
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  createdById String
  createdBy   User     @relation(fields: [createdById], references: [id])

  // Soft delete — si aplica
  deletedAt   DateTime?

  // Índices en campos de búsqueda frecuente
  @@index([status])
  @@index([createdById])
}

enum FeatureStatus {
  ACTIVE
  INACTIVE
  ARCHIVED
}
```

**Reglas DB:**
- IDs siempre `@id @default(cuid())` — NUNCA IDs secuenciales numéricos
- Siempre `createdAt`, `updatedAt`, `createdById`
- Enums en UPPER_SNAKE_CASE
- Índices en campos que se filtran/buscan frecuentemente
- Soft delete con `deletedAt DateTime?` si el recurso no debe eliminarse físicamente
- Relaciones con nombres descriptivos

---

## Eventos de Dominio — Convención de Nombres

```typescript
// Patrón: 'entidad.accion' en minúsculas
this.eventEmitter.emit('feature.created', { feature, userId });
this.eventEmitter.emit('feature.updated', { feature, previousData, userId });
this.eventEmitter.emit('feature.deleted', { featureId, userId });
this.eventEmitter.emit('feature.status.changed', { feature, previousStatus, userId });
```

---

## Queries Prisma — Anti-Patterns a Evitar

```typescript
// ❌ MAL — N+1 query
const features = await prisma.feature.findMany();
for (const f of features) {
  f.user = await prisma.user.findUnique({ where: { id: f.userId } }); // N queries!
}

// ✅ BIEN — Include en una sola query
const features = await prisma.feature.findMany({
  include: {
    user: { select: { id: true, name: true, email: true } },
  },
});

// ✅ BIEN — Select solo los campos necesarios
const feature = await prisma.feature.findUnique({
  where: { id },
  select: { id: true, name: true, status: true }, // No traer todo si no es necesario
});
```
