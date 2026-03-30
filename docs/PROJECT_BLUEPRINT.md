# ZENTIK — Project Blueprint
## Technical Architecture Document v1.0
### Generated: 2026-03-14 | Stack: NestJS + Next.js + PostgreSQL + Prisma + Redis + Better Auth
### Deployment: Vercel (Frontend) + Railway (Backend + DB + Redis)

---

# TABLA DE CONTENIDOS

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Tech Stack Deep Dive](#3-tech-stack-deep-dive)
4. [Database Design](#4-database-design)
5. [Module Architecture](#5-module-architecture)
6. [API Design](#6-api-design)
7. [Authentication & Authorization](#7-authentication--authorization)
8. [Folder Structure](#8-folder-structure)
9. [Environment & Configuration](#9-environment--configuration)
10. [Error Handling & Logging](#10-error-handling--logging)
11. [Testing Strategy](#11-testing-strategy)
12. [Security Checklist](#12-security-checklist)
13. [Performance & Scalability](#13-performance--scalability)
14. [DevOps & Deployment](#14-devops--deployment)
15. [Development Workflow](#15-development-workflow)
16. [Roadmap & Milestones](#16-roadmap--milestones)
17. [Appendix](#17-appendix)

---

# 1. PROJECT OVERVIEW

## 1.1 Identidad del Proyecto

- **Nombre**: Zentik
- **Version**: 1.0.0
- **Codename**: Nucleus
- **Tipo**: SaaS B2B — Enterprise Project Management Platform
- **Licencia**: Proprietary

## 1.2 Mission Statement

> *"Gestiona toda tu SaaS Factory desde un solo lugar — sin saltar entre 5 herramientas, sin perder contexto, sin facturacion manual."*

Zentik es el sistema nervioso central de una empresa de desarrollo de software. No es otro tablero Kanban. Es la plataforma que conecta proyectos, equipos, tiempo, dinero y comunicacion en un flujo continuo — desde que llega un cliente hasta que se cobra la ultima factura.

## 1.3 Problem Statement

Dirigir una SaaS Factory es como pilotar un avion con los instrumentos repartidos en 5 cabinas diferentes.

Tienes Jira para las tareas. Slack para los mensajes. Google Sheets para las horas. QuickBooks para la facturacion. Y un dashboard mental para saber si el proyecto es rentable o te esta costando dinero.

Las herramientas actuales resuelven UNA parte del problema. Ninguna resuelve EL problema:

- **Visibilidad cero a nivel empresa** — Abres 5 apps para entender como va tu operacion
- **Recursos asignados a ciegas** — No sabes si tu mejor developer esta al 120% de capacidad hasta que se quema
- **Rentabilidad invisible** — Descubres que un proyecto perdio dinero DESPUES de entregarlo
- **Comunicacion fragmentada** — El contexto se pierde entre Slack, email y reuniones de status innecesarias
- **Facturacion manual** — Alguien tiene que sumar horas en un spreadsheet cada fin de mes

Cada hora que un PM pasa recopilando status updates es una hora que no esta liderando. Cada sprint que se planifica sin datos de capacidad real es una apuesta. Cada factura que se genera manualmente es un error esperando a ocurrir.

## 1.4 Proposed Solution

Zentik reemplaza el stack fragmentado con una plataforma unificada. Un login, un contexto, un flujo:

- **Gestion de proyectos** — Tableros Kanban, sprints, backlog, y vistas que se adaptan a como trabaja tu equipo
- **Gestion de equipos** — Ve quien esta disponible, quien esta sobrecargado, y asigna recursos con datos reales
- **Time tracking nativo** — Un click para empezar, un click para parar. Sin app externa, sin friccion
- **Facturacion automatizada** — Genera facturas basadas en horas reales o milestones completados. Cero spreadsheets
- **Reportes que importan** — Rentabilidad por proyecto, productividad por equipo, velocidad por sprint. En tiempo real
- **Chat contextual** — Cada mensaje vive dentro del proyecto donde pertenece. Busca y encuentra en segundos
- **Calendario sincronizado** — Conecta Google Calendar y ve tus deadlines, sprints y reuniones en un solo lugar

## 1.5 SaaS & Multi-Tenancy Model

Zentik es un SaaS B2B multi-tenant. Cada **Organization** es un tenant aislado.

### Tenant Isolation Strategy

Aislamiento a nivel de fila (Row-Level Security):
- Toda tabla con datos de negocio incluye `organizationId` como foreign key
- Toda query se filtra automaticamente por `organizationId` del usuario autenticado
- Prisma middleware inyecta el filtro `WHERE organizationId = ?` de forma transparente
- Un usuario NUNCA puede acceder a datos de otra organizacion, ni por API ni por error de codigo

### Subscription Plans

| Feature | Free | Pro ($29/mes) | Enterprise ($99/mes) |
|---------|:----:|:-------------:|:--------------------:|
| Proyectos activos | 3 | 25 | Ilimitados |
| Miembros | 5 | 25 | Ilimitados |
| Almacenamiento | 1 GB | 25 GB | 100 GB |
| Time tracking | Basico | Avanzado + reportes | Completo + exportar |
| Tableros Kanban | 1 por proyecto | Ilimitados | Ilimitados |
| Sprints | No | Si | Si |
| Chat por proyecto | No | Si | Si |
| Facturacion | No | Basica | Avanzada + PDF |
| Client Portal | No | No | Si |
| Integraciones | GitHub | GitHub + Calendar | Todas |
| Audit Log | 7 dias | 30 dias | 1 ano |
| Soporte | Community | Email (48h) | Prioritario (4h) |
| API Access | No | Si | Si + Webhooks |
| SSO/SAML | No | No | Si |

### Feature Gating Strategy

```typescript
// PlanGuard — NestJS Guard que valida limites del plan antes de cada accion
@Injectable()
export class PlanGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const org = request.organization;
    const requiredFeature = this.reflector.get<string>('plan-feature', context.getHandler());

    if (!org.subscription.hasFeature(requiredFeature)) {
      throw new PlanLimitExceededException(requiredFeature, org.subscription.plan);
    }
    return true;
  }
}

// Uso en controllers
@Post()
@RequiresPlan('projects:create')  // Custom decorator
@UseGuards(AuthGuard, RolesGuard, PlanGuard)
async createProject(@Body() dto: CreateProjectDto) { ... }
```

### Trial Period
- 14 dias de trial en plan Pro (sin tarjeta de credito)
- Al expirar, downgrade automatico a Free (datos preservados, features bloqueadas)
- Notificaciones por email: dia 1, dia 7, dia 12, dia 14

## 1.6 Target Audience — User Personas

### Persona 1: Carlos — CEO / Founder
- **Edad**: 32-45
- **Objetivo**: Ver el estado de TODA la empresa en un dashboard. Saber que proyectos son rentables y cuales no. Tomar decisiones estrategicas basadas en datos.
- **Pain point**: Tiene que abrir 5 herramientas diferentes para entender como va la empresa.
- **Usa Zentik para**: Dashboard ejecutivo, reportes financieros, overview de proyectos.

### Persona 2: Maria — Project Manager
- **Edad**: 28-40
- **Objetivo**: Gestionar 3-5 proyectos simultaneamente sin que se le escape nada. Asignar tareas, controlar sprints, reportar al cliente.
- **Pain point**: Pierde tiempo coordinando entre herramientas y comunicando status manualmente.
- **Usa Zentik para**: Tableros Kanban, sprints, asignacion de equipos, time reports, chat con equipo.

### Persona 3: Diego — Tech Lead / Developer
- **Edad**: 25-35
- **Objetivo**: Saber que tiene que hacer hoy, trackear su tiempo, y no ser interrumpido innecesariamente.
- **Pain point**: Las reuniones de status y los mensajes de "como va X?" le quitan tiempo de deep work.
- **Usa Zentik para**: Lista de tareas personal, time tracker, actualizacion de status, pull request links.

### Persona 4: Laura — Designer / QA
- **Edad**: 24-35
- **Objetivo**: Ver las tareas de diseno o QA asignadas, subir archivos, dejar feedback visual.
- **Pain point**: Los archivos se pierden entre Slack, email y Drive.
- **Usa Zentik para**: Tareas asignadas, subida de archivos, comentarios en tareas, board de QA.

### Persona 5: Cliente Externo (Portal)
- **Edad**: Variable
- **Objetivo**: Ver el progreso de SU proyecto sin molestar al equipo.
- **Pain point**: No sabe en que va su proyecto, tiene que preguntar por email.
- **Usa Zentik para**: Portal de cliente con vista limitada del progreso, milestones, y aprobaciones.

## 1.7 Success Metrics & KPIs

| Metrica | Target v1.0 | Target v2.0 |
|---------|-------------|-------------|
| Usuarios registrados | 500 | 5,000 |
| Organizaciones activas | 20 | 200 |
| Proyectos activos simultaneos | 100 | 1,000 |
| Uptime | 99.5% | 99.9% |
| Tiempo de respuesta API (p95) | < 300ms | < 150ms |
| Tiempo de carga inicial (LCP) | < 2.5s | < 1.5s |
| NPS Score | > 40 | > 60 |
| Churn mensual | < 5% | < 3% |

## 1.8 Project Scope

### IN SCOPE (v1.0)
- **SaaS multi-tenant** con planes Free, Pro, Enterprise y feature gating
- Subscripcion con trial de 14 dias, upgrade/downgrade, usage tracking
- Autenticacion con email/password y OAuth (Google, GitHub)
- Gestion de organizaciones y workspaces (tenant aislado por org)
- RBAC completo con roles y permisos granulares
- Proyectos con tableros Kanban, listas, y calendario
- Tareas con subtareas, labels, prioridades, asignaciones, due dates
- Sprint planning y backlog
- Time tracking por tarea con timer integrado
- Chat en tiempo real por proyecto y canal
- Notificaciones in-app y por email
- Subida de archivos con preview
- Reportes basicos: productividad, horas por proyecto, burndown
- Facturacion basica por proyecto (horas × tarifa)
- Integracion con Google Calendar
- Integracion con GitHub (link PRs a tareas)
- API REST documentada con Swagger
- Portal de cliente con vista limitada

### OUT OF SCOPE (v1.0 — Planned for v2.0+)
- AI-powered task suggestions y estimaciones
- Workflow automation engine
- Integracion con Slack, Jira, Figma
- White-labeling
- Mobile app nativa
- Wiki / Knowledge base
- Resource planning avanzado con Gantt charts
- Multi-currency billing
- Video calls integrados

## 1.9 Technical Decision Rationale

| Tecnologia | Justificacion |
|------------|---------------|
| **NestJS** | Framework enterprise-grade para Node.js. Arquitectura modular con DI nativo, excelente para APIs escalables. TypeScript-first. Soporte oficial para WebSockets, GraphQL, microservicios. |
| **Next.js** | Framework React production-ready con App Router, Server Components, y SSR/SSG. Optimo para SEO y performance. Deploy nativo en Vercel. |
| **PostgreSQL** | Base de datos relacional mas robusta del ecosistema open source. JSONB para datos flexibles, full-text search, extensiones avanzadas. Ideal para datos relacionales complejos como proyectos-tareas-usuarios. |
| **Prisma** | ORM type-safe con auto-generacion de tipos TypeScript. Migraciones declarativas, Prisma Studio para debug, excelente DX. |
| **Redis** | Cache in-memory para sesiones, rate limiting, colas de trabajo, y pub/sub para real-time. Latencia sub-millisecond. |
| **Better Auth** | Solucion de auth moderna para TypeScript. Sessions server-side, RBAC nativo, OAuth plug-and-play, y no depende de servicios externos como Auth0 o Clerk (reduce costos). |
| **TypeScript** | Type safety end-to-end. Shared types entre frontend y backend. Reduce bugs en runtime, mejora DX con autocompletado. |

---

# 2. SYSTEM ARCHITECTURE

## 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │ Browser  │  │ Mobile   │  │ External │  │ Client Portal    │    │
│  │ (Next.js)│  │ (Future) │  │ APIs     │  │ (Next.js)        │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘    │
└───────┼──────────────┼─────────────┼─────────────────┼──────────────┘
        │              │             │                 │
        ▼              ▼             ▼                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        VERCEL EDGE NETWORK                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Next.js App (SSR/SSG)                     │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │    │
│  │  │ Pages    │ │ Server   │ │ Server   │ │ Middleware    │   │    │
│  │  │ (RSC)    │ │ Actions  │ │ API      │ │ (Auth Check)  │   │    │
│  │  └──────────┘ └──────────┘ │ Routes   │ └──────────────┘   │    │
│  │                            └──────────┘                     │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
└─────────────────────────────┼───────────────────────────────────────┘
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        RAILWAY CLOUD                                │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                  NestJS API Server                           │    │
│  │                                                              │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │    │
│  │  │ Guards   │ │ Pipes    │ │ Inter-   │ │ Exception    │   │    │
│  │  │ (Auth)   │ │ (Valid.) │ │ ceptors  │ │ Filters      │   │    │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘   │    │
│  │       ▼            ▼            ▼               ▼           │    │
│  │  ┌──────────────────────────────────────────────────────┐   │    │
│  │  │              Controllers (REST API v1)                │   │    │
│  │  └──────────────────────┬───────────────────────────────┘   │    │
│  │                         ▼                                   │    │
│  │  ┌──────────────────────────────────────────────────────┐   │    │
│  │  │            Services (Business Logic)                  │   │    │
│  │  └────────┬──────────────┬──────────────┬───────────────┘   │    │
│  │           ▼              ▼              ▼                   │    │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────────────┐      │    │
│  │  │ Prisma     │ │ Redis      │ │ External Services  │      │    │
│  │  │ Client     │ │ Client     │ │ (SendGrid, S3...)  │      │    │
│  │  └─────┬──────┘ └─────┬──────┘ └────────────────────┘      │    │
│  │        │              │                                     │    │
│  └────────┼──────────────┼─────────────────────────────────────┘    │
│           ▼              ▼                                          │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────────┐      │
│  │  PostgreSQL    │ │    Redis       │ │  BullMQ Workers    │      │
│  │  (Railway)     │ │  (Railway)     │ │  (Background Jobs) │      │
│  │                │ │                │ │                     │      │
│  │  - Main DB     │ │  - Sessions    │ │  - Email sending   │      │
│  │  - Read replica│ │  - Cache       │ │  - Notifications   │      │
│  │  (future)      │ │  - Rate limit  │ │  - Report gen      │      │
│  │                │ │  - Pub/Sub     │ │  - File processing │      │
│  │                │ │  - Job queues  │ │                     │      │
│  └────────────────┘ └────────────────┘ └────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

## 2.2 Architecture Pattern: Modular Monolith

Zentik utiliza un **Modular Monolith** — un solo deployable pero con boundaries claros entre modulos. Esto permite:

- **Velocidad de desarrollo**: No hay overhead de microservicios (networking, serialization, deployment independiente)
- **Boundaries claros**: Cada modulo encapsula su dominio y expone interfaces definidas
- **Evolucion**: Si un modulo necesita escalar independientemente en el futuro, se puede extraer a microservicio sin refactorizar el dominio
- **Consistencia transaccional**: Operaciones cross-module pueden usar transacciones de base de datos

### Reglas del Modular Monolith:
1. Un modulo NUNCA importa repositorios o entidades de otro modulo directamente
2. La comunicacion entre modulos es via **servicios publicos** o **eventos de dominio**
3. Cada modulo tiene su propio directorio con controllers, services, DTOs, entities
4. Los modulos compartidos (common, config, health) son la excepcion

## 2.3 Layer Breakdown

```
┌─────────────────────────────────────────┐
│         Presentation Layer              │  Next.js (Vercel)
│   Pages, Components, Hooks, Stores      │
├─────────────────────────────────────────┤
│         API Gateway Layer               │  NestJS Controllers
│   Routes, Guards, Pipes, Interceptors   │
├─────────────────────────────────────────┤
│         Application Layer               │  NestJS Services
│   Use Cases, DTOs, Mappers              │
├─────────────────────────────────────────┤
│         Domain Layer                    │  Entities, Value Objects
│   Business Rules, Domain Events         │
├─────────────────────────────────────────┤
│         Infrastructure Layer            │  Prisma, Redis, SendGrid
│   Repositories, External Adapters       │
└─────────────────────────────────────────┘
```

## 2.4 Communication Patterns

### REST API Conventions
- Versionado: `/api/v1/`
- Naming: kebab-case para URLs (`/api/v1/time-entries`)
- Metodos: GET (read), POST (create), PATCH (partial update), DELETE (remove)
- No usar PUT — PATCH es suficiente y mas flexible

### WebSocket Strategy
- **Tecnologia**: Socket.IO via `@nestjs/websockets`
- **Uso**: Chat en tiempo real, notificaciones push, actualizacion de tableros en vivo
- **Rooms**: Cada proyecto tiene su room, cada canal de chat tiene su room
- **Auth**: Token JWT validado en el handshake

### Event-Driven Patterns
- **Domain Events**: Emitidos via `EventEmitter2` de NestJS
- Ejemplos: `TaskCreated`, `TaskAssigned`, `SprintCompleted`, `InvoiceGenerated`
- Los eventos disparan side effects (notificaciones, audit logs, cache invalidation)
- Patron: Fire-and-forget para side effects, sincrono para business logic critica

## 2.5 Critical Data Flow Diagrams

### Flow 1: Crear y Asignar una Tarea

```mermaid
sequenceDiagram
    actor PM as Project Manager
    participant Web as Next.js
    participant API as NestJS API
    participant DB as PostgreSQL
    participant Cache as Redis
    participant WS as WebSocket
    participant Email as SendGrid

    PM->>Web: Crea tarea en Kanban board
    Web->>API: POST /api/v1/projects/:id/tasks
    API->>API: Validate DTO (class-validator)
    API->>API: Check permissions (Guard)
    API->>DB: INSERT task + assignment
    API->>Cache: Invalidate project board cache
    API-->>Web: 201 Created {task}
    API->>WS: Emit "task:created" to project room
    WS-->>Web: Real-time board update (all members)
    API->>Email: Queue notification email to assignee
    API->>DB: INSERT audit_log entry
```

### Flow 2: Autenticacion con OAuth (Google)

```mermaid
sequenceDiagram
    actor User
    participant Web as Next.js
    participant Auth as Better Auth
    participant Google as Google OAuth
    participant DB as PostgreSQL
    participant Redis as Redis

    User->>Web: Click "Sign in with Google"
    Web->>Auth: Initiate OAuth flow
    Auth->>Google: Redirect to Google consent
    Google-->>Auth: Authorization code
    Auth->>Google: Exchange code for tokens
    Google-->>Auth: Access token + profile
    Auth->>DB: Find or create user
    Auth->>Redis: Create session
    Auth-->>Web: Set session cookie
    Web-->>User: Redirect to dashboard
```

### Flow 3: Time Tracking con Timer

```mermaid
sequenceDiagram
    actor Dev as Developer
    participant Web as Next.js
    participant API as NestJS API
    participant Redis as Redis
    participant DB as PostgreSQL

    Dev->>Web: Click "Start Timer" on task
    Web->>API: POST /api/v1/time-entries/start
    API->>Redis: SET timer:{userId}:{taskId} = timestamp
    API-->>Web: 200 OK {timer started}

    Note over Dev,DB: Developer works...

    Dev->>Web: Click "Stop Timer"
    Web->>API: POST /api/v1/time-entries/stop
    API->>Redis: GET timer:{userId}:{taskId}
    API->>Redis: DEL timer:{userId}:{taskId}
    API->>API: Calculate duration
    API->>DB: INSERT time_entry
    API->>DB: UPDATE task.total_time
    API-->>Web: 200 OK {time_entry}
```

---

# 3. TECH STACK DEEP DIVE

## 3.1 Backend — NestJS

- **Version**: 10.x (LTS)
- **Runtime**: Node.js 20 LTS

### Module System Organization
Cada feature es un modulo NestJS autocontenido. Los modulos se registran en `AppModule` y se comunican via dependency injection. NUNCA via service locator.

```typescript
// Ejemplo: TaskModule — note Repository + Event-driven pattern
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    EventEmitterModule, // For domain events
  ],
  controllers: [TaskController],
  providers: [
    TaskService,          // Business logic ONLY
    TaskRepository,       // Database access ONLY (Repository Pattern)
    TaskMapper,           // Entity ↔ DTO mapping
    TaskEventListener,    // React to domain events
  ],
  exports: [TaskService], // Public API — other modules NEVER import Repository
})
export class TaskModule {}
```

### Architecture Patterns Applied (from nestjs-best-practices)

**Repository Pattern** — Services NEVER touch Prisma directly:
```typescript
// task.repository.ts — Encapsulates ALL database queries
@Injectable()
export class TaskRepository {
  constructor(private prisma: PrismaService) {}

  async findById(id: string): Promise<Task | null> {
    return this.prisma.task.findUnique({
      where: { id },
      select: { id: true, title: true, status: true, priority: true, assignees: true },
    });
  }

  async findByProject(projectId: string, filters: TaskFilterDto): Promise<PaginatedResult<Task>> {
    const [tasks, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where: { projectId, status: { in: filters.statuses }, deletedAt: null },
        orderBy: { [filters.sortBy]: filters.order },
        skip: filters.offset,
        take: filters.limit,
      }),
      this.prisma.task.count({ where: { projectId, deletedAt: null } }),
    ]);
    return { data: tasks, total, page: filters.page, limit: filters.limit };
  }
}

// task.service.ts — Business logic ONLY, no Prisma imports
@Injectable()
export class TaskService {
  constructor(
    private taskRepo: TaskRepository,        // Data access
    private eventEmitter: EventEmitter2,     // Domain events
  ) {}

  async create(dto: CreateTaskDto, userId: string): Promise<Task> {
    const task = await this.taskRepo.create(dto);
    // Fire event — NotificationModule, AuditModule react WITHOUT coupling
    this.eventEmitter.emit('task.created', new TaskCreatedEvent(task, userId));
    return task;
  }
}
```

**Event-Driven Architecture** — Modulos desacoplados via EventEmitter2:
```typescript
// En NotificationModule — reacts to events from TaskModule
@Injectable()
export class TaskEventListener {
  constructor(private notificationService: NotificationService) {}

  @OnEvent('task.assigned')
  async handleTaskAssigned(event: TaskAssignedEvent): Promise<void> {
    await this.notificationService.create({
      userId: event.assigneeId,
      type: NotificationType.TASK_ASSIGNED,
      title: `Te asignaron la tarea "${event.taskTitle}"`,
      link: `/projects/${event.projectId}/tasks/${event.taskId}`,
    });
  }

  @OnEvent('task.completed')
  async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    await this.notificationService.notifyProjectManagers(event.projectId, {
      type: NotificationType.TASK_UPDATED,
      title: `Tarea "${event.taskTitle}" completada`,
    });
  }
}
```

**Prisma Transactions** — Para operaciones multi-step:
```typescript
// Crear sprint y mover tareas del backlog — todo o nada
async startSprint(sprintId: string, taskIds: string[]): Promise<Sprint> {
  return this.prisma.$transaction(async (tx) => {
    const sprint = await tx.sprint.update({
      where: { id: sprintId },
      data: { status: 'ACTIVE', startDate: new Date() },
    });

    await tx.task.updateMany({
      where: { id: { in: taskIds } },
      data: { sprintId, status: 'TODO' },
    });

    return sprint;
    // Si algo falla, TODO se revierte automaticamente
  });
}
```

### Middleware Pipeline (order of execution)
1. **Global Middleware** → CORS, Helmet, Compression, Correlation ID
2. **Guards** → AuthGuard → OrgGuard → RolesGuard → PlanGuard
3. **Interceptors** → LoggingInterceptor → TransformInterceptor → TimeoutInterceptor → CacheInterceptor
4. **Pipes** → ValidationPipe (whitelist + transform + forbidNonWhitelisted)
5. **Controller** → Route handler
6. **Exception Filters** → DomainExceptionFilter → GlobalExceptionFilter (catch-all)

### Input Validation — Global ValidationPipe
```typescript
// main.ts — toda entrada validada automaticamente
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,              // Elimina propiedades no declaradas en DTO
    forbidNonWhitelisted: true,   // Lanza error si envian propiedades extra
    transform: true,              // Auto-transforma tipos (string "5" → number 5)
    transformOptions: {
      enableImplicitConversion: true,
    },
  }),
);
```

### Custom Decorators Strategy
```typescript
@CurrentUser()                   // Extract user from session
@Roles('admin', 'pm')           // Set required roles (RolesGuard)
@Permissions('task:create')      // Granular permission check
@RequiresPlan('sprints')         // Plan feature gate (PlanGuard)
@OrgContext()                    // Inject organizationId into request
@ApiPaginated()                  // Swagger pagination docs
@Cacheable({ ttl: 60 })         // Redis cache decorator
```

## 3.2 Frontend — Next.js

- **Version**: 14.x (App Router)
- **Runtime**: React 18 con Server Components

### Rendering Strategy Decision Matrix

| Pagina | Estrategia | Justificacion |
|--------|-----------|---------------|
| Landing / Marketing | SSG | Contenido estatico, maximo SEO |
| Login / Register | SSR | Necesita redirect si ya autenticado |
| Dashboard | SSR + CSR | Data inicial server-side, updates via client |
| Kanban Board | CSR | Altamente interactivo, drag & drop, WebSocket |
| Settings | SSR | Formularios simples, poca interactividad |
| Reports | SSR + ISR | Datos pesados, cacheable por 5 min |
| Profile | SSR | Data personal, no cacheable |

### Server Components vs Client Components (RSC Boundaries)

**Regla de oro**: Todo es Server Component por defecto. Solo agregas `"use client"` cuando NECESITAS interactividad.

**Props entre Server → Client deben ser JSON-serializable**:
- Strings, numbers, booleans, plain objects, arrays → OK
- `Date` objects → Convertir a `.toISOString()` antes de pasar
- Functions → PROHIBIDO (excepto Server Actions con `"use server"`)
- `Map`, `Set`, class instances → Convertir a plain objects

```
Server Components (default — sin "use client"):
├── Layouts (data fetching directo, sin API round-trip)
├── Pages (initial data fetch con await)
├── Data display components (tables, lists, cards)
├── Navigation (links, breadcrumbs)
└── Static content

Client Components ("use client" — solo cuando es necesario):
├── Interactive forms (input state, validation)
├── Kanban board (drag & drop con dnd-kit)
├── Chat interface (WebSocket, typing indicators)
├── Timer component (setInterval, live counter)
├── Modals and dropdowns (open/close state)
├── Real-time subscriptions (Socket.IO)
└── State-dependent UI (filters, toggles)
```

### Data Fetching Patterns (from next-best-practices)

```
Decision tree:
├── Read data from Server Component?
│   └── Fetch directo (Prisma, API call) — NO crear API route
│
├── Mutation from Client Component?
│   └── Server Action ("use server") — NO fetch POST
│
├── Read from Client Component?
│   └── Pasar data desde Server Component parent → client child
│
├── External API access (webhooks, mobile app)?
│   └── Route Handler (app/api/)
│
└── Evitar waterfalls?
    ├── Promise.all() para fetches paralelos
    └── Suspense boundaries para streaming progressivo
```

```tsx
// Ejemplo Zentik: Dashboard con streaming
// app/(dashboard)/page.tsx — Server Component
import { Suspense } from 'react';

export default async function DashboardPage() {
  return (
    <div className="grid grid-cols-3 gap-6">
      <Suspense fallback={<ProjectsSkeleton />}>
        <ActiveProjectsSection />  {/* Fetch independiente */}
      </Suspense>
      <Suspense fallback={<TasksSkeleton />}>
        <MyTasksSection />          {/* Fetch independiente */}
      </Suspense>
      <Suspense fallback={<TimeSkeleton />}>
        <TimeReportSection />       {/* Fetch independiente */}
      </Suspense>
    </div>
  );
}

// Cada seccion fetches en paralelo, se renderiza cuando esta lista
async function ActiveProjectsSection() {
  const projects = await projectService.getActiveByOrg(orgId);
  return <ProjectGrid projects={projects} />;
}
```

```tsx
// Ejemplo Zentik: Server Action para crear tarea
// app/actions/task.ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function createTask(formData: FormData) {
  const title = formData.get('title') as string;
  const projectId = formData.get('projectId') as string;

  let task;
  try {
    task = await taskService.create({ title, projectId });
  } catch (error) {
    return { error: 'No se pudo crear la tarea. Intenta de nuevo.' };
  }

  revalidatePath(`/projects/${projectId}/board`);
  redirect(`/projects/${projectId}/tasks/${task.id}`);
  // redirect() FUERA del try-catch — lanza error interno de Next.js
}
```

### Routing Architecture
```
app/
├── (marketing)/           # Public pages group
│   ├── page.tsx           # Landing
│   ├── pricing/page.tsx
│   └── layout.tsx         # Marketing layout (navbar, footer)
├── (auth)/                # Auth pages group
│   ├── login/page.tsx
│   ├── register/page.tsx
│   ├── forgot-password/page.tsx
│   └── layout.tsx         # Minimal auth layout
├── (dashboard)/           # Protected app group
│   ├── layout.tsx         # App layout (sidebar, topbar)
│   ├── page.tsx           # Dashboard home
│   ├── projects/
│   │   ├── page.tsx       # Project list
│   │   └── [projectId]/
│   │       ├── page.tsx   # Project overview
│   │       ├── board/page.tsx
│   │       ├── backlog/page.tsx
│   │       ├── sprints/page.tsx
│   │       ├── tasks/[taskId]/page.tsx
│   │       ├── time/page.tsx
│   │       ├── chat/page.tsx
│   │       ├── files/page.tsx
│   │       ├── settings/page.tsx
│   │       └── billing/page.tsx
│   ├── calendar/page.tsx
│   ├── reports/page.tsx
│   ├── team/page.tsx
│   ├── settings/
│   │   ├── page.tsx       # Org settings
│   │   ├── members/page.tsx
│   │   ├── roles/page.tsx
│   │   ├── billing/page.tsx
│   │   └── integrations/page.tsx
│   └── profile/page.tsx
└── api/                   # Next.js API routes (BFF proxy if needed)
```

## 3.3 Database — PostgreSQL

- **Version**: 16.x
- **Extensions**:
  - `uuid-ossp` — UUID generation
  - `pgcrypto` — Encryption functions
  - `pg_trgm` — Trigram-based text search (fuzzy search on tasks/projects)

### Connection Pooling
- Prisma connection pool: `connection_limit=10` per Railway instance
- For +5000 users: Add PgBouncer proxy on Railway when scaling

### Indexing Strategy
- Primary keys: UUID v4 (indexed by default)
- Foreign keys: Always indexed
- Filterable fields: `status`, `priority`, `assigneeId`, `projectId`
- Search fields: GIN index on `title` and `description` using `pg_trgm`
- Composite indexes: `(projectId, status)`, `(assigneeId, dueDate)`
- Partial indexes: `WHERE deletedAt IS NULL` for soft-deleted records

## 3.4 ORM — Prisma

- **Version**: 5.x
- **Schema**: Single `schema.prisma` file (split to multi-file when exceeding 500 lines with `prismaSchemaFolder` preview feature)

### Migration Strategy
- Development: `prisma migrate dev` — auto-generates SQL migrations
- Production: `prisma migrate deploy` — runs pending migrations in CI/CD
- Naming: Migrations use descriptive names (`20260314_add_time_entries_table`)
- Rule: NEVER edit a deployed migration. Create a new one instead.

### Seeding Strategy
```typescript
// prisma/seed.ts
// 1. Create default roles and permissions
// 2. Create admin user
// 3. Create demo organization with sample project
// 4. Create sample tasks, sprints, time entries
// Use faker.js for realistic test data
```

### Query Optimization Patterns
- Always use `select` to pick only needed fields
- Use `include` sparingly — prefer explicit `select` with nested fields
- Paginate with cursor-based pagination for large datasets
- Use `createMany` and `updateMany` for bulk operations
- Use raw SQL via `$queryRaw` only for complex aggregations

## 3.5 Cache — Redis

- **Version**: 7.x (Railway managed)
- **Client**: `ioredis` via `@nestjs/cache-manager`

### Caching Strategy: Cache-Aside Pattern
1. Check Redis for cached data
2. If cache HIT → return cached data
3. If cache MISS → query PostgreSQL → store in Redis → return data
4. On data mutation → invalidate relevant cache keys

### Key Naming Convention
```
zentik:{scope}:{entity}:{identifier}:{sub}

Examples:
zentik:org:123:projects              # List of projects for org 123
zentik:project:456:board             # Kanban board data
zentik:user:789:notifications        # User notification count
zentik:session:{sessionId}           # User session
zentik:ratelimit:{ip}:{endpoint}     # Rate limit counter
zentik:timer:{userId}:{taskId}       # Active timer
```

### TTL Policies

| Data Type | TTL | Justification |
|-----------|-----|---------------|
| Session | 7 days | Balance security and UX |
| Board data | 30 seconds | Frequently updated, stale is visible |
| Project list | 5 minutes | Moderately updated |
| User profile | 15 minutes | Rarely changes |
| Reports | 10 minutes | Expensive queries, acceptable staleness |
| Rate limit counters | 1 minute | Rolling window |
| Active timers | No expiry | Deleted on stop |

### Pub/Sub for Real-Time
- Channel per project room: `zentik:ws:project:{projectId}`
- Channel per user notifications: `zentik:ws:user:{userId}`
- Used to broadcast events from API servers to WebSocket gateway

## 3.6 Auth — Better Auth

### Authentication Flows
- **Email + Password**: Registration with email verification, login with session cookie
- **OAuth**: Google and GitHub providers configured
- **Magic Link**: Email-based passwordless login (via SendGrid)
- **Password Reset**: Token-based reset flow with expiration

### Session Management
- **Storage**: Redis-backed sessions (not JWT — sessions are revocable)
- **Cookie**: `HttpOnly`, `Secure`, `SameSite=Lax`
- **Duration**: 7 days, refresh on activity
- **Device Tracking**: Store device info per session for "active sessions" UI

### RBAC Design
Better Auth's built-in RBAC extended with custom permissions:

```
SuperAdmin (platform level)
├── Admin (organization level)
│   ├── ProjectManager
│   │   ├── Developer
│   │   ├── Designer
│   │   └── QA
│   └── Viewer (read-only)
└── Client (external, limited access)
```

### Integration with NestJS Guards
```typescript
@UseGuards(AuthGuard)           // Session validation
@UseGuards(AuthGuard, RolesGuard)  // Session + role check
@Roles('admin', 'pm')           // Required roles
@Permissions('task:create')      // Granular permissions
```

## 3.7 Language — TypeScript

### TSConfig — Backend (apps/api/tsconfig.json)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "strict": true,
    "strictNullChecks": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "paths": {
      "@modules/*": ["src/modules/*"],
      "@common/*": ["src/common/*"],
      "@config/*": ["src/config/*"]
    }
  }
}
```

### TSConfig — Frontend (apps/web/tsconfig.json)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "preserve",
    "strict": true,
    "paths": {
      "@/*": ["./src/*"],
      "@components/*": ["./src/components/*"],
      "@hooks/*": ["./src/hooks/*"],
      "@lib/*": ["./src/lib/*"]
    }
  }
}
```

### Shared Types Strategy
- Paquete `packages/shared-types` en el monorepo
- Contiene: interfaces de API responses, enums compartidos, DTOs base
- Importado por ambos apps via workspace dependencies

---

# 4. DATABASE DESIGN

## 4.1 Entity-Relationship Diagram

```mermaid
erDiagram
    Organization ||--|| Subscription : has
    Organization ||--o{ OrganizationMember : has
    Organization ||--o{ Project : owns
    Organization ||--o{ Role : defines
    Organization ||--o{ InviteLink : creates

    User ||--o{ OrganizationMember : joins
    User ||--o{ Session : has
    User ||--o{ Account : has
    User ||--o{ TaskAssignment : assigned
    User ||--o{ TimeEntry : tracks
    User ||--o{ Comment : writes
    User ||--o{ Message : sends
    User ||--o{ Notification : receives
    User ||--o{ AuditLog : performs

    OrganizationMember ||--o{ ProjectMember : participates
    OrganizationMember }o--|| Role : has

    Role ||--o{ RolePermission : grants
    Permission ||--o{ RolePermission : assigned

    Project ||--o{ ProjectMember : includes
    Project ||--o{ Board : contains
    Project ||--o{ Sprint : has
    Project ||--o{ Task : contains
    Project ||--o{ Label : defines
    Project ||--o{ Channel : has
    Project ||--o{ Invoice : generates
    Project ||--o{ File : stores

    Board ||--o{ BoardColumn : has
    BoardColumn ||--o{ Task : contains

    Sprint ||--o{ Task : includes

    Task ||--o{ Task : subtasks
    Task ||--o{ TaskAssignment : has
    Task ||--o{ TimeEntry : tracked
    Task ||--o{ Comment : has
    Task ||--o{ TaskLabel : tagged
    Task ||--o{ File : attached
    Task }o--o| Sprint : belongs
    Task }o--|| BoardColumn : positioned

    Label ||--o{ TaskLabel : applied

    Channel ||--o{ Message : contains

    Invoice ||--o{ InvoiceItem : contains
```

## 4.2 Complete Prisma Schema

```prisma
// ============================================
// ENUMS
// ============================================

enum ProjectStatus {
  PLANNING
  ACTIVE
  ON_HOLD
  COMPLETED
  ARCHIVED
}

enum TaskPriority {
  URGENT
  HIGH
  MEDIUM
  LOW
  NONE
}

enum TaskStatus {
  BACKLOG
  TODO
  IN_PROGRESS
  IN_REVIEW
  TESTING
  DONE
  CANCELLED
}

enum SprintStatus {
  PLANNING
  ACTIVE
  COMPLETED
  CANCELLED
}

enum InvoiceStatus {
  DRAFT
  SENT
  PAID
  OVERDUE
  CANCELLED
}

enum SubscriptionStatus {
  TRIALING
  ACTIVE
  PAST_DUE
  CANCELLED
  EXPIRED
}

enum BillingCycle {
  MONTHLY
  YEARLY
}

enum PlanTier {
  FREE
  PRO
  ENTERPRISE
}

enum NotificationType {
  TASK_ASSIGNED
  TASK_UPDATED
  TASK_COMMENTED
  SPRINT_STARTED
  SPRINT_COMPLETED
  MENTION
  INVITATION
  INVOICE_SENT
  SYSTEM
}

enum FileCategory {
  ATTACHMENT
  AVATAR
  PROJECT_COVER
  DOCUMENT
}

// ============================================
// AUTH ENTITIES (Better Auth managed)
// ============================================

model User {
  id              String   @id @default(uuid())
  email           String   @unique
  emailVerified   Boolean  @default(false)
  name            String
  image           String?
  timezone        String   @default("UTC")
  locale          String   @default("es")
  onboardingDone  Boolean  @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  accounts        Account[]
  sessions        Session[]
  memberships     OrganizationMember[]
  taskAssignments TaskAssignment[]
  timeEntries     TimeEntry[]
  comments        Comment[]
  messages        Message[]
  notifications   Notification[]
  auditLogs       AuditLog[]

  @@map("users")
}

model Account {
  id                String   @id @default(uuid())
  userId            String
  accountId         String
  providerId        String
  accessToken       String?
  refreshToken      String?
  accessTokenExpiresAt DateTime?
  refreshTokenExpiresAt DateTime?
  scope             String?
  idToken           String?
  password          String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("accounts")
}

model Session {
  id        String   @id @default(uuid())
  userId    String
  token     String   @unique
  ipAddress String?
  userAgent String?
  expiresAt DateTime
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("sessions")
}

// ============================================
// ORGANIZATION & ROLES
// ============================================

model Organization {
  id          String   @id @default(uuid())
  name        String
  slug        String   @unique
  logo        String?
  description String?
  website     String?
  plan        String   @default("free")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?

  members      OrganizationMember[]
  projects     Project[]
  roles        Role[]
  inviteLinks  InviteLink[]
  subscription Subscription?

  @@index([slug])
  @@map("organizations")
}

model Subscription {
  id                  String             @id @default(uuid())
  organizationId      String             @unique
  plan                PlanTier           @default(FREE)
  status              SubscriptionStatus @default(TRIALING)
  billingCycle        BillingCycle       @default(MONTHLY)
  trialEndsAt         DateTime?
  currentPeriodStart  DateTime           @default(now())
  currentPeriodEnd    DateTime
  cancelledAt         DateTime?
  maxProjects         Int                @default(3)
  maxMembers          Int                @default(5)
  maxStorageBytes     BigInt             @default(1073741824) // 1 GB
  features            Json               @default("[]")
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("subscriptions")
}

model OrganizationMember {
  id             String   @id @default(uuid())
  userId         String
  organizationId String
  roleId         String
  joinedAt       DateTime @default(now())
  updatedAt      DateTime @updatedAt

  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  role           Role         @relation(fields: [roleId], references: [id])
  projectMembers ProjectMember[]

  @@unique([userId, organizationId])
  @@map("organization_members")
}

model Role {
  id             String   @id @default(uuid())
  name           String
  description    String?
  organizationId String
  isDefault      Boolean  @default(false)
  isSystem       Boolean  @default(false)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  permissions    RolePermission[]
  members        OrganizationMember[]

  @@unique([name, organizationId])
  @@map("roles")
}

model Permission {
  id          String   @id @default(uuid())
  action      String
  resource    String
  description String?

  roles RolePermission[]

  @@unique([action, resource])
  @@map("permissions")
}

model RolePermission {
  id           String @id @default(uuid())
  roleId       String
  permissionId String

  role       Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@unique([roleId, permissionId])
  @@map("role_permissions")
}

model InviteLink {
  id             String   @id @default(uuid())
  organizationId String
  code           String   @unique
  roleId         String
  maxUses        Int?
  uses           Int      @default(0)
  expiresAt      DateTime?
  createdAt      DateTime @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("invite_links")
}

// ============================================
// PROJECTS
// ============================================

model Project {
  id             String        @id @default(uuid())
  organizationId String
  name           String
  slug           String
  description    String?
  status         ProjectStatus @default(PLANNING)
  coverImage     String?
  hourlyRate     Decimal?      @db.Decimal(10, 2)
  currency       String        @default("USD")
  startDate      DateTime?
  endDate        DateTime?
  clientName     String?
  clientEmail    String?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt
  deletedAt      DateTime?

  organization Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  members      ProjectMember[]
  boards       Board[]
  sprints      Sprint[]
  tasks        Task[]
  labels       Label[]
  channels     Channel[]
  invoices     Invoice[]
  files        File[]

  @@unique([slug, organizationId])
  @@index([organizationId, status])
  @@map("projects")
}

model ProjectMember {
  id                   String   @id @default(uuid())
  projectId            String
  organizationMemberId String
  role                 String   @default("member")
  joinedAt             DateTime @default(now())

  project            Project            @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organizationMember OrganizationMember @relation(fields: [organizationMemberId], references: [id], onDelete: Cascade)

  @@unique([projectId, organizationMemberId])
  @@map("project_members")
}

// ============================================
// BOARDS & KANBAN
// ============================================

model Board {
  id        String   @id @default(uuid())
  projectId String
  name      String
  isDefault Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project Project       @relation(fields: [projectId], references: [id], onDelete: Cascade)
  columns BoardColumn[]

  @@map("boards")
}

model BoardColumn {
  id       String @id @default(uuid())
  boardId  String
  name     String
  position Int
  color    String @default("#6B7280")
  wipLimit Int?

  board Board  @relation(fields: [boardId], references: [id], onDelete: Cascade)
  tasks Task[]

  @@map("board_columns")
}

// ============================================
// SPRINTS
// ============================================

model Sprint {
  id          String       @id @default(uuid())
  projectId   String
  name        String
  goal        String?
  status      SprintStatus @default(PLANNING)
  startDate   DateTime?
  endDate     DateTime?
  velocity    Int?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  tasks   Task[]

  @@index([projectId, status])
  @@map("sprints")
}

// ============================================
// TASKS
// ============================================

model Task {
  id             String       @id @default(uuid())
  projectId      String
  sprintId       String?
  boardColumnId  String?
  parentId       String?
  title          String
  description    String?
  status         TaskStatus   @default(BACKLOG)
  priority       TaskPriority @default(NONE)
  position       Int          @default(0)
  storyPoints    Int?
  dueDate        DateTime?
  startDate      DateTime?
  completedAt    DateTime?
  estimatedHours Decimal?     @db.Decimal(6, 2)
  totalTimeSpent Int          @default(0) // seconds
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
  deletedAt      DateTime?

  project     Project          @relation(fields: [projectId], references: [id], onDelete: Cascade)
  sprint      Sprint?          @relation(fields: [sprintId], references: [id], onDelete: SetNull)
  boardColumn BoardColumn?     @relation(fields: [boardColumnId], references: [id], onDelete: SetNull)
  parent      Task?            @relation("TaskSubtasks", fields: [parentId], references: [id], onDelete: SetNull)
  subtasks    Task[]           @relation("TaskSubtasks")
  assignments TaskAssignment[]
  timeEntries TimeEntry[]
  comments    Comment[]
  labels      TaskLabel[]
  files       File[]

  @@index([projectId, status])
  @@index([sprintId])
  @@index([boardColumnId, position])
  @@index([parentId])
  @@map("tasks")
}

model TaskAssignment {
  id     String @id @default(uuid())
  taskId String
  userId String

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([taskId, userId])
  @@map("task_assignments")
}

model Label {
  id        String @id @default(uuid())
  projectId String
  name      String
  color     String

  project Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  tasks   TaskLabel[]

  @@unique([name, projectId])
  @@map("labels")
}

model TaskLabel {
  id      String @id @default(uuid())
  taskId  String
  labelId String

  task  Task  @relation(fields: [taskId], references: [id], onDelete: Cascade)
  label Label @relation(fields: [labelId], references: [id], onDelete: Cascade)

  @@unique([taskId, labelId])
  @@map("task_labels")
}

// ============================================
// TIME TRACKING
// ============================================

model TimeEntry {
  id          String   @id @default(uuid())
  taskId      String
  userId      String
  description String?
  startTime   DateTime
  endTime     DateTime?
  duration    Int?     // seconds
  billable    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([taskId])
  @@index([userId, startTime])
  @@map("time_entries")
}

// ============================================
// COMMUNICATION
// ============================================

model Channel {
  id        String   @id @default(uuid())
  projectId String
  name      String
  isDefault Boolean  @default(false)
  createdAt DateTime @default(now())

  project  Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  messages Message[]

  @@map("channels")
}

model Message {
  id        String   @id @default(uuid())
  channelId String
  userId    String
  content   String
  parentId  String?  // thread replies
  editedAt  DateTime?
  createdAt DateTime @default(now())

  channel Channel  @relation(fields: [channelId], references: [id], onDelete: Cascade)
  user    User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  parent  Message? @relation("MessageThread", fields: [parentId], references: [id])
  replies Message[] @relation("MessageThread")

  @@index([channelId, createdAt])
  @@map("messages")
}

model Comment {
  id        String   @id @default(uuid())
  taskId    String
  userId    String
  content   String
  editedAt  DateTime?
  createdAt DateTime @default(now())

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([taskId, createdAt])
  @@map("comments")
}

// ============================================
// NOTIFICATIONS
// ============================================

model Notification {
  id        String           @id @default(uuid())
  userId    String
  type      NotificationType
  title     String
  body      String?
  link      String?
  read      Boolean          @default(false)
  createdAt DateTime         @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, read, createdAt])
  @@map("notifications")
}

// ============================================
// FILES
// ============================================

model File {
  id        String       @id @default(uuid())
  projectId String?
  taskId    String?
  uploaderId String
  name      String
  key       String       @unique
  url       String
  mimeType  String
  size      Int
  category  FileCategory @default(ATTACHMENT)
  createdAt DateTime     @default(now())

  project Project? @relation(fields: [projectId], references: [id], onDelete: SetNull)
  task    Task?    @relation(fields: [taskId], references: [id], onDelete: SetNull)

  @@map("files")
}

// ============================================
// BILLING
// ============================================

model Invoice {
  id          String        @id @default(uuid())
  projectId   String
  number      String        @unique
  status      InvoiceStatus @default(DRAFT)
  periodStart DateTime
  periodEnd   DateTime
  subtotal    Decimal       @db.Decimal(10, 2)
  tax         Decimal       @default(0) @db.Decimal(10, 2)
  total       Decimal       @db.Decimal(10, 2)
  currency    String        @default("USD")
  notes       String?
  paidAt      DateTime?
  dueDate     DateTime?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  project Project       @relation(fields: [projectId], references: [id], onDelete: Cascade)
  items   InvoiceItem[]

  @@index([projectId, status])
  @@map("invoices")
}

model InvoiceItem {
  id          String  @id @default(uuid())
  invoiceId   String
  description String
  quantity    Decimal @db.Decimal(10, 2)
  unitPrice   Decimal @db.Decimal(10, 2)
  total       Decimal @db.Decimal(10, 2)

  invoice Invoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade)

  @@map("invoice_items")
}

// ============================================
// AUDIT LOG
// ============================================

model AuditLog {
  id         String   @id @default(uuid())
  userId     String?
  action     String
  entity     String
  entityId   String
  oldValues  Json?
  newValues  Json?
  ipAddress  String?
  userAgent  String?
  createdAt  DateTime @default(now())

  user User? @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([entity, entityId])
  @@index([userId, createdAt])
  @@map("audit_logs")
}
```

## 4.3 Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Tables | snake_case, plural | `task_assignments` |
| Columns | camelCase (Prisma) → snake_case (DB) | `createdAt` → `created_at` |
| Indexes | `idx_{table}_{columns}` | `idx_tasks_project_status` |
| Unique constraints | `uq_{table}_{columns}` | `uq_org_members_user_org` |
| Foreign keys | `fk_{table}_{ref_table}` | `fk_tasks_projects` |
| Enums | PascalCase | `TaskPriority` |

## 4.4 Soft Delete Strategy

Entities that support soft delete: `Organization`, `Project`, `Task`
- Column: `deletedAt DateTime?`
- All queries MUST filter `WHERE deletedAt IS NULL` by default
- Implement via Prisma middleware or `$extends` to auto-filter
- Hard delete after 30 days via background job

## 4.5 Database Seeding Plan

```
Seed Order:
1. Permissions (47 permissions: CRUD for each resource)
2. Default Roles (Admin, Project Manager, Developer, Designer, QA, Viewer, Client)
3. Admin User (admin@zentik.app / password hashed)
4. Demo Organization ("Zentik Demo Factory")
5. Demo Project with board, columns, labels
6. Sample Sprint with 15 tasks across all statuses
7. Sample Time Entries (last 30 days)
8. Sample Messages in #general channel
```

---

# 5. MODULE ARCHITECTURE

## 5.1 Core Modules (v1.0 — Must Have)

### Module 1: AuthModule

**Responsibility**: User authentication, session management, OAuth integration

**Controllers**:
```
POST   /api/v1/auth/register          — Register with email/password
POST   /api/v1/auth/login             — Login with credentials
POST   /api/v1/auth/logout            — Destroy session
POST   /api/v1/auth/forgot-password   — Send reset email
POST   /api/v1/auth/reset-password    — Reset password with token
POST   /api/v1/auth/verify-email      — Verify email token
GET    /api/v1/auth/me                — Get current user session
GET    /api/v1/auth/sessions          — List active sessions
DELETE /api/v1/auth/sessions/:id      — Revoke a session
GET    /api/v1/auth/oauth/google      — Initiate Google OAuth
GET    /api/v1/auth/oauth/github      — Initiate GitHub OAuth
GET    /api/v1/auth/oauth/callback    — OAuth callback handler
```

**Services**: `AuthService` (wraps Better Auth SDK)
**Events**: `UserRegistered`, `UserLoggedIn`, `PasswordReset`
**Dependencies**: `UserModule`, `NotificationModule` (for welcome email)

### Module 2: UserModule

**Responsibility**: User profile management, preferences, avatars

**Controllers**:
```
GET    /api/v1/users/me               — Get own profile
PATCH  /api/v1/users/me               — Update own profile
PATCH  /api/v1/users/me/avatar        — Upload avatar
GET    /api/v1/users/me/preferences   — Get preferences
PATCH  /api/v1/users/me/preferences   — Update preferences
GET    /api/v1/users/:id              — Get user public profile (within org)
```

**Services**: `UserService`, `UserPreferenceService`
**DTOs**: `UpdateProfileDto`, `UpdatePreferencesDto`
**Events**: `ProfileUpdated`
**Dependencies**: `FileModule` (avatar upload)

### Module 3: OrganizationModule

**Responsibility**: Organization CRUD, member management, invitations

**Controllers**:
```
POST   /api/v1/organizations                    — Create organization
GET    /api/v1/organizations                    — List user's organizations
GET    /api/v1/organizations/:orgId             — Get organization details
PATCH  /api/v1/organizations/:orgId             — Update organization
DELETE /api/v1/organizations/:orgId             — Delete organization (soft)
GET    /api/v1/organizations/:orgId/members     — List members
PATCH  /api/v1/organizations/:orgId/members/:id — Update member role
DELETE /api/v1/organizations/:orgId/members/:id — Remove member
POST   /api/v1/organizations/:orgId/invites     — Create invite link
GET    /api/v1/organizations/:orgId/invites     — List invite links
POST   /api/v1/organizations/join/:code         — Join via invite code
```

**Services**: `OrganizationService`, `InviteService`
**Events**: `OrgCreated`, `MemberJoined`, `MemberRemoved`
**Dependencies**: `RoleModule`, `NotificationModule`

### Module 4: RoleModule

**Responsibility**: RBAC, roles, permissions, role assignment

**Controllers**:
```
GET    /api/v1/organizations/:orgId/roles                — List roles
POST   /api/v1/organizations/:orgId/roles                — Create custom role
PATCH  /api/v1/organizations/:orgId/roles/:roleId        — Update role
DELETE /api/v1/organizations/:orgId/roles/:roleId        — Delete role
GET    /api/v1/organizations/:orgId/roles/:roleId/perms  — Get role permissions
PATCH  /api/v1/organizations/:orgId/roles/:roleId/perms  — Update role permissions
GET    /api/v1/permissions                               — List all available permissions
```

**Services**: `RoleService`, `PermissionService`
**Guards**: `RolesGuard`, `PermissionsGuard`
**Events**: `RoleCreated`, `PermissionsUpdated`
**Dependencies**: None (core dependency for other modules)

### Module 5: ProjectModule

**Responsibility**: Project lifecycle, settings, member management

**Controllers**:
```
POST   /api/v1/organizations/:orgId/projects              — Create project
GET    /api/v1/organizations/:orgId/projects              — List projects (paginated, filterable)
GET    /api/v1/projects/:projectId                        — Get project details
PATCH  /api/v1/projects/:projectId                        — Update project
DELETE /api/v1/projects/:projectId                        — Archive project (soft delete)
GET    /api/v1/projects/:projectId/members                — List project members
POST   /api/v1/projects/:projectId/members                — Add member to project
DELETE /api/v1/projects/:projectId/members/:memberId      — Remove member
GET    /api/v1/projects/:projectId/stats                  — Project statistics
```

**Services**: `ProjectService`, `ProjectStatsService`
**DTOs**: `CreateProjectDto`, `UpdateProjectDto`, `ProjectFilterDto`
**Events**: `ProjectCreated`, `ProjectStatusChanged`, `ProjectArchived`
**Dependencies**: `OrganizationModule`, `RoleModule`

### Module 6: BoardModule

**Responsibility**: Kanban boards, columns, card positioning

**Controllers**:
```
GET    /api/v1/projects/:projectId/boards                     — List boards
POST   /api/v1/projects/:projectId/boards                     — Create board
GET    /api/v1/projects/:projectId/boards/:boardId            — Get board with columns and tasks
PATCH  /api/v1/projects/:projectId/boards/:boardId            — Update board
DELETE /api/v1/projects/:projectId/boards/:boardId            — Delete board
POST   /api/v1/boards/:boardId/columns                        — Add column
PATCH  /api/v1/boards/:boardId/columns/:columnId              — Update column
DELETE /api/v1/boards/:boardId/columns/:columnId              — Delete column
PATCH  /api/v1/boards/:boardId/columns/reorder                — Reorder columns
PATCH  /api/v1/boards/:boardId/tasks/move                     — Move task between columns
```

**Services**: `BoardService`, `BoardColumnService`
**Events**: `TaskMoved`, `ColumnReordered`
**Dependencies**: `ProjectModule`, `TaskModule`

### Module 7: TaskModule

**Responsibility**: Tasks, subtasks, assignments, filtering, bulk operations

**Controllers**:
```
POST   /api/v1/projects/:projectId/tasks          — Create task
GET    /api/v1/projects/:projectId/tasks          — List tasks (paginated, filterable, sortable)
GET    /api/v1/tasks/:taskId                      — Get task detail
PATCH  /api/v1/tasks/:taskId                      — Update task
DELETE /api/v1/tasks/:taskId                      — Delete task (soft)
POST   /api/v1/tasks/:taskId/subtasks             — Create subtask
GET    /api/v1/tasks/:taskId/subtasks             — List subtasks
POST   /api/v1/tasks/:taskId/assign               — Assign user(s) to task
DELETE /api/v1/tasks/:taskId/assign/:userId        — Unassign user
POST   /api/v1/tasks/:taskId/labels               — Add label
DELETE /api/v1/tasks/:taskId/labels/:labelId       — Remove label
PATCH  /api/v1/projects/:projectId/tasks/bulk      — Bulk update tasks
GET    /api/v1/users/me/tasks                     — My tasks across all projects
```

**Services**: `TaskService`, `TaskAssignmentService`, `TaskFilterService`
**DTOs**: `CreateTaskDto`, `UpdateTaskDto`, `TaskFilterDto`, `BulkUpdateTaskDto`
**Events**: `TaskCreated`, `TaskUpdated`, `TaskAssigned`, `TaskCompleted`
**Dependencies**: `ProjectModule`, `NotificationModule`, `AuditModule`

### Module 8: SprintModule

**Responsibility**: Sprint planning, backlog management, velocity tracking

**Controllers**:
```
POST   /api/v1/projects/:projectId/sprints              — Create sprint
GET    /api/v1/projects/:projectId/sprints              — List sprints
GET    /api/v1/projects/:projectId/sprints/active        — Get active sprint
GET    /api/v1/sprints/:sprintId                        — Get sprint detail
PATCH  /api/v1/sprints/:sprintId                        — Update sprint
POST   /api/v1/sprints/:sprintId/start                  — Start sprint
POST   /api/v1/sprints/:sprintId/complete               — Complete sprint
POST   /api/v1/sprints/:sprintId/tasks                  — Add tasks to sprint
DELETE /api/v1/sprints/:sprintId/tasks/:taskId           — Remove task from sprint
GET    /api/v1/sprints/:sprintId/burndown               — Get burndown chart data
GET    /api/v1/projects/:projectId/backlog              — Get backlog (unsprinted tasks)
```

**Services**: `SprintService`, `BacklogService`, `BurndownService`
**Events**: `SprintStarted`, `SprintCompleted`
**Dependencies**: `TaskModule`, `NotificationModule`

### Module 9: TimeTrackingModule

**Responsibility**: Time entries, timers, time reports

**Controllers**:
```
POST   /api/v1/time-entries                    — Create manual time entry
GET    /api/v1/time-entries                    — List own time entries (filterable by date, project)
PATCH  /api/v1/time-entries/:id                — Update time entry
DELETE /api/v1/time-entries/:id                — Delete time entry
POST   /api/v1/time-entries/start              — Start timer on task
POST   /api/v1/time-entries/stop               — Stop active timer
GET    /api/v1/time-entries/active             — Get active timer
GET    /api/v1/projects/:projectId/time-report — Time report for project
GET    /api/v1/users/me/time-report            — My time report
```

**Services**: `TimeEntryService`, `TimerService` (Redis-based), `TimeReportService`
**Events**: `TimerStarted`, `TimerStopped`, `TimeEntryCreated`
**Dependencies**: `TaskModule`, `ProjectModule`

### Module 10: ChatModule

**Responsibility**: Real-time messaging, channels, threads

**Controllers**:
```
GET    /api/v1/projects/:projectId/channels              — List channels
POST   /api/v1/projects/:projectId/channels              — Create channel
GET    /api/v1/channels/:channelId/messages              — List messages (cursor paginated)
POST   /api/v1/channels/:channelId/messages              — Send message
PATCH  /api/v1/messages/:messageId                       — Edit message
DELETE /api/v1/messages/:messageId                       — Delete message
GET    /api/v1/messages/:messageId/thread                — Get thread replies
```

**Gateway**: `ChatGateway` (WebSocket)
```
ws: "message:send"     — Send message (real-time)
ws: "message:typing"   — Typing indicator
ws: "channel:join"     — Join channel room
ws: "channel:leave"    — Leave channel room
```

**Services**: `ChannelService`, `MessageService`
**Events**: `MessageSent`, `UserMentioned`
**Dependencies**: `ProjectModule`, `NotificationModule`

### Module 11: NotificationModule

**Responsibility**: In-app notifications, email dispatch, push notifications (future)

**Controllers**:
```
GET    /api/v1/notifications              — List notifications (paginated)
GET    /api/v1/notifications/unread-count — Get unread count
PATCH  /api/v1/notifications/:id/read    — Mark as read
PATCH  /api/v1/notifications/read-all    — Mark all as read
DELETE /api/v1/notifications/:id          — Delete notification
```

**Services**: `NotificationService`, `EmailService` (SendGrid), `NotificationDispatcher`
**Events consumed**: All `*Created`, `*Assigned`, `*Mentioned` events from other modules
**Dependencies**: None (consumed by other modules)

### Module 12: FileModule

**Responsibility**: File upload, storage, preview generation

**Controllers**:
```
POST   /api/v1/files/upload                    — Upload file
GET    /api/v1/files/:id                       — Get file metadata
GET    /api/v1/files/:id/download              — Download file (signed URL)
DELETE /api/v1/files/:id                       — Delete file
GET    /api/v1/projects/:projectId/files       — List project files
GET    /api/v1/tasks/:taskId/files             — List task attachments
```

**Services**: `FileService`, `StorageService` (S3-compatible / Railway volume)
**Events**: `FileUploaded`, `FileDeleted`
**Dependencies**: `ProjectModule`

### Module 13: BillingModule

**Responsibility**: Invoice generation, billing reports, cost tracking

**Controllers**:
```
POST   /api/v1/projects/:projectId/invoices          — Generate invoice
GET    /api/v1/projects/:projectId/invoices          — List invoices
GET    /api/v1/invoices/:id                          — Get invoice detail
PATCH  /api/v1/invoices/:id                          — Update invoice
POST   /api/v1/invoices/:id/send                     — Send invoice to client
PATCH  /api/v1/invoices/:id/mark-paid                — Mark as paid
GET    /api/v1/invoices/:id/pdf                      — Generate PDF
GET    /api/v1/organizations/:orgId/billing/summary  — Billing summary
```

**Services**: `InvoiceService`, `InvoiceGeneratorService`, `PdfService`
**Events**: `InvoiceGenerated`, `InvoiceSent`, `InvoicePaid`
**Dependencies**: `TimeTrackingModule`, `ProjectModule`

### Module 14: ReportModule

**Responsibility**: Analytics dashboards, productivity metrics, financial reports

**Controllers**:
```
GET /api/v1/organizations/:orgId/reports/overview          — Executive dashboard
GET /api/v1/organizations/:orgId/reports/productivity      — Team productivity
GET /api/v1/organizations/:orgId/reports/profitability     — Project profitability
GET /api/v1/projects/:projectId/reports/burndown           — Sprint burndown
GET /api/v1/projects/:projectId/reports/velocity           — Velocity chart
GET /api/v1/projects/:projectId/reports/time-distribution  — Time by member/task
GET /api/v1/users/me/reports/summary                       — Personal productivity
```

**Services**: `ReportService`, `MetricsAggregator`
**Dependencies**: `ProjectModule`, `TaskModule`, `TimeTrackingModule`, `BillingModule`

### Module 15: CalendarModule

**Responsibility**: Calendar view, Google Calendar sync

**Controllers**:
```
GET    /api/v1/calendar/events                     — Get events (tasks with dates, sprints)
POST   /api/v1/calendar/google/connect             — Connect Google Calendar
DELETE /api/v1/calendar/google/disconnect           — Disconnect
POST   /api/v1/calendar/google/sync                — Force sync
GET    /api/v1/calendar/google/status               — Sync status
```

**Services**: `CalendarService`, `GoogleCalendarService`
**Dependencies**: `TaskModule`, `SprintModule`

### Module 16: AuditModule

**Responsibility**: Action logging, activity feed, compliance trail

**Controllers**:
```
GET /api/v1/organizations/:orgId/audit-log         — Org activity (admins)
GET /api/v1/projects/:projectId/activity           — Project activity feed
GET /api/v1/tasks/:taskId/activity                 — Task activity feed
```

**Services**: `AuditService`
**Events consumed**: All domain events → logs to `audit_logs` table
**Dependencies**: None

### Module 17: HealthModule

**Responsibility**: Health checks, readiness probes

**Controllers**:
```
GET /api/v1/health            — Liveness check
GET /api/v1/health/ready      — Readiness (DB + Redis connected)
```

**Dependencies**: `PrismaModule`, `RedisModule`

### Module 18: SubscriptionModule

**Responsibility**: Plan management, feature gates, usage tracking, upgrade/downgrade

**Controllers**:
```
GET    /api/v1/organizations/:orgId/subscription         — Get current subscription
POST   /api/v1/organizations/:orgId/subscription/upgrade  — Upgrade plan
POST   /api/v1/organizations/:orgId/subscription/downgrade — Downgrade plan
GET    /api/v1/organizations/:orgId/subscription/usage    — Get usage vs limits
POST   /api/v1/organizations/:orgId/subscription/cancel   — Cancel subscription
POST   /api/v1/organizations/:orgId/subscription/resume   — Resume cancelled subscription
GET    /api/v1/plans                                      — List available plans
```

**Services**: `SubscriptionService`, `PlanService`, `UsageTrackingService`, `FeatureGateService`

**Guards**: `PlanGuard` — Inyectado en cualquier endpoint que requiera validacion de plan
```typescript
// Uso: @RequiresPlan('sprints') en controller
// PlanGuard verifica que la org tiene feature 'sprints' en su plan
// Si no: lanza FeatureNotAvailableException con suggestedPlan
```

**Events**: `PlanUpgraded`, `PlanDowngraded`, `SubscriptionExpired`, `TrialExpiring`
**Dependencies**: `OrganizationModule`, `NotificationModule`

**Usage Tracking**:
```typescript
// Antes de crear un proyecto, verificar limite
async createProject(orgId: string, dto: CreateProjectDto): Promise<Project> {
  const usage = await this.usageService.getProjectCount(orgId);
  const limit = await this.subscriptionService.getLimit(orgId, 'maxProjects');

  if (usage >= limit) {
    throw new PlanLimitExceededException('proyectos', usage, limit, 'free');
  }

  return this.projectRepo.create(orgId, dto);
}
```

### Module 19: ConfigModule (NestJS built-in extended)

**Responsibility**: Environment configuration, feature flags, validation

**Services**: `AppConfigService` (typed access to env vars)
**Validation**: Zod schema validates all env vars on startup — app crashes fast if misconfigured

---

## 5.2 Future Modules (v2.0+)

| # | Module | Description | Deferred Because | v1.0 Dependencies | Complexity |
|---|--------|-------------|-------------------|-------------------|------------|
| 1 | **AutomationModule** | Workflow automation engine. "When task status changes to Done, notify PM and update sprint" | Requires stable event system and UI builder | TaskModule, NotificationModule, SprintModule | High |
| 2 | **IntegrationModule** | Connectors for Slack, Jira, Figma, GitLab | Each integration is a mini-project. MVP doesn't need it | ProjectModule, TaskModule | High |
| 3 | **WikiModule** | Knowledge base per project. Markdown editor, version history | Not critical for MVP. Can use external docs initially | ProjectModule | Medium |
| 4 | **TemplateModule** | Project and task templates. "Clone this project setup for new clients" | Needs mature project structure to template from | ProjectModule, TaskModule, BoardModule | Medium |
| 5 | **AIModule** | AI task estimation, smart assignment, sprint planning suggestions, natural language search | Requires data history for ML. LLM integration for NL search | TaskModule, SprintModule, TimeTrackingModule | High |
| 6 | **ResourceModule** | Gantt charts, resource allocation heatmap, capacity planning | Complex UI. MVP uses simpler team overview | ProjectModule, TeamModule, TimeTrackingModule | High |
| 7 | **ClientPortalModule** | White-labeled portal for external clients with approval workflows | Needs multi-tenant isolation. MVP uses basic client viewer | ProjectModule, BillingModule | Medium |

---

# 6. API DESIGN

## 6.1 API Versioning

- Base URL: `https://api.zentik.app/api/v1/`
- Versioning via URL path (not headers)
- Breaking changes → new version (`/api/v2/`)
- Non-breaking additions (new fields, new endpoints) go into current version

## 6.2 Standard Response Format

### Success Response — Single Resource
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Sprint 4",
    "status": "ACTIVE",
    "startDate": "2026-03-14T00:00:00.000Z"
  },
  "timestamp": "2026-03-14T10:30:00.000Z"
}
```

Headers en respuestas `201 Created`:
```
HTTP/1.1 201 Created
Location: /api/v1/projects/proj-123/sprints/550e8400
X-Correlation-ID: req-7f3a-4b2c-9d1e
```

### Success Response — Collection (Paginated with HATEOAS)
```json
{
  "success": true,
  "data": [
    { "id": "task-1", "title": "Implementar login" },
    { "id": "task-2", "title": "Diseno del dashboard" }
  ],
  "meta": {
    "page": 2,
    "limit": 20,
    "total": 87,
    "totalPages": 5,
    "hasNext": true,
    "hasPrev": true
  },
  "links": {
    "self": "/api/v1/projects/proj-123/tasks?page=2&limit=20",
    "first": "/api/v1/projects/proj-123/tasks?page=1&limit=20",
    "prev": "/api/v1/projects/proj-123/tasks?page=1&limit=20",
    "next": "/api/v1/projects/proj-123/tasks?page=3&limit=20",
    "last": "/api/v1/projects/proj-123/tasks?page=5&limit=20"
  },
  "timestamp": "2026-03-14T10:30:00.000Z"
}
```

### Error Response
```json
{
  "success": false,
  "error": {
    "code": "PLAN_LIMIT_EXCEEDED",
    "message": "Tu plan Free permite maximo 3 proyectos. Actualiza a Pro para expandir tus limites.",
    "details": {
      "currentUsage": 3,
      "planLimit": 3,
      "currentPlan": "free",
      "suggestedPlan": "pro"
    },
    "correlationId": "req-7f3a-4b2c-9d1e",
    "timestamp": "2026-03-14T10:30:00.000Z",
    "path": "/api/v1/organizations/org-123/projects"
  }
}
```

Error codes completos: ver [Section 10.7 — Error Codes Catalog](#107-error-response-format)

## 6.3 Pagination

**Strategy**: Cursor-based pagination for lists, offset-based for simple views.

```
# Cursor-based (recommended for feeds, messages, activity)
GET /api/v1/channels/:id/messages?cursor=abc123&limit=50

# Offset-based (for tables with page navigation)
GET /api/v1/projects/:id/tasks?page=2&limit=20
```

## 6.4 Filtering, Sorting, Search, and Field Selection

```
# Filtering
GET /api/v1/projects/:id/tasks?status=IN_PROGRESS&priority=HIGH&assigneeId=uuid

# Sorting (prefijo "-" para descendente)
GET /api/v1/projects/:id/tasks?sort=-dueDate,priority

# Search (full-text via pg_trgm)
GET /api/v1/projects/:id/tasks?search=authentication%20bug

# Field Selection — solo trae los campos que necesitas
GET /api/v1/projects/:id/tasks?fields=id,title,status,assignees.name

# Combined
GET /api/v1/projects/:id/tasks?status=TODO,IN_PROGRESS&priority=HIGH&sort=-priority,dueDate&search=login&fields=id,title,status&page=1&limit=20
```

## 6.5 Batch Operations

Para operaciones masivas, un endpoint dedicado evita N requests:

```
POST /api/v1/projects/:id/tasks/batch
Content-Type: application/json

{
  "operations": [
    { "action": "update", "id": "task-1", "data": { "status": "DONE" } },
    { "action": "update", "id": "task-2", "data": { "status": "DONE" } },
    { "action": "delete", "id": "task-3" },
    { "action": "update", "id": "task-4", "data": { "priority": "HIGH", "assigneeId": "user-5" } }
  ]
}

Response:
{
  "success": true,
  "data": {
    "processed": 4,
    "succeeded": 3,
    "failed": 1,
    "results": [
      { "id": "task-1", "action": "update", "success": true },
      { "id": "task-2", "action": "update", "success": true },
      { "id": "task-3", "action": "delete", "success": false, "error": "FORBIDDEN" },
      { "id": "task-4", "action": "update", "success": true }
    ]
  }
}
```

Todas las operaciones batch se ejecutan dentro de una transaccion Prisma. Si una falla, se reporta pero no bloquea las demas (partial success).

## 6.6 Rate Limiting Tiers (por plan SaaS)

| Plan / Role | Requests/min | Burst | WebSocket connections |
|-------------|:------------:|:-----:|:---------------------:|
| Unauthenticated | 20 | 30 | 0 |
| Free plan | 60 | 100 | 2 |
| Pro plan | 300 | 500 | 10 |
| Enterprise plan | 1000 | 1500 | 50 |
| API Key (Pro+) | 500 | 800 | N/A |
| API Key (Enterprise) | 2000 | 3000 | N/A |

Implementado via Redis sliding window counter. Key: `zentik:ratelimit:{orgId}:{plan}:{endpoint}`

Endpoints sensibles tienen limites adicionales:
- `/auth/login`: 5 intentos/minuto por IP (brute force protection)
- `/auth/register`: 3/minuto por IP
- `/files/upload`: 10/minuto por usuario (Pro), 50/minuto (Enterprise)

## 6.7 ETags y Caching Headers

```
# Response con ETag para cache condicional
HTTP/1.1 200 OK
ETag: "v1-project-123-1710412800"
Cache-Control: private, max-age=0, must-revalidate

# Client envia If-None-Match en request siguiente
GET /api/v1/projects/123
If-None-Match: "v1-project-123-1710412800"

# Si no cambio → 304 Not Modified (sin body, ahorra bandwidth)
HTTP/1.1 304 Not Modified
```

Implementado via `CacheInterceptor` de NestJS con ETag generado desde `updatedAt` de la entidad.

## 6.8 API Documentation

- Auto-generated Swagger/OpenAPI via `@nestjs/swagger`
- Available at `/api/docs` in development
- DTOs decorated with `@ApiProperty()` for auto-documentation
- Response types documented with `@ApiResponse()`
- Authentication documented with `@ApiBearerAuth()`

---

# 7. AUTHENTICATION & AUTHORIZATION

## 7.1 Better Auth Configuration

```typescript
// apps/api/src/config/auth.config.ts
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh after 1 day
  },
  advanced: {
    generateId: () => crypto.randomUUID(),
  },
});
```

## 7.2 Authentication Flows

### Email + Password Registration

```mermaid
sequenceDiagram
    actor User
    participant Web as Next.js
    participant API as NestJS
    participant Auth as Better Auth
    participant DB as PostgreSQL
    participant Email as SendGrid

    User->>Web: Fill register form
    Web->>API: POST /auth/register {email, password, name}
    API->>API: Validate DTO
    API->>Auth: auth.api.signUpEmail()
    Auth->>DB: Check email uniqueness
    Auth->>DB: INSERT user + account (hashed password)
    Auth->>Email: Send verification email
    Auth-->>API: {user, session}
    API-->>Web: 201 Created + Set-Cookie
    Web-->>User: Redirect to onboarding

    User->>Email: Click verification link
    Email->>Web: /verify-email?token=xxx
    Web->>API: POST /auth/verify-email {token}
    API->>Auth: auth.api.verifyEmail()
    Auth->>DB: UPDATE user.emailVerified = true
    API-->>Web: 200 OK
```

### OAuth (Google) Flow

```mermaid
sequenceDiagram
    actor User
    participant Web as Next.js
    participant API as NestJS
    participant Auth as Better Auth
    participant Google as Google OAuth2
    participant DB as PostgreSQL

    User->>Web: Click "Continue with Google"
    Web->>Auth: Redirect to /auth/oauth/google
    Auth->>Google: Authorization request
    Google-->>User: Consent screen
    User->>Google: Grant access
    Google-->>Auth: Authorization code
    Auth->>Google: Exchange for tokens
    Google-->>Auth: Access token + ID token + profile
    Auth->>DB: Find user by email
    alt User exists
        Auth->>DB: Link Google account
    else New user
        Auth->>DB: CREATE user + account
    end
    Auth->>DB: CREATE session
    Auth-->>Web: Set-Cookie + redirect to /dashboard
```

## 7.3 RBAC Permission Matrix

| Permission | SuperAdmin | Admin | PM | Developer | Designer | QA | Viewer | Client |
|-----------|:---------:|:-----:|:--:|:---------:|:--------:|:--:|:------:|:------:|
| org:manage | x | x | | | | | | |
| org:members:manage | x | x | | | | | | |
| roles:manage | x | x | | | | | | |
| project:create | x | x | x | | | | | |
| project:update | x | x | x | | | | | |
| project:delete | x | x | | | | | | |
| project:view | x | x | x | x | x | x | x | x |
| board:manage | x | x | x | | | | | |
| task:create | x | x | x | x | x | x | | |
| task:update | x | x | x | x | x | x | | |
| task:delete | x | x | x | | | | | |
| task:assign | x | x | x | | | | | |
| sprint:manage | x | x | x | | | | | |
| time:own:manage | x | x | x | x | x | x | | |
| time:all:view | x | x | x | | | | | |
| chat:send | x | x | x | x | x | x | | |
| file:upload | x | x | x | x | x | x | | |
| file:delete | x | x | x | | | | | |
| invoice:manage | x | x | x | | | | | |
| invoice:view | x | x | x | | | | | x |
| report:view | x | x | x | | | | x | |
| audit:view | x | x | | | | | | |

## 7.4 Security Measures

- **Brute Force Protection**: 5 failed login attempts → 15 minute lockout (tracked in Redis)
- **Account Lockout**: 10 failed attempts in 1 hour → account locked, email sent to user
- **CSRF**: SameSite=Lax cookies + CSRF token for state-changing operations
- **XSS Prevention**: Content-Security-Policy header, input sanitization with DOMPurify
- **Session Fixation**: New session ID generated on login
- **Concurrent Sessions**: Maximum 5 active sessions per user, oldest revoked on new login

---

# 8. FOLDER STRUCTURE

## 8.1 Monorepo Structure (Turborepo)

```
zentik/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                          # Lint + Test + Build
│   │   ├── deploy-api.yml                  # Deploy backend to Railway
│   │   └── deploy-web.yml                  # Deploy frontend to Vercel
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md
│       └── feature_request.md
│
├── apps/
│   ├── api/                                 # NestJS Backend Application
│   │   ├── src/
│   │   │   ├── main.ts                     # Bootstrap, global pipes/filters
│   │   │   ├── app.module.ts               # Root module
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   │   ├── auth.module.ts
│   │   │   │   │   ├── auth.controller.ts
│   │   │   │   │   ├── auth.service.ts
│   │   │   │   │   ├── auth.config.ts      # Better Auth config
│   │   │   │   │   ├── guards/
│   │   │   │   │   │   ├── auth.guard.ts
│   │   │   │   │   │   └── roles.guard.ts
│   │   │   │   │   ├── decorators/
│   │   │   │   │   │   ├── current-user.decorator.ts
│   │   │   │   │   │   ├── roles.decorator.ts
│   │   │   │   │   │   └── permissions.decorator.ts
│   │   │   │   │   └── dto/
│   │   │   │   │       ├── register.dto.ts
│   │   │   │   │       └── login.dto.ts
│   │   │   │   ├── user/
│   │   │   │   │   ├── user.module.ts
│   │   │   │   │   ├── user.controller.ts
│   │   │   │   │   ├── user.service.ts
│   │   │   │   │   └── dto/
│   │   │   │   ├── organization/
│   │   │   │   │   ├── organization.module.ts
│   │   │   │   │   ├── organization.controller.ts
│   │   │   │   │   ├── organization.service.ts
│   │   │   │   │   ├── invite.service.ts
│   │   │   │   │   └── dto/
│   │   │   │   ├── role/
│   │   │   │   ├── project/
│   │   │   │   ├── board/
│   │   │   │   ├── task/
│   │   │   │   ├── sprint/
│   │   │   │   ├── time-tracking/
│   │   │   │   ├── chat/
│   │   │   │   │   ├── chat.module.ts
│   │   │   │   │   ├── chat.gateway.ts     # WebSocket gateway
│   │   │   │   │   ├── channel.controller.ts
│   │   │   │   │   ├── message.service.ts
│   │   │   │   │   └── dto/
│   │   │   │   ├── notification/
│   │   │   │   ├── file/
│   │   │   │   ├── billing/
│   │   │   │   ├── report/
│   │   │   │   ├── calendar/
│   │   │   │   ├── audit/
│   │   │   │   └── health/
│   │   │   ├── common/
│   │   │   │   ├── decorators/             # Shared decorators
│   │   │   │   ├── filters/               # Exception filters
│   │   │   │   │   └── global-exception.filter.ts
│   │   │   │   ├── interceptors/          # Response transform, logging, timeout
│   │   │   │   │   ├── transform.interceptor.ts
│   │   │   │   │   ├── logging.interceptor.ts
│   │   │   │   │   └── timeout.interceptor.ts
│   │   │   │   ├── pipes/                 # Custom validation pipes
│   │   │   │   ├── middleware/            # Request ID, CORS
│   │   │   │   ├── interfaces/            # Shared interfaces
│   │   │   │   ├── constants/             # App constants, error codes
│   │   │   │   └── utils/                 # Helper functions
│   │   │   ├── config/
│   │   │   │   ├── app.config.ts          # Typed env config
│   │   │   │   ├── database.config.ts
│   │   │   │   ├── redis.config.ts
│   │   │   │   └── env.validation.ts      # Zod schema
│   │   │   ├── database/
│   │   │   │   ├── prisma.module.ts
│   │   │   │   ├── prisma.service.ts
│   │   │   │   └── prisma.extension.ts    # Soft delete, audit middleware
│   │   │   └── infrastructure/
│   │   │       ├── redis/
│   │   │       │   ├── redis.module.ts
│   │   │       │   └── redis.service.ts
│   │   │       ├── email/
│   │   │       │   ├── email.module.ts
│   │   │       │   └── email.service.ts   # SendGrid integration
│   │   │       ├── storage/
│   │   │       │   ├── storage.module.ts
│   │   │       │   └── storage.service.ts # S3-compatible storage
│   │   │       └── queue/
│   │   │           ├── queue.module.ts
│   │   │           └── processors/        # BullMQ job processors
│   │   ├── test/
│   │   │   ├── jest.config.ts
│   │   │   ├── setup.ts
│   │   │   └── helpers/
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   └── seed.ts
│   │   ├── nest-cli.json
│   │   ├── tsconfig.json
│   │   ├── tsconfig.build.json
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── web/                                 # Next.js Frontend Application
│       ├── src/
│       │   ├── app/
│       │   │   ├── layout.tsx              # Root layout
│       │   │   ├── (marketing)/            # Public pages
│       │   │   ├── (auth)/                 # Login, register
│       │   │   └── (dashboard)/            # Protected app
│       │   │       ├── layout.tsx          # Sidebar + topbar
│       │   │       ├── page.tsx            # Dashboard home
│       │   │       ├── projects/
│       │   │       ├── calendar/
│       │   │       ├── reports/
│       │   │       ├── team/
│       │   │       ├── settings/
│       │   │       └── profile/
│       │   ├── components/
│       │   │   ├── ui/                     # Shadcn/ui base components
│       │   │   ├── layout/                 # Sidebar, Topbar, Breadcrumbs
│       │   │   ├── forms/                  # Form components
│       │   │   ├── kanban/                 # Board, Column, Card
│       │   │   ├── chat/                   # ChatWindow, MessageBubble
│       │   │   ├── timer/                  # TimerWidget
│       │   │   └── charts/                 # Report charts
│       │   ├── hooks/
│       │   │   ├── use-auth.ts
│       │   │   ├── use-socket.ts
│       │   │   ├── use-timer.ts
│       │   │   └── use-debounce.ts
│       │   ├── lib/
│       │   │   ├── api-client.ts           # Fetch wrapper with auth
│       │   │   ├── auth-client.ts          # Better Auth client
│       │   │   ├── socket.ts              # Socket.IO client
│       │   │   ├── utils.ts               # cn(), formatDate, etc.
│       │   │   └── validations.ts         # Zod schemas for forms
│       │   ├── services/
│       │   │   ├── project.service.ts     # API calls for projects
│       │   │   ├── task.service.ts
│       │   │   ├── sprint.service.ts
│       │   │   └── ...
│       │   ├── stores/
│       │   │   ├── use-project-store.ts   # Zustand stores
│       │   │   ├── use-board-store.ts
│       │   │   └── use-notification-store.ts
│       │   └── types/
│       │       └── index.ts               # Re-exports from shared-types
│       ├── public/
│       │   ├── favicon.ico
│       │   └── images/
│       ├── next.config.ts
│       ├── tailwind.config.ts
│       ├── tsconfig.json
│       ├── Dockerfile
│       └── package.json
│
├── packages/
│   ├── shared-types/                       # Shared TypeScript types
│   │   ├── src/
│   │   │   ├── api.ts                     # API response types
│   │   │   ├── entities.ts                # Entity interfaces
│   │   │   ├── enums.ts                   # Shared enums
│   │   │   └── index.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── eslint-config/                      # Shared ESLint config
│   │   └── index.js
│   ├── tsconfig/                           # Shared TSConfig
│   │   ├── base.json
│   │   ├── nestjs.json
│   │   └── nextjs.json
│   └── prettier-config/                    # Shared Prettier config
│       └── index.js
│
├── docker/
│   ├── docker-compose.yml                  # Local dev (Postgres, Redis, MinIO)
│   ├── docker-compose.test.yml             # Test environment
│   └── nginx/                              # Reverse proxy (if needed)
│
├── docs/
│   ├── PROJECT_BLUEPRINT.md                # This document
│   ├── ADR/                                # Architecture Decision Records
│   │   └── 001-modular-monolith.md
│   └── api/                                # Generated API docs
│
├── turbo.json                               # Turborepo config
├── package.json                             # Root workspace
├── pnpm-workspace.yaml                      # pnpm workspaces
├── .gitignore
├── .prettierrc
├── .eslintrc.js
├── .env.example
└── README.md
```

## 8.2 Monorepo Tool: Turborepo + pnpm

- **Turborepo** for task orchestration (build, test, lint in parallel with caching)
- **pnpm** for package management (faster, strict, disk-efficient)
- Shared packages linked via workspace protocol

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "test": { "dependsOn": ["build"] },
    "test:e2e": { "dependsOn": ["build"] }
  }
}
```

---

# 9. ENVIRONMENT & CONFIGURATION

## 9.1 Complete .env.example

```bash
# ============================================
# APP
# ============================================
NODE_ENV=development
PORT=3001
API_URL=http://localhost:3001
WEB_URL=http://localhost:3000
API_PREFIX=/api/v1

# ============================================
# DATABASE — PostgreSQL
# ============================================
DATABASE_URL=postgresql://zentik:zentik_dev@localhost:5432/zentik_dev?schema=public

# ============================================
# CACHE — Redis
# ============================================
REDIS_URL=redis://localhost:6379

# ============================================
# AUTH — Better Auth
# ============================================
BETTER_AUTH_SECRET=your-32-char-secret-key-here-min
BETTER_AUTH_URL=http://localhost:3001

# ============================================
# OAUTH — Google
# ============================================
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# ============================================
# OAUTH — GitHub
# ============================================
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret

# ============================================
# EMAIL — SendGrid
# ============================================
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxx
SENDGRID_FROM_EMAIL=noreply@zentik.app
SENDGRID_FROM_NAME=Zentik

# ============================================
# FILE STORAGE — S3 Compatible (MinIO local, S3 prod)
# ============================================
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_ACCESS_KEY=minioadmin
STORAGE_SECRET_KEY=minioadmin
STORAGE_BUCKET=zentik-files
STORAGE_REGION=us-east-1

# ============================================
# GOOGLE CALENDAR
# ============================================
GOOGLE_CALENDAR_CLIENT_ID=your-calendar-client-id
GOOGLE_CALENDAR_CLIENT_SECRET=your-calendar-client-secret

# ============================================
# MONITORING (optional)
# ============================================
SENTRY_DSN=
LOG_LEVEL=debug
```

## 9.2 Environment Hierarchy

| Variable | Development | Staging | Production |
|----------|-------------|---------|------------|
| NODE_ENV | development | staging | production |
| LOG_LEVEL | debug | info | warn |
| Database | Local Docker | Railway staging | Railway production |
| Redis | Local Docker | Railway staging | Railway production |
| Email | SendGrid sandbox | SendGrid | SendGrid |
| Storage | MinIO (local) | S3 | S3 |

## 9.3 Configuration Validation

```typescript
// apps/api/src/config/env.validation.ts
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  SENDGRID_API_KEY: z.string().startsWith("SG."),
  // ... all variables validated
});

// Called in main.ts — app crashes immediately if env is invalid
export function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:", result.error.flatten());
    process.exit(1);
  }
  return result.data;
}
```

---

# 10. ERROR HANDLING & LOGGING

Error handling en Zentik no es un "nice to have" — es infraestructura critica. Un error mal manejado puede exponer datos de otra organizacion, corromper una factura, o dejar un timer corriendo infinitamente. Cada error debe ser capturado, categorizado, logueado y comunicado de forma consistente.

## 10.1 Exception Hierarchy — Domain-Specific

```typescript
// ============================================
// BASE EXCEPTION
// ============================================
export class AppException extends Error {
  public readonly timestamp: string;

  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, any>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================
// HTTP EXCEPTIONS
// ============================================
export class ValidationException extends AppException {
  constructor(details: Record<string, any>) {
    super('Los datos enviados no son validos', 'VALIDATION_ERROR', 422, details);
  }
}

export class UnauthorizedException extends AppException {
  constructor(message = 'Sesion expirada o no autenticado') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenException extends AppException {
  constructor(resource: string, action: string) {
    super(
      `No tienes permiso para ${action} en ${resource}`,
      'FORBIDDEN', 403,
      { resource, action },
    );
  }
}

// ============================================
// DOMAIN EXCEPTIONS — ZENTIK SPECIFIC
// ============================================
export class ProjectNotFoundException extends AppException {
  constructor(projectId: string) {
    super(
      `El proyecto no existe o fue eliminado`,
      'PROJECT_NOT_FOUND', 404,
      { projectId },
    );
  }
}

export class TaskNotFoundException extends AppException {
  constructor(taskId: string) {
    super('La tarea no existe o fue eliminada', 'TASK_NOT_FOUND', 404, { taskId });
  }
}

export class OrganizationNotFoundException extends AppException {
  constructor(orgId: string) {
    super('La organizacion no existe', 'ORGANIZATION_NOT_FOUND', 404, { orgId });
  }
}

export class InsufficientPermissionsException extends AppException {
  constructor(userId: string, permission: string) {
    super(
      `Tu rol no incluye el permiso "${permission}". Contacta al administrador de tu organizacion.`,
      'INSUFFICIENT_PERMISSIONS', 403,
      { userId, requiredPermission: permission },
    );
  }
}

// ============================================
// SaaS-SPECIFIC EXCEPTIONS
// ============================================
export class PlanLimitExceededException extends AppException {
  constructor(resource: string, currentUsage: number, limit: number, plan: string) {
    super(
      `Tu plan ${plan} permite maximo ${limit} ${resource}. Actualiza a Pro para expandir tus limites.`,
      'PLAN_LIMIT_EXCEEDED', 403,
      { resource, currentUsage, planLimit: limit, currentPlan: plan, suggestedPlan: 'pro' },
    );
  }
}

export class SubscriptionExpiredException extends AppException {
  constructor(orgId: string) {
    super(
      'Tu suscripcion ha expirado. Renueva para continuar usando las funciones Pro.',
      'SUBSCRIPTION_EXPIRED', 402,
      { orgId },
    );
  }
}

export class FeatureNotAvailableException extends AppException {
  constructor(feature: string, currentPlan: string) {
    super(
      `La funcion "${feature}" no esta disponible en tu plan ${currentPlan}.`,
      'FEATURE_NOT_AVAILABLE', 403,
      { feature, currentPlan, upgradePath: '/settings/billing' },
    );
  }
}

// ============================================
// CONFLICT EXCEPTIONS
// ============================================
export class DuplicateResourceException extends AppException {
  constructor(resource: string, field: string, value: string) {
    super(
      `Ya existe un ${resource} con ese ${field}`,
      'DUPLICATE_RESOURCE', 409,
      { resource, field, value },
    );
  }
}

// ============================================
// EXTERNAL SERVICE EXCEPTIONS
// ============================================
export class ExternalServiceException extends AppException {
  constructor(service: string, originalError?: string) {
    super(
      `El servicio externo "${service}" no esta disponible. Reintentando automaticamente.`,
      'EXTERNAL_SERVICE_ERROR', 503,
      { service, originalError },
    );
  }
}
```

### Exception Tree Visual
```
AppException (base)
├── ValidationException                    → 422
├── UnauthorizedException                  → 401
├── ForbiddenException                     → 403
│   ├── InsufficientPermissionsException   → 403
│   ├── PlanLimitExceededException         → 403
│   └── FeatureNotAvailableException       → 403
├── NotFoundException                      → 404
│   ├── ProjectNotFoundException
│   ├── TaskNotFoundException
│   ├── OrganizationNotFoundException
│   └── SprintNotFoundException
├── ConflictException                      → 409
│   └── DuplicateResourceException
├── SubscriptionExpiredException           → 402
├── RateLimitException                     → 429
└── InternalException                      → 500
    ├── DatabaseException
    └── ExternalServiceException           → 503
```

## 10.2 Global Exception Filter (NestJS Best Practice)

NO se hace try-catch en controllers. Todo error se propaga y se captura aqui:

```typescript
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Logger,
    private readonly configService: AppConfigService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId = request.headers['x-correlation-id'] as string;
    const { statusCode, body } = this.buildErrorResponse(exception, correlationId, request);

    // Log: errores 5xx se logean como error, 4xx como warn
    const logPayload = {
      correlationId,
      method: request.method,
      url: request.url,
      statusCode,
      userId: request.user?.id,
      orgId: request.user?.organizationId,
      error: body.error.code,
      message: body.error.message,
    };

    if (statusCode >= 500) {
      this.logger.error(logPayload, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(logPayload);
    }

    response.status(statusCode).json(body);
  }

  private buildErrorResponse(exception: unknown, correlationId: string, request: Request) {
    // Zentik domain exception
    if (exception instanceof AppException) {
      return {
        statusCode: exception.statusCode,
        body: {
          success: false,
          error: {
            code: exception.code,
            message: exception.message,
            details: exception.details,
            correlationId,
            timestamp: exception.timestamp,
            path: request.url,
          },
        },
      };
    }

    // NestJS built-in HttpException
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      return {
        statusCode: status,
        body: {
          success: false,
          error: {
            code: this.mapStatusToCode(status),
            message: typeof exceptionResponse === 'string'
              ? exceptionResponse
              : (exceptionResponse as any).message,
            details: typeof exceptionResponse === 'object' ? exceptionResponse : undefined,
            correlationId,
            timestamp: new Date().toISOString(),
            path: request.url,
          },
        },
      };
    }

    // Unknown error — NEVER expose internals to client
    return {
      statusCode: 500,
      body: {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: this.configService.isProduction
            ? 'Ha ocurrido un error inesperado. Nuestro equipo ha sido notificado.'
            : (exception as Error)?.message || 'Unknown error',
          correlationId,
          timestamp: new Date().toISOString(),
          path: request.url,
        },
      },
    };
  }
}
```

## 10.3 Result Type Pattern — Para Logica de Negocio

Cuando una operacion puede fallar de forma ESPERADA, usa Result en vez de throw:

```typescript
// Result type — explicit success/failure without exceptions
type Result<T, E = AppException> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// Uso en TaskService
async assignTask(taskId: string, userId: string): Promise<Result<Task>> {
  const task = await this.taskRepository.findById(taskId);
  if (!task) return Err(new TaskNotFoundException(taskId));

  const member = await this.memberRepository.findByUserId(userId);
  if (!member) return Err(new ForbiddenException('task', 'assign'));

  const activeTimers = await this.timerService.getActiveCount(userId);
  if (activeTimers >= 3) {
    return Err(new ValidationException({
      field: 'userId',
      message: 'El usuario ya tiene 3 tareas activas con timer. Detiene una antes de asignar otra.',
    }));
  }

  const updated = await this.taskRepository.assign(taskId, userId);
  this.eventEmitter.emit('task.assigned', new TaskAssignedEvent(taskId, userId));
  return Ok(updated);
}

// En el controller — limpio, sin try-catch
@Patch(':taskId/assign')
async assignTask(
  @Param('taskId', ParseUUIDPipe) taskId: string,
  @Body() dto: AssignTaskDto,
) {
  const result = await this.taskService.assignTask(taskId, dto.userId);
  if (!result.ok) throw result.error; // GlobalExceptionFilter lo captura
  return { success: true, data: result.value };
}
```

## 10.4 Circuit Breaker — Para Servicios Externos

SendGrid cae, Google Calendar no responde, S3 tiene latencia. Sin circuit breaker, cada request del usuario espera el timeout:

```typescript
enum CircuitState {
  CLOSED = 'closed',       // Funcionando normal
  OPEN = 'open',           // Servicio caido, rechazar rapido
  HALF_OPEN = 'half_open', // Probando si se recupero
}

@Injectable()
export class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime: Date | null = null;
  private successCount = 0;

  constructor(
    private readonly failureThreshold = 5,
    private readonly timeout = 60_000, // 60 seconds
    private readonly successThreshold = 2,
  ) {}

  async execute<T>(fn: () => Promise<T>, fallback?: () => T): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime!.getTime() > this.timeout) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else if (fallback) {
        return fallback();
      } else {
        throw new ExternalServiceException('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      if (fallback) return fallback();
      throw error;
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = CircuitState.CLOSED;
      }
    }
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = new Date();
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }
}

// Uso en EmailService
@Injectable()
export class EmailService {
  private circuit = new CircuitBreaker(5, 60_000);

  async sendNotification(to: string, subject: string, body: string): Promise<void> {
    await this.circuit.execute(
      () => this.sendgrid.send({ to, from: this.fromEmail, subject, html: body }),
      () => this.queueForRetry(to, subject, body), // Fallback: encolar para reintento
    );
  }
}
```

## 10.5 Retry with Exponential Backoff

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  backoffMs = 1000,
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts - 1) {
        const delay = backoffMs * Math.pow(2, attempt); // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

// Uso
const calendarEvents = await withRetry(
  () => this.googleCalendar.listEvents(userId),
  3,
  2000,
);
```

## 10.6 Error Aggregation — Para Validaciones Batch

```typescript
class ErrorCollector {
  private errors: { field: string; message: string }[] = [];

  add(field: string, message: string): void {
    this.errors.push({ field, message });
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  throwIfErrors(): void {
    if (this.hasErrors()) {
      throw new ValidationException({ errors: this.errors });
    }
  }
}

// Uso en importacion masiva de tareas
async importTasks(projectId: string, tasks: ImportTaskDto[]): Promise<Result<Task[]>> {
  const errors = new ErrorCollector();

  tasks.forEach((task, index) => {
    if (!task.title) errors.add(`tasks[${index}].title`, 'El titulo es obligatorio');
    if (task.storyPoints && task.storyPoints > 100) {
      errors.add(`tasks[${index}].storyPoints`, 'Story points no puede ser mayor a 100');
    }
  });

  errors.throwIfErrors();

  const created = await this.taskRepository.createMany(projectId, tasks);
  return Ok(created);
}
```

## 10.7 Error Response Format

Toda respuesta de error sigue este formato exacto. Sin excepciones:

```json
{
  "success": false,
  "error": {
    "code": "PLAN_LIMIT_EXCEEDED",
    "message": "Tu plan Free permite maximo 3 proyectos. Actualiza a Pro para proyectos ilimitados.",
    "details": {
      "currentUsage": 3,
      "planLimit": 3,
      "currentPlan": "free",
      "suggestedPlan": "pro",
      "upgradePath": "/settings/billing"
    },
    "correlationId": "req-7f3a-4b2c-9d1e",
    "timestamp": "2026-03-14T10:30:00.000Z",
    "path": "/api/v1/organizations/org-123/projects"
  }
}
```

### Error Codes Catalog Completo

| Code | HTTP | Cuando |
|------|------|--------|
| `VALIDATION_ERROR` | 422 | Input no pasa validacion de DTO |
| `UNAUTHORIZED` | 401 | Sin sesion o sesion expirada |
| `FORBIDDEN` | 403 | Rol no tiene permiso |
| `INSUFFICIENT_PERMISSIONS` | 403 | Permiso especifico faltante |
| `PLAN_LIMIT_EXCEEDED` | 403 | Limite del plan alcanzado |
| `FEATURE_NOT_AVAILABLE` | 403 | Feature no incluida en el plan |
| `SUBSCRIPTION_EXPIRED` | 402 | Suscripcion vencida |
| `PROJECT_NOT_FOUND` | 404 | Proyecto no existe o eliminado |
| `TASK_NOT_FOUND` | 404 | Tarea no existe o eliminada |
| `ORGANIZATION_NOT_FOUND` | 404 | Organizacion no existe |
| `SPRINT_NOT_FOUND` | 404 | Sprint no existe |
| `USER_NOT_FOUND` | 404 | Usuario no encontrado en org |
| `DUPLICATE_RESOURCE` | 409 | Recurso ya existe (email, slug) |
| `RATE_LIMITED` | 429 | Demasiadas peticiones |
| `EXTERNAL_SERVICE_ERROR` | 503 | SendGrid, S3, Google Calendar caido |
| `INTERNAL_ERROR` | 500 | Error inesperado (logueado, equipo notificado) |

## 10.8 Frontend Error Boundaries (Next.js)

```typescript
// app/(dashboard)/error.tsx — Captura errores en toda la seccion dashboard
'use client';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h2 className="text-xl font-semibold">Algo salio mal</h2>
      <p className="text-muted-foreground">
        {error.message || 'Ha ocurrido un error inesperado.'}
      </p>
      <button onClick={reset} className="btn-primary">
        Intentar de nuevo
      </button>
    </div>
  );
}

// app/global-error.tsx — Captura errores en el root layout
'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div className="flex flex-col items-center justify-center min-h-screen">
          <h1>Error critico</h1>
          <p>Estamos trabajando en solucionarlo.</p>
          <button onClick={reset}>Recargar</button>
        </div>
      </body>
    </html>
  );
}

// app/(dashboard)/projects/[projectId]/not-found.tsx
export default function ProjectNotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh]">
      <h2>Proyecto no encontrado</h2>
      <p>Este proyecto no existe, fue eliminado, o no tienes acceso.</p>
      <Link href="/projects">Volver a proyectos</Link>
    </div>
  );
}

// app/forbidden.tsx
export default function Forbidden() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh]">
      <h2>Acceso denegado</h2>
      <p>No tienes permisos para acceder a este recurso. Contacta al administrador.</p>
    </div>
  );
}

