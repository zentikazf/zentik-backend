# 🔒 Informe de Auditoría de Seguridad
## Proyecto: Zentik — Enterprise Project Management Platform
## Fecha: 2026-03-29
## Auditor: Security Hardening Auditor Skill

---

## Estado General: NO APROBADO — 4 hallazgos críticos pendientes

| Categoría | Estado | Hallazgos |
|-----------|--------|-----------|
| SEC-1: Transporte | ✅ | 0 |
| SEC-2: Bootstrap (main.ts) | ✅ | 0 |
| SEC-3: Rate Limiting | ❌ | 1 (CRÍTICO) |
| SEC-4: Autenticación | 🟡 | 2 (1 ALTO, 1 MEDIO) |
| SEC-5: Autorización | ❌ | 1 (CRÍTICO) |
| SEC-6: Validación I/O | 🟡 | 1 (MEDIO) |
| SEC-7: Cabeceras HTTP | ✅ | 0 |
| SEC-8: Base de Datos | 🟡 | 1 (MEDIO) |
| SEC-9: Secretos | ✅ | 0 |
| SEC-10: Dependencias | ✅ | 0 |
| SEC-11: Cookies y Sesiones | 🟡 | 2 (1 CRÍTICO, 1 ALTO) |
| SEC-12: CSRF y File Uploads | 🟡 | 2 (1 CRÍTICO, 1 MEDIO) |

**Total: 10 hallazgos** (4 CRÍTICOS, 2 ALTOS, 4 MEDIOS)

---

## Hallazgos Críticos (corregir inmediatamente)

### ❌ SEC-RATE-001 [CRÍTICO] — app.module.ts

**Problema:** No existe `ThrottlerModule` ni `ThrottlerGuard` configurado. No hay rate limiting en ningún endpoint. Login, register, forgot-password y todos los endpoints están expuestos a fuerza bruta y DDoS a nivel de aplicación.

**Riesgo:** Un atacante puede hacer miles de requests por segundo a `/auth/login` para fuerza bruta de credenciales, o saturar la API con requests masivos.

**Corrección:**

```bash
pnpm add @nestjs/throttler
```

```typescript
// app.module.ts — agregar a imports:
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'short',  ttl: 1000,  limit: 3 },
      { name: 'medium', ttl: 10000, limit: 20 },
      { name: 'long',   ttl: 60000, limit: 100 },
    ]),
    // ...existing imports
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
```

```typescript
// auth.controller.ts — rate limit más estricto en login/register:
import { Throttle } from '@nestjs/throttler';

@Throttle([{ name: 'short', ttl: 60000, limit: 5 }]) // 5 intentos por minuto
@Post('login')
async login(...) { ... }

@Throttle([{ name: 'short', ttl: 60000, limit: 3 }]) // 3 intentos por minuto
@Post('forgot-password')
async forgotPassword(...) { ... }
```

---

### ❌ SEC-COOKIE-001 [CRÍTICO] — auth.controller.ts:36

**Problema:** La cookie de sesión tiene `maxAge` de **30 días** (`SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000`). Para una plataforma empresarial, 30 días es excesivo.

**Riesgo:** Si un token de sesión es robado (ej: via ataque a la red, equipo compartido), el atacante tiene acceso durante 30 días completos.

**Corrección:**

```typescript
// auth.controller.ts:36
- const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
+ const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
```

Y en auth.service.ts:19:
```typescript
- const SESSION_EXPIRY_DAYS = 30;
+ const SESSION_EXPIRY_DAYS = 7;
```

---

### ❌ SEC-COOKIE-002 [CRÍTICO] — auth.controller.ts:240

**Problema:** En producción, `sameSite` está configurado como `'none'`. Esto permite que la cookie se envíe desde cualquier sitio, lo que anula la protección CSRF que ofrece `sameSite`.

**Riesgo:** Cross-Site Request Forgery. Un sitio malicioso puede hacer requests autenticados en nombre del usuario si la cookie se envía con `sameSite: 'none'`.

**Corrección:**

```typescript
// auth.controller.ts:237-243
  private setSessionCookie(res: Response, token: string) {
    const isProduction = this.configService.isProduction;
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProduction,
-     sameSite: isProduction ? 'none' : 'lax',
+     sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    });
  }
```

```typescript
// auth.controller.ts:246-254
  private clearSessionCookie(res: Response) {
    const isProduction = this.configService.isProduction;
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: isProduction,
-     sameSite: isProduction ? 'none' : 'lax',
+     sameSite: 'lax',
      path: '/',
    });
  }
```

> **Nota:** `sameSite: 'lax'` permite navegación normal (links) pero bloquea POST cross-site. Si el frontend está en un dominio diferente al API y necesitas cookies cross-origin, usa `sameSite: 'none'` PERO agrega CSRF tokens explícitos como segunda capa de protección.

