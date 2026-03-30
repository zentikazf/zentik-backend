# Feature Blueprint Template

Usa este template exacto para generar el `FEATURE_BLUEPRINT.md`. Reemplaza todo lo que está en `{MAYÚSCULAS}` con la información del feature.

---

```markdown
# {NOMBRE_DEL_FEATURE} — Feature Blueprint
## Mini-PRD Técnico v1.0
### Proyecto: {NOMBRE_PROYECTO} | Generado: {FECHA} | Stack: NestJS + Next.js + Prisma

---

## 1. PRD — Product Requirements

### 1.1 Objetivo
{Describe en 2-3 oraciones qué problema resuelve este feature y qué valor entrega al usuario.}

### 1.2 Usuarios que lo usarán
| Rol | Qué puede hacer |
|-----|-----------------|
| {ROL_1} | {ACCIONES} |
| {ROL_2} | {ACCIONES} |

### 1.3 Funcionalidades del MVP (must-have)
- [ ] {FUNCIONALIDAD_1}
- [ ] {FUNCIONALIDAD_2}
- [ ] {FUNCIONALIDAD_3}

### 1.4 Fuera del alcance (v1)
- {LO_QUE_NO_SE_IMPLEMENTA}

### 1.5 Criterios de aceptación
```
DADO que {CONTEXTO}
CUANDO {ACCIÓN}
ENTONCES {RESULTADO_ESPERADO}
```

---

## 2. Diseño Técnico

### 2.1 Módulo Backend

**Módulo NestJS:** `{NombreFeature}Module`
**¿Nuevo módulo o extensión?** {Nuevo / Extensión de: módulo}

**Estructura de archivos:**
```
modules/
└── {feature-name}/
    ├── dto/
    │   ├── create-{feature-name}.dto.ts
    │   ├── update-{feature-name}.dto.ts
    │   └── index.ts
    ├── {feature-name}.controller.ts
    ├── {feature-name}.service.ts
    └── {feature-name}.module.ts
```

### 2.2 API Endpoints

| Método | Endpoint | Descripción | Auth | Roles |
|--------|----------|-------------|------|-------|
| POST | `/api/v1/{recurso}` | Crear {recurso} | ✅ | {ROLES} |
| GET | `/api/v1/{recurso}` | Listar {recursos} | ✅ | {ROLES} |
| GET | `/api/v1/{recurso}/:id` | Obtener {recurso} | ✅ | {ROLES} |
| PATCH | `/api/v1/{recurso}/:id` | Actualizar {recurso} | ✅ | {ROLES} |
| DELETE | `/api/v1/{recurso}/:id` | Eliminar {recurso} | ✅ | {ROLES} |

**Request body (Create):**
```json
{
  "campo1": "string (requerido)",
  "campo2": "string (opcional)"
}
```

**Response:**
```json
{
  "id": "cuid",
  "campo1": "valor",
  "campo2": "valor",
  "createdAt": "ISO-8601",
  "createdBy": { "id": "...", "name": "..." }
}
```

**Errores posibles:**
| Código | HTTP | Cuándo |
|--------|------|--------|
| `{FEATURE}_NOT_FOUND` | 404 | El recurso no existe |
| `{FEATURE}_DUPLICATE` | 409 | Ya existe uno con ese nombre/identificador |
| `FORBIDDEN` | 403 | Sin permiso para la acción |

### 2.3 Base de Datos

**Modelos nuevos o modificados:**

```prisma
model {FeatureName} {
  id          String   @id @default(cuid())
  // {CAMPOS_DEL_MODELO}

  // Auditoría (siempre)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  createdById String
  createdBy   User     @relation(fields: [createdById], references: [id])

  // Índices
  @@index([{CAMPO_BUSCADO}])
}
```

**Cambios en modelos existentes:**
- `{Modelo}`: Agregar campo `{campo}` de tipo `{tipo}`

**Migración:** `npx prisma migrate dev --name {feature_name}_{descripcion}`

### 2.4 Frontend

**Rutas nuevas:**
| Ruta | Componente | Tipo | Descripción |
|------|------------|------|-------------|
| `/projects/{id}/{feature}` | `FeaturePage` | Server | Lista principal |
| `/projects/{id}/{feature}/{itemId}` | `FeatureDetailPage` | Server | Detalle |

**Componentes nuevos:**
```
components/
└── {feature}/
    ├── {feature}-list.tsx      (Server Component)
    ├── {feature}-card.tsx      (Server Component)
    ├── {feature}-form.tsx      (Client Component — tiene estado)
    └── {feature}-detail.tsx    (Server Component + Client islands)
```

**Estado global requerido:** {Sí/No — describe si necesita store}

### 2.5 Eventos de Dominio

| Evento | Cuándo se emite | Payload |
|--------|-----------------|---------|
| `{feature}.created` | Al crear | `{ feature, userId }` |
| `{feature}.updated` | Al actualizar | `{ feature, previousData, userId }` |
| `{feature}.deleted` | Al eliminar | `{ featureId, userId }` |

---

## 3. Plan de Implementación

### Fase 1 — Database (estimado: {X} min)
- [ ] Actualizar `prisma/schema.prisma`
- [ ] Validar schema: `npx prisma validate`
- [ ] Generar migración: `npx prisma migrate dev --name ...`
- [ ] Actualizar Prisma Client: `npx prisma generate`

### Fase 2 — Backend NestJS (estimado: {X} min)
- [ ] Crear DTOs (`CreateDto`, `UpdateDto`)
- [ ] Crear Service con CRUD completo
- [ ] Crear Controller con endpoints
- [ ] Crear Module y registrar providers
- [ ] Importar Module en AppModule
- [ ] **Verificar**: `pnpm build` en `apps/api/` → 0 errores

### Fase 3 — Frontend Next.js (estimado: {X} min)
- [ ] Crear tipos TypeScript en `types/`
- [ ] Crear funciones de API en `services/`
- [ ] Crear componentes UI
- [ ] Crear página(s) con loading.tsx y error.tsx
- [ ] **Verificar**: `pnpm build` en `apps/web/` → 0 errores

---

## 4. Checklist de Calidad Pre-Merge

### Backend
- [ ] DTOs con class-validator en todos los campos
- [ ] Guards en todos los endpoints protegidos
- [ ] AppException (no throw Error genérico)
- [ ] $transaction en operaciones que tocan 2+ tablas
- [ ] Eventos de dominio emitidos
- [ ] Logger en el service
- [ ] Sin lógica de negocio en el controller

### Frontend
- [ ] Separación correcta Server/Client Components
- [ ] loading.tsx creado en cada nueva ruta
- [ ] error.tsx creado en cada nueva ruta
- [ ] try/catch en todas las operaciones async de Client Components
- [ ] toast.error() para errores de usuario
- [ ] Sin `any` innecesario
- [ ] Sin fetch directo (usa api-client)

### General
- [ ] `pnpm build` en API → exit 0
- [ ] `pnpm build` en Web → exit 0
- [ ] Sin console.log en código final
- [ ] Sin TODO/FIXME sin resolver

---

## 5. Siguientes pasos post-implementación

Para auditar el feature recién implementado:

**Con blueprint:** `"Auditoría completa"` → `blueprint-compliance-auditor`

**Individual:**
- `"Revisar mi código"` → `senior-code-auditor`
- `"Auditar seguridad"` → `security-hardening-auditor`
- `"Revisar esquema"` → `prisma-schema-auditor`
- `"Revisar tests"` → `testing-enforcer`
```