// app/unauthorized.tsx
export default function Unauthorized() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <h2>Sesion expirada</h2>
      <p>Tu sesion ha expirado. Inicia sesion para continuar.</p>
      <Link href="/login">Iniciar sesion</Link>
    </div>
  );
}
```

**Regla critica de Next.js**: NUNCA envolver `redirect()`, `notFound()`, `forbidden()` o `unauthorized()` dentro de un try-catch. Estas funciones lanzan errores especiales que Next.js maneja internamente:

```typescript
// Server Action — CORRECTO
async function createProject(formData: FormData) {
  let project;
  try {
    project = await projectService.create(formData);
  } catch (error) {
    return { error: 'No se pudo crear el proyecto' };
  }
  redirect(`/projects/${project.id}`); // FUERA del try-catch
}
```

## 10.9 Structured Logging

```typescript
// Formato JSON para agregacion de logs
{
  "level": "error",
  "timestamp": "2026-03-14T10:30:00.000Z",
  "correlationId": "req-7f3a-4b2c-9d1e",
  "service": "zentik-api",
  "method": "POST",
  "url": "/api/v1/organizations/org-123/projects",
  "userId": "user-456",
  "orgId": "org-123",
  "duration": 245,
  "statusCode": 403,
  "error": {
    "code": "PLAN_LIMIT_EXCEEDED",
    "message": "Tu plan Free permite maximo 3 proyectos",
    "stack": "PlanLimitExceededException: ...\n    at ProjectService.create..."
  }
}
```

### Log Levels — Cuando Usar Cada Uno
| Level | Cuando | Ejemplo Zentik |
|-------|--------|----------------|
| `error` | Errores inesperados, data corruption, servicios externos caidos | DB connection lost, Prisma query failed, SendGrid 500 |
| `warn` | Errores esperados, rate limits, deprecated usage | Plan limit hit, brute force detected, deprecated API version |
| `info` | Eventos de negocio, lifecycle de requests | User registered, project created, invoice sent, sprint completed |
| `debug` | Detalles tecnicos (solo dev/staging) | Cache hit/miss, query duration, Redis key set, WebSocket connection |

## 10.10 Correlation ID Tracking

Cada request genera un ID unico que viaja por TODA la cadena:

```
Client Request
  → X-Correlation-ID: req-7f3a-4b2c-9d1e
    → NestJS Controller (logged)
      → TaskService (logged)
        → Prisma Query (logged)
        → Redis Cache (logged)
        → EventEmitter → NotificationService (logged)
          → SendGrid API (logged)
    → Response header: X-Correlation-ID: req-7f3a-4b2c-9d1e