---

### ❌ SEC-AUTHZ-001 [CRÍTICO] — task.service.ts, project.service.ts

**Problema:** Los endpoints que acceden a recursos por ID directo (`GET/PATCH/DELETE tasks/:taskId`, `GET/PATCH/DELETE projects/:projectId`) no verifican que el recurso pertenezca a la organización del usuario autenticado. Un usuario de la Organización A puede acceder, modificar o eliminar tareas/proyectos de la Organización B conociendo el CUID.

**Archivos afectados:**
- `task.service.ts:155` — `getTaskById()` no verifica org
- `task.service.ts:199` — `updateTask()` obtiene orgId pero no lo valida contra el usuario
- `task.service.ts:351` — `deleteTask()` mismo patrón
- `task.service.ts:109` — `getTasks()` filtra por projectId sin verificar org
- `project.service.ts:147` — `findById()` no verifica org
- `project.service.ts:217` — `update()` no verifica org
- `project.service.ts:275` — `softDelete()` no verifica org

**Riesgo:** Filtración de datos entre organizaciones. IDOR (Insecure Direct Object Reference). Cualquier usuario autenticado podría enumerar CUIDs y acceder a datos de otras organizaciones. Esto es especialmente grave en una plataforma multi-tenant enterprise.

**Corrección:** Agregar verificación de organización en cada operación por ID. El guard `AuthGuard` ya inyecta `user.organizationId` — usarlo para filtrar:

```typescript
// task.service.ts — getTaskById() ejemplo:
async getTaskById(taskId: string, userOrgId: string) {
  const task = await this.prisma.task.findFirst({
    where: {
      id: taskId,
      project: { organizationId: userOrgId }, // ← filtro por org
    },
    // ...includes
  });
  if (!task) throw new NotFoundException('Tarea no encontrada');
  return task;
}

// project.service.ts — findById() ejemplo:
async findById(projectId: string, userOrgId: string) {
  const project = await this.prisma.project.findFirst({
    where: {
      id: projectId,
      organizationId: userOrgId, // ← filtro por org
    },
    // ...includes
  });
  if (!project) throw new NotFoundException('Proyecto no encontrado');
  return project;
}
```

> **Nota:** Cambiar `findUnique` a `findFirst` con filtro de org, o crear un guard/interceptor reutilizable que inyecte el filtro de organización automáticamente.

---

## Hallazgos Altos (corregir antes de producción)

### 🟠 SEC-AUTH-001 [ALTO] — auth.service.ts:19

**Problema:** Las sesiones de la base de datos expiran en 30 días (`SESSION_EXPIRY_DAYS = 30`). Esto es consistente con el cookie maxAge pero igualmente excesivo.

**Riesgo:** Sesiones de larga duración aumentan la ventana de ataque en caso de token comprometido.

**Corrección:**

```typescript
// auth.service.ts:19
- const SESSION_EXPIRY_DAYS = 30;
+ const SESSION_EXPIRY_DAYS = 7;
```

---

### 🟠 SEC-UPLOAD-001 [ALTO] — file.controller.ts:51

**Problema:** El endpoint `files/upload` tiene límite de tamaño (10MB, correcto) pero NO valida el tipo MIME del archivo. Cualquier tipo de archivo puede ser subido: `.exe`, `.sh`, `.bat`, `.php`, etc.

**Riesgo:** Un atacante autenticado podría subir archivos ejecutables o scripts maliciosos que podrían ser servidos a otros usuarios.

**Corrección:**

```typescript
// file.controller.ts — agregar FileTypeValidator:
import { FileTypeValidator } from '@nestjs/common';

@UploadedFile(
  new ParseFilePipe({
    validators: [
      new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
+     new FileTypeValidator({
+       fileType: /^(image\/(jpeg|png|webp|gif)|application\/pdf|text\/(plain|csv)|application\/vnd\.openxmlformats)$/,
+     }),
    ],
  }),
)
```

---

## Hallazgos Medios (planificar corrección)

### 🟡 SEC-AUTH-002 [MEDIO] — auth.service.ts

**Problema:** No se encontró bloqueo de cuenta tras intentos fallidos de login. Un atacante puede intentar infinitas combinaciones de contraseña sin ser bloqueado (aún sin rate limiting, debería existir bloqueo a nivel de aplicación).

**Corrección:** Implementar un contador de intentos fallidos por email/IP. Bloquear temporalmente después de 5 intentos fallidos durante 15 minutos. Puede usar Redis para el contador.

---

### 🟡 SEC-IO-001 [MEDIO] — report.service.ts:15,38,84,122,168,219,258

