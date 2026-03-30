# Informe de Auditoría de Código
## Proyecto: Zentik SaaS
## Fecha: 2026-03-28
## Auditor: Senior Code Auditor Skill

---

## Puntuación General: B+ (82%)

| Categoría | Peso | Nota | Hallazgos |
|-----------|------|------|-----------|
| Arquitectura y Módulos | 20% | B | 8 god services (>400 líneas) |
| Nomenclatura | 10% | A | 0 violaciones |
| Estructura de Carpetas | 10% | A | Cumple todos los estándares |
| DTOs y Validación | 15% | A- | 3 endpoints con tipos inline |
| Manejo de Errores | 15% | A | Jerarquía custom excelente |
| Formato de Respuestas | 10% | C+ | 48 POST sin 201, 13 DELETE sin 204 |
| Logging y Observabilidad | 10% | B+ | Falta Sentry, logger nativo vs Winston |
| Rendimiento | 10% | B | Unbounded findMany, deep includes |

---

## Hallazgos por Severidad

### 🟠 ALTOS (5)

**ARCH-001** — God Services exceden 400 líneas
- `apps/api/src/modules/task/task.service.ts` — **821 líneas**
- `apps/api/src/modules/project/project.service.ts` — **701 líneas**
- `apps/api/src/modules/organization/organization.service.ts` — **527 líneas**
- `apps/api/src/modules/auth/auth.service.ts` — **497 líneas**
- `apps/api/src/modules/sprint/sprint.service.ts` — **461 líneas**

Problema: Viola SRP. Servicios con demasiadas responsabilidades.
Corrección: Extraer lógica en sub-servicios:
- `task.service.ts` → TaskService + TaskBulkService + TaskFilterService
- `project.service.ts` → ProjectService + ProjectBudgetService
- `organization.service.ts` → OrganizationService + MembershipService

---

**API-001** — 48 endpoints POST devuelven 200 en vez de 201
- `apps/api/src/modules/task/task.controller.ts:44`
- `apps/api/src/modules/project/project.controller.ts:34`
- `apps/api/src/modules/comment/comment.controller.ts` (todos los @Post)
- Y 45+ más

Problema: Viola estándar HTTP. POST que crea recursos debe devolver 201.
Corrección:
```typescript
@Post()
@HttpCode(HttpStatus.CREATED)  // Agregar esta línea
async create(@Body() dto: CreateTaskDto) { ... }
```

---

**API-002** — 13 endpoints DELETE devuelven 200 en vez de 204
- `apps/api/src/modules/comment/comment.controller.ts`
- `apps/api/src/modules/label/label.controller.ts`
- Y 11+ más

Problema: DELETE exitoso debe devolver 204 No Content.
Corrección:
```typescript
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)  // Agregar esta línea
async remove(@Param('id') id: string) { ... }
```

---

**PERF-001** — findMany() sin límite en permisos
- `apps/api/src/modules/organization/organization.service.ts:71`
- `apps/api/src/modules/organization/organization.service.ts:386`

Problema: Carga toda la tabla de permisos en memoria sin paginación.
Corrección: Agregar `take: 500` o un límite razonable.

---

**OBS-001** — Sentry no inicializado
- `apps/api/src/config/app.config.ts:37` — Propiedad existe pero sin inicialización
- Problema: Sin error tracking centralizado en producción.
- Corrección: Inicializar Sentry en `main.ts` con DSN de producción.

---

### 🟡 MEDIOS (4)

**ARCH-002** — Directorio `pipes/` vacío
- `apps/api/src/common/pipes/` — Sin pipes custom
- Impacto bajo, pero podría beneficiar con ParseCuidPipe para validar IDs.

---

**DTO-001** — 3 endpoints usan tipos inline en vez de DTOs
- `apps/api/src/modules/auth/auth.controller.ts:183` — `@Body() body: { newPassword: string }`
- `apps/api/src/modules/project/project.controller.ts:141` — Inline type para budget items
- `apps/api/src/modules/project/project.controller.ts:152` — Inline type para update budget

Corrección: Crear `ChangePasswordDto`, `CreateBudgetItemDto`, `UpdateBudgetItemDto`.

---

**PERF-002** — Deep Prisma includes en task.service.ts
- `apps/api/src/modules/task/task.service.ts:156-182` — 10+ relaciones anidadas en `getTaskById`
- Impacto: Queries pesadas que traen datos innecesarios.
- Corrección: Usar `select` específico o separar en queries por necesidad.

---

**PERF-003** — Awaits secuenciales en notification.listener.ts
- `apps/api/src/modules/notification/notification.listener.ts:333-349`
- Problema: Crea notificaciones una por una en loop secuencial.
- Corrección: Usar `Promise.all()` o `createMany()` para batch.

---

### 🔵 BAJOS (3)

**LOG-001** — Logger nativo de NestJS en vez de Winston/Pino
- El proyecto usa `Logger` de `@nestjs/common` en todos los servicios.
- Funcional pero no produce logs JSON estructurados en producción.
- Recomendación: Migrar a Pino para logs JSON con niveles configurables.

---