```

Si un usuario reporta un error, con el `correlationId` del response puedes rastrear TODO el journey del request en los logs.

## 10.11 Error Monitoring (Sentry)

- Source maps subidos automaticamente en cada deploy
- Contexto de usuario adjunto a cada error (userId, orgId, plan, role)
- Performance monitoring habilitado (transaction tracing)
- Alertas configuradas:
  - >5 errores/minuto en el mismo endpoint → Slack alert
  - Cualquier error 500 → notificacion inmediata
  - Latencia p95 >500ms → warning
- Errores agrupados por `error.code` para no duplicar issues
- Release tracking vinculado a commits de GitHub

---

# 11. TESTING STRATEGY

## 11.1 Testing Pyramid

```
        ╱╲
       ╱  ╲        E2E Tests (Playwright)
      ╱ 10 ╲       Critical user journeys
     ╱──────╲
    ╱        ╲      Integration Tests (Supertest)
   ╱   30%    ╲     API endpoints, DB queries
  ╱────────────╲
 ╱              ╲    Unit Tests (Jest)
╱     60%        ╲   Services, utils, pure logic
╱────────────────────╲
```

## 11.2 Unit Testing

- **Tool**: Jest with `@nestjs/testing`
- **What to test**: Services (business logic), utility functions, DTOs validation, guards, pipes
- **What NOT to test**: Controllers (tested via integration), Prisma queries (tested via integration), third-party libraries
- **Mocking**: Mock Prisma Client, Redis Client, external services. Never mock the service being tested.

```typescript
// Example: TaskService unit test
describe("TaskService", () => {
  let service: TaskService;
  let prisma: DeepMockProxy<PrismaClient>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: PrismaService, useValue: mockDeep<PrismaClient>() },
      ],
    }).compile();

    service = module.get(TaskService);
    prisma = module.get(PrismaService);
  });

  it("should create a task with correct defaults", async () => {
    prisma.task.create.mockResolvedValue(mockTask);
    const result = await service.create(createTaskDto, userId);
    expect(result.status).toBe("BACKLOG");
    expect(result.priority).toBe("NONE");
  });
});
```

## 11.3 Integration Testing

- **Tool**: Supertest + Jest + test database (Docker PostgreSQL)
- **Setup**: `docker-compose.test.yml` spins up isolated PostgreSQL and Redis
- **Strategy**: Each test suite gets a clean database (truncate tables between suites)

```typescript
// Example: Task API integration test
describe("POST /api/v1/projects/:id/tasks", () => {
  it("should create a task when authenticated PM", async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set("Cookie", authCookie)
      .send({ title: "Implement login", priority: "HIGH" })
      .expect(201);

    expect(response.body.success).toBe(true);
    expect(response.body.data.title).toBe("Implement login");
  });

  it("should return 403 when viewer tries to create task", async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set("Cookie", viewerCookie)
      .send({ title: "Test" })
      .expect(403);
  });
});
```

## 11.4 E2E Testing

- **Tool**: Playwright
- **Coverage**: 5-8 critical user journeys

| # | Journey | Steps |
|---|---------|-------|
| 1 | Registration & Onboarding | Register → verify email → create org → first project |
| 2 | Task Lifecycle | Create task → assign → move on board → mark done |
| 3 | Sprint Flow | Create sprint → add tasks → start → complete |
| 4 | Time Tracking | Start timer → work → stop → view report |
| 5 | Chat | Open channel → send message → receive reply (WebSocket) |
| 6 | Billing | Generate invoice → review → send → mark paid |
| 7 | RBAC | Admin creates role → assigns user → user verifies access |

## 11.5 Coverage Targets

| Layer | Target |
|-------|--------|
| Services (unit) | 80% |
| Controllers (integration) | 70% |
| E2E (critical paths) | 100% of defined journeys |
| Overall | 75% |

## 11.6 CI Test Pipeline

```yaml
# .github/workflows/ci.yml (test stage)
test:
  runs-on: ubuntu-latest
  services:
    postgres:
      image: postgres:16
      env:
        POSTGRES_DB: zentik_test
        POSTGRES_PASSWORD: test
    redis:
      image: redis:7
  steps:
    - run: pnpm run test          # Unit tests
    - run: pnpm run test:int      # Integration tests
    - run: pnpm run test:e2e      # E2E tests
    - run: pnpm run test:coverage # Coverage report