**Problema:** Se usan 7 instancias de `$queryRaw` en el servicio de reportes. Aunque Prisma tagged templates previenen SQL injection, estas queries son más difíciles de mantener y auditar que el query builder normal.

**Corrección:** No es crítico porque usan tagged templates (parametrizadas automáticamente), pero verificar que ninguna concatene strings dinámicos. Considerar migrar a Prisma query builder donde sea posible para mejor mantenibilidad.

---

### 🟡 SEC-DB-001 [MEDIO] — .env.example:9

**Problema:** La `DATABASE_URL` en `.env.example` no incluye `?sslmode=require`. Si el equipo copia el ejemplo para producción sin agregar SSL, la conexión a la base de datos sería sin encriptar.

**Corrección:**

```
- DATABASE_URL=postgresql://user:pass@host:5432/zentik?schema=public
+ DATABASE_URL=postgresql://user:pass@host:5432/zentik?schema=public&sslmode=require
```

---

### 🟡 SEC-UPLOAD-002 [MEDIO] — user.controller.ts:66

**Problema:** El endpoint `me/avatar` tiene `FileTypeValidator` correcto (solo imágenes) y `MaxFileSizeValidator` (5MB), pero NO sanitiza el nombre del archivo original. Si `file.originalname` se almacena directamente, podría contener caracteres maliciosos.

**Corrección:** Verificar en `file.service.ts` y `user.service.ts` que se usa un nombre generado (UUID/CUID) para almacenar, no el `originalname` del usuario. (El código actual usa `uniqueKey` generado — verificar que `originalname` solo se guarda como metadata, nunca como nombre de archivo en storage.)

---

## Lo que está BIEN configurado

**SEC-1 Transporte:** ✅ Hosting en Railway/Vercel provee HTTPS + HSTS automáticamente.

**SEC-2 Bootstrap:** ✅ Excelente configuración en `main.ts`:
- `helmet()` configurado ✅
- CORS con whitelist de orígenes (no `*`) ✅
- `ValidationPipe` con `whitelist: true` + `forbidNonWhitelisted: true` + `transform: true` ✅
- `compression()` ✅
- `cookieParser()` ✅
- Global prefix `api/v1` ✅
- `GlobalExceptionFilter` + `LoggingInterceptor` + `TimeoutInterceptor` ✅
- Swagger solo en desarrollo ✅

**SEC-5 Autorización (parcial):** 🟡 Todos los 21 controllers tienen guards correctos (`AuthGuard` / `PermissionsGuard`), PERO los services no verifican ownership a nivel de organización (ver SEC-AUTHZ-001).

**SEC-4 Autenticación (parcial):** ✅ bcrypt con salt rounds 12, passwords hasheados en auth, org-membership y client. No hay passwords en texto plano.

**SEC-7 Cabeceras HTTP:** ✅ Helmet configurado con defaults seguros (CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy).

**SEC-8 Base de Datos:** ✅ Todos los modelos usan `@default(cuid())`. No hay `$queryRawUnsafe` ni `$executeRawUnsafe`. `$queryRaw` usa tagged templates (parametrizados).

**SEC-9 Secretos:** ✅ `.env` en `.gitignore`. `.env.example` existe sin valores reales. `BETTER_AUTH_SECRET` con placeholder de 32+ caracteres. No se encontraron secrets hardcodeados ni `console.log` en el código de producción.

**SEC-10 Dependencias:** ✅ Dependencies actualizadas, no se detectaron paquetes problemáticos conocidos.

**SEC-11 Cookies (parcial):** ✅ `httpOnly: true`, `secure: true` en producción, `cookieParser` configurado. `localStorage` solo se usa para `zentik:orgId` (no sensible, es un ID de organización para UX).

**SEC-12 File Uploads (parcial):** ✅ Avatar endpoint tiene validación completa (tipo + tamaño). Files endpoint tiene validación de tamaño. Storage externo (S3/R2). No hay open redirects.

---

## Resultado

☐ APROBADO para producción
☑ **NO APROBADO** — corregir 3 hallazgos críticos y re-auditar

### Prioridad de corrección:
1. **SEC-AUTHZ-001** — Agregar verificación de organización en task/project services (30 min)
2. **SEC-RATE-001** — Instalar y configurar ThrottlerModule (15 min)
3. **SEC-COOKIE-002** — Cambiar `sameSite: 'none'` a `'lax'` (2 min)
4. **SEC-COOKIE-001** — Reducir session maxAge de 30 a 7 días (2 min)
5. **SEC-AUTH-001** — Reducir SESSION_EXPIRY_DAYS de 30 a 7 (2 min)
6. **SEC-UPLOAD-001** — Agregar FileTypeValidator al endpoint de upload (5 min)
7. Los hallazgos medios se pueden planificar para el próximo sprint.