**FE-001** — Sin lazy loading en componentes pesados
- No se detectó uso de `React.lazy()`, `Suspense`, o `next/dynamic()`.
- Impacto menor para esta aplicación, pero podría mejorar el bundle initial.

---

**FE-002** — Directorio `forms/` vacío en frontend
- `apps/web/src/components/forms/` existe pero sin contenido.
- Los formularios están inline en las páginas.
- Recomendación: Mover formularios reutilizables a este directorio.

---

## Detalle por Categoría

### CAT-1: Arquitectura y Módulos — **B** (75%)
- ✅ 23 módulos con estructura completa (module, controller, service, dto/)
- ✅ Directorio `common/` bien organizado con decorators, filters, interceptors, utils
- ✅ Sin dependencias circulares entre módulos
- ✅ Módulos comparten vía exports correctamente
- ❌ 8 god services exceden 400 líneas (máx: 821)
- ❌ Directorio `pipes/` vacío

### CAT-2: Nomenclatura — **A** (98%)
- ✅ Todos los archivos en kebab-case (300+ archivos verificados)
- ✅ Todas las clases en PascalCase (150+ clases)
- ✅ Constantes en UPPER_SNAKE_CASE
- ✅ Variables en camelCase
- ✅ Solo 4 console.error en bootstrap (aceptable)
- ✅ 0 violaciones de nomenclatura

### CAT-3: Estructura de Carpetas — **A** (95%)
- ✅ Backend: common/, config/, modules/, database/, infrastructure/
- ✅ Frontend: app/ (App Router), components/, hooks/, lib/, stores/, types/, providers/
- ✅ 23 feature modules bien organizados
- ✅ 4 route groups en frontend: (auth), (dashboard), (marketing), (portal)
- ⚠️ `forms/` y `pipes/` vacíos

### CAT-4: DTOs y Validación — **A-** (90%)
- ✅ ValidationPipe global con `whitelist: true` y `forbidNonWhitelisted: true`
- ✅ 56 archivos DTO con class-validator decorators
- ✅ UpdateDto usa `PartialType(CreateDto)` consistentemente
- ✅ Mensajes de error en español
- ✅ @ApiProperty para Swagger en todos los DTOs
- ❌ 3 endpoints con tipos inline sin validación decorada

### CAT-5: Manejo de Errores — **A** (95%)
- ✅ GlobalExceptionFilter implementado y registrado
- ✅ Stack traces ocultos en producción
- ✅ Formato de error consistente: `{ success, error: { code, message, details } }`
- ✅ 15+ excepciones custom (AppException, TaskNotFoundException, PlanLimitExceededException, etc.)
- ✅ Correlation ID en todos los errores
- ✅ 0 catch blocks vacíos
- ✅ Logger usado en todos los catch (no console.log)

### CAT-6: Formato de Respuestas — **C+** (65%)
- ✅ TransformInterceptor estandariza `{ success, data, timestamp }`
- ✅ API versionado: `/api/v1`
- ✅ Paginación con metadata (page, limit, total)
- ✅ Decorator @ApiPaginated para Swagger
- ❌ 48/49 endpoints POST sin `@HttpCode(201)`
- ❌ 13/23 endpoints DELETE sin `@HttpCode(204)`

### CAT-7: Logging y Observabilidad — **B+** (80%)
- ✅ LoggingInterceptor registra cada request (method, url, statusCode, userId, duration)
- ✅ Correlation ID middleware global
- ✅ Health check: `/health` + `/health/ready` (DB + Redis)
- ✅ 0 console.log en lógica de negocio
- ⚠️ Usa Logger nativo (no Winston/Pino para JSON estructurado)
- ❌ Sentry configurado pero no inicializado

### CAT-8: Rendimiento — **B** (78%)
- ✅ Todas las listas paginadas con límite por defecto (20)
- ✅ Promise.all usado extensivamente (6+ lugares verificados)
- ✅ Select/include pattern usado en queries
- ✅ Redis cache para usage tracking
- ❌ Unbounded findMany() en permisos (2 lugares)
- ❌ Deep includes en getTaskById (10+ relaciones)
- ⚠️ Notificaciones creadas secuencialmente
- ⚠️ Sin lazy loading en frontend

---

## Plan de Acción Recomendado

### Sprint Actual (Resolver antes de merge)
1. ~~**RESUELTO** — Bug duration seconds/minutes en billing y frontend~~
2. Agregar `@HttpCode(HttpStatus.CREATED)` a los 48 endpoints POST
3. Agregar `@HttpCode(HttpStatus.NO_CONTENT)` a los 13 endpoints DELETE faltantes
4. Crear DTOs para los 3 endpoints con tipos inline

### Próximo Sprint
5. Refactorizar god services (empezar por task.service.ts → 821 líneas)
6. Implementar Sentry para error tracking en producción
7. Agregar límites a permission.findMany()
8. Paralelizar creación de notificaciones con Promise.all

### Backlog
9. Migrar de Logger nativo a Pino para JSON estructurado
10. Agregar lazy loading con next/dynamic() para páginas pesadas
11. Reducir deep includes en Prisma (usar select específico)
12. Crear pipes custom en common/pipes/