```

---

# 12. SECURITY CHECKLIST

## 12.1 OWASP Top 10 Mitigation

| # | Vulnerability | Mitigation |
|---|--------------|------------|
| A01 | Broken Access Control | RBAC via `RolesGuard` + `PermissionsGuard`. Resource ownership checked in service layer. All endpoints protected by default. |
| A02 | Cryptographic Failures | Passwords hashed with bcrypt (cost=12). Secrets in env vars, not code. HTTPS enforced. |
| A03 | Injection | Prisma ORM parameterizes all queries. No raw SQL without `$queryRaw` with tagged templates. Input validated with class-validator. |
| A04 | Insecure Design | Threat modeling done per module. Rate limiting on auth endpoints. Account lockout on brute force. |
| A05 | Security Misconfiguration | Env validation on startup. No default credentials. Helmet.js for security headers. CORS whitelist. |
| A06 | Vulnerable Components | `npm audit` in CI. Dependabot enabled. Lock file committed. |
| A07 | Auth Failures | Better Auth handles session management. HttpOnly + Secure cookies. Session invalidation on password change. |
| A08 | Data Integrity Failures | No deserialization of untrusted data. CI/CD pipeline secured. Signed commits enforced. |
| A09 | Logging Failures | Structured logging with correlation IDs. Audit log for all state changes. Sentry for error monitoring. |
| A10 | SSRF | No user-controlled URLs in server-side requests. Webhook URLs validated against allowlist. |

## 12.2 Security Headers (Helmet.js)

```typescript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", process.env.API_URL],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
```

## 12.3 CORS Configuration

```typescript
app.enableCors({
  origin: [process.env.WEB_URL],
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Correlation-ID"],
});
```

## 12.4 Data Encryption

- **In Transit**: TLS 1.3 enforced (Vercel and Railway handle this)
- **At Rest**: PostgreSQL encryption via Railway (encrypted volumes)
- **Sensitive Fields**: API keys and tokens encrypted with `pgcrypto` before storage
- **File Storage**: Server-side encryption on S3-compatible storage

---

# 13. PERFORMANCE & SCALABILITY

## 13.1 Caching Layers

```
Layer 1: Browser Cache
├── Static assets (JS, CSS, images) → Cache-Control: max-age=31536000 (immutable)
├── API responses → Cache-Control: private, max-age=0

Layer 2: CDN Cache (Vercel Edge)
├── SSG pages → cached at edge
├── ISR pages → stale-while-revalidate

Layer 3: Application Cache (Redis)
├── Board data → 30s TTL
├── Project lists → 5min TTL
├── User profiles → 15min TTL
├── Report aggregations → 10min TTL

Layer 4: Database
├── Query plan cache (PostgreSQL built-in)
├── Connection pool (Prisma)
```

## 13.2 Database Optimization

- **Indexes**: All filterable/sortable columns indexed (see Section 4)
- **Pagination**: Cursor-based for large datasets (messages, activity feed)
- **N+1 Prevention**: Prisma `include` and `select` used explicitly, never lazy loading
- **Query Analysis**: `EXPLAIN ANALYZE` on all queries hitting >100ms
- **Connection Pool**: 10 connections per Railway instance, scale horizontally with replicas

## 13.3 Horizontal Scaling Strategy

```
Phase 1 (0-1000 users): Single Railway instance + single DB
Phase 2 (1000-5000 users): 2 Railway instances + DB connection pool increase
Phase 3 (5000+ users):
├── Multiple API instances behind Railway load balancer
├── Redis Cluster for session/cache distribution
├── PostgreSQL read replica for report queries
└── BullMQ workers on separate instances
```

## 13.4 Background Job Processing (BullMQ)

```typescript
// Jobs processed asynchronously via Redis-backed queues
Queues:
├── email-queue        → Send emails (SendGrid)
├── notification-queue → Create in-app notifications + WebSocket push
├── report-queue       → Generate heavy report aggregations
├── file-queue         → Process uploads (thumbnail, virus scan)
├── invoice-queue      → Generate PDF invoices
└── cleanup-queue      → Hard delete soft-deleted records after 30 days
```

## 13.5 Frontend Performance

- **Next.js Image Optimization**: `next/image` with Vercel image optimizer
- **Code Splitting**: Automatic via Next.js App Router
- **Lazy Loading**: Heavy components (Kanban board, charts, chat) loaded dynamically
- **Bundle Analysis**: `@next/bundle-analyzer` run monthly, target <200KB first load JS
- **Zustand**: Lightweight state management (1.1KB), no Redux overhead

---

# 14. DEVOPS & DEPLOYMENT

## 14.1 Docker — Local Development

```yaml
# docker/docker-compose.yml
version: "3.9"

services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: zentik_dev
      POSTGRES_USER: zentik
      POSTGRES_PASSWORD: zentik_dev
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru

  minio:
    image: minio/minio
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data

volumes:
  postgres_data:
  minio_data:
```

## 14.2 Dockerfile — Backend (Multi-stage)

```dockerfile
# apps/api/Dockerfile
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build --filter=api
RUN pnpm prune --prod

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/prisma ./prisma
EXPOSE 3001
CMD ["node", "dist/main.js"]
```

## 14.3 CI/CD Pipeline (GitHub Actions)

```yaml
# .github/workflows/ci.yml
name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run type-check

  test:
    runs-on: ubuntu-latest
    needs: lint
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: zentik_test
          POSTGRES_PASSWORD: test
        ports: ["5432:5432"]
      redis:
        image: redis:7
        ports: ["6379:6379"]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm run test
      - run: pnpm run test:integration

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build

  deploy-api:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to Railway
        uses: bervProject/railway-deploy@v1
        with:
          railway_token: ${{ secrets.RAILWAY_TOKEN }}
          service: zentik-api
      - name: Run migrations
        run: railway run prisma migrate deploy
```

## 14.4 Branch Strategy

```
main          ← Production (auto-deploy to Vercel + Railway)
  └── develop ← Staging (auto-deploy to staging env)
       ├── feature/ZEN-123-task-filters
       ├── feature/ZEN-124-chat-threads
       ├── fix/ZEN-125-timer-bug
       └── release/1.1.0 ← Release prep branch
```

## 14.5 Deployment Strategy

- **Zero-downtime**: Railway handles rolling deployments
- **Database migrations**: Run BEFORE new code deploys (backward-compatible migrations only)
- **Rollback**: Railway instant rollback to previous deployment
- **Health checks**: `/api/v1/health/ready` must return 200 before traffic routes to new instance

## 14.6 Monitoring

- **Uptime**: UptimeRobot or BetterStack monitoring `/api/v1/health`
- **APM**: Sentry Performance Monitoring (transaction traces)
- **Logs**: Railway built-in log viewer + structured JSON logs
- **Alerts**: Sentry alerts → email/Slack on error spike

---

# 15. DEVELOPMENT WORKFLOW

## 15.1 Git Branching Strategy

**GitFlow Simplified**:
- `main` → production, always deployable
- `develop` → staging, integration branch
- `feature/*` → new features, branched from `develop`
- `fix/*` → bug fixes
- `release/*` → release preparation

## 15.2 Commit Convention (Conventional Commits)

```
<type>(<scope>): <description>

feat(task): add bulk update endpoint
fix(auth): handle expired OAuth tokens gracefully
refactor(board): extract column reorder logic to service
test(sprint): add integration tests for burndown endpoint
docs(api): update Swagger descriptions for time entries
chore(deps): update prisma to 5.x
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`

## 15.3 Code Review Guidelines

- Every PR requires at least 1 approval
- CI must pass before merge
- PR should be <400 lines of code (split large features into multiple PRs)
- Reviewer checklist: security, performance, error handling, test coverage
- Use "Request Changes" only for blocking issues

## 15.4 PR Template

```markdown
## What does this PR do?
<!-- Brief description of changes -->

## Type of change
- [ ] New feature
- [ ] Bug fix
- [ ] Refactoring
- [ ] Documentation

## Checklist
- [ ] Tests added/updated
- [ ] Swagger docs updated (if API change)
- [ ] No console.log or debug code
- [ ] Migration is backward-compatible
- [ ] Reviewed for security implications
```

## 15.5 Pre-commit Hooks (Husky + lint-staged)

```json
// package.json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.prisma": ["prisma format"]
  }
}
```

Hooks:
- `pre-commit` → lint-staged (format + lint changed files)
- `commit-msg` → commitlint (enforce conventional commits)

## 15.6 Recommended VS Code Extensions

```json
// .vscode/extensions.json
{
  "recommendations": [
    "prisma.prisma",
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "bradlc.vscode-tailwindcss",
    "ms-playwright.playwright",
    "humao.rest-client",
    "usernamehw.errorlens"
  ]
}
```

---

# 16. ROADMAP & MILESTONES

## Phase 1 — Foundation (Semana 1-2)

- [ ] Monorepo setup con Turborepo + pnpm
- [ ] NestJS bootstrap con global pipes, filters, interceptors, correlation ID
- [ ] Next.js setup con App Router, Tailwind, Shadcn/ui
- [ ] PostgreSQL + Prisma schema + first migration
- [ ] Redis connection + cache module
- [ ] Better Auth integration (email/password + Google OAuth + GitHub OAuth)
- [ ] RBAC implementation (roles, permissions, guards)
- [ ] **SaaS multi-tenancy: Organization model, Subscription model, PlanGuard**
- [ ] **Exception hierarchy completa + GlobalExceptionFilter**
- [ ] Docker Compose for local dev
- [ ] CI pipeline (lint + test + build)
- [ ] Organization + User + Subscription modules complete

## Phase 2 — Core Features (Semana 3-5)

- [ ] Project module (CRUD, members, settings)
- [ ] Board module (Kanban, columns, drag & drop)
- [ ] Task module (CRUD, subtasks, assignments, labels, filters)
- [ ] Sprint module (planning, backlog, start/complete)
- [ ] Time tracking module (manual entries + timer)
- [ ] File upload module
- [ ] Notification module (in-app + email via SendGrid)
- [ ] Audit log module
- [ ] API documentation (Swagger)

## Phase 3 — Frontend (Semana 6-8)

- [ ] Auth pages (login, register, forgot password)
- [ ] Dashboard layout (sidebar, topbar, breadcrumbs)
- [ ] Project list + project detail pages
- [ ] Kanban board with drag & drop (dnd-kit)
- [ ] Task detail modal/page
- [ ] Sprint planning UI
- [ ] Time tracker widget
- [ ] File upload UI with previews
- [ ] Notification center
- [ ] Settings pages (org, members, roles)

## Phase 4 — Communication & Billing (Semana 9-10)

- [ ] Chat module (channels, messages, threads via WebSocket)
- [ ] Real-time board updates (WebSocket)
- [ ] Billing module (invoices, PDF generation)
- [ ] Report module (dashboard, productivity, profitability charts)
- [ ] Calendar view + Google Calendar sync
- [ ] Client portal (limited project view)

## Phase 5 — Polish & Launch (Semana 11-12)

- [ ] E2E tests for critical journeys
- [ ] Performance optimization (caching, query optimization, bundle size)
- [ ] Security audit (OWASP checklist)
- [ ] Error monitoring setup (Sentry)
- [ ] Production deployment (Vercel + Railway)
- [ ] Database seeding for demo environment
- [ ] Landing page + pricing page
- [ ] Documentation final review

## Post-Launch Priorities

1. User feedback collection and iteration
2. GitHub integration (link PRs to tasks)
3. Mobile responsive optimization
4. Workflow automation engine (v2.0)
5. AI-powered features (v2.0)

---

# 17. APPENDIX

## 17.1 Glossary

| Term | Definition |
|------|-----------|
| **Organization** | Top-level entity representing a company/team using Zentik |
| **Workspace** | Synonym for Organization in user-facing language |
| **Project** | A client engagement or product being built by the organization |
| **Board** | Visual Kanban representation of tasks in a project |
| **Sprint** | Time-boxed iteration (typically 1-2 weeks) with a set of tasks |
| **Backlog** | Tasks not assigned to any sprint |
| **Story Points** | Relative estimation of task complexity |
| **Velocity** | Average story points completed per sprint |
| **Burndown** | Chart showing remaining work vs time in a sprint |
| **WIP Limit** | Maximum tasks allowed in a board column simultaneously |
| **Time Entry** | Record of time spent on a task |
| **Billable Hours** | Time entries marked as billable for invoice generation |

## 17.2 External References

| Resource | URL |
|----------|-----|
| NestJS Docs | https://docs.nestjs.com |
| Next.js Docs | https://nextjs.org/docs |
| Prisma Docs | https://www.prisma.io/docs |
| Better Auth Docs | https://www.better-auth.com/docs |
| Redis Docs | https://redis.io/docs |
| Turborepo Docs | https://turbo.build/repo/docs |
| Shadcn/ui | https://ui.shadcn.com |
| BullMQ | https://docs.bullmq.io |
| Socket.IO | https://socket.io/docs/v4 |

## 17.3 ADR Template

```markdown
# ADR-{NUMBER}: {Title}

## Status
Accepted | Proposed | Deprecated

## Context
What is the issue we are facing?

## Decision
What we decided to do and why.

## Consequences
What are the trade-offs?
```

## 17.4 Useful Commands Cheat Sheet

```bash
# ── Development ──────────────────────────────────
pnpm dev                          # Start all apps in dev mode
pnpm dev --filter=api             # Start only backend
pnpm dev --filter=web             # Start only frontend

# ── Database ─────────────────────────────────────
pnpm prisma:generate              # Generate Prisma Client
pnpm prisma:migrate               # Create and apply migration
pnpm prisma:studio                # Open Prisma Studio (GUI)
pnpm prisma:seed                  # Seed database
pnpm prisma:reset                 # Reset database (drop + migrate + seed)

# ── Testing ──────────────────────────────────────
pnpm test                         # Run all unit tests
pnpm test:watch                   # Watch mode
pnpm test:int                     # Integration tests
pnpm test:e2e                     # E2E tests (Playwright)
pnpm test:coverage                # Coverage report

# ── Code Quality ─────────────────────────────────
pnpm lint                         # ESLint check
pnpm lint:fix                     # ESLint auto-fix
pnpm format                       # Prettier format
pnpm type-check                   # TypeScript check (no emit)

# ── Build ────────────────────────────────────────
pnpm build                        # Build all apps
pnpm build --filter=api           # Build only backend
pnpm build --filter=web           # Build only frontend

# ── Docker (local) ───────────────────────────────
docker compose -f docker/docker-compose.yml up -d    # Start services
docker compose -f docker/docker-compose.yml down      # Stop services
docker compose -f docker/docker-compose.yml logs -f   # View logs

# ── Deployment ───────────────────────────────────
railway up                        # Deploy to Railway
vercel --prod                     # Deploy to Vercel (if manual)
```

---

> **Este documento es el contrato tecnico de Zentik.** Cada decision aqui tomada tiene un proposito.
> Revisalo, ajustalo, y cuando estes listo — empieza a construir.
>
> **Primer commit sugerido:**
> ```bash
> git init
> git add PROJECT_BLUEPRINT.md
> git commit -m "docs: add Zentik project blueprint v1.0"
> ```
