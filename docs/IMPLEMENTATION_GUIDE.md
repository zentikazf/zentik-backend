# Zentik v2 — Guia de Implementacion por Epicas

> **Uso:** Este archivo contiene TODO el contexto necesario para implementar cada epica.
> Desde otra sesion de Claude Code, solo di: "Lee zentik/docs/IMPLEMENTATION_GUIDE.md e implementa la Epica X".
> No necesitas explorar el codebase — todo esta documentado aqui.

---

## Estado actual del codebase (explorado 2026-03-30)

### Prisma Schema: `apps/api/prisma/schema.prisma`

**Enums actuales:**
```
TaskStatus: BACKLOG, TODO, IN_PROGRESS, IN_REVIEW, DONE, CANCELLED
ProjectStatus: DEFINITION, DEVELOPMENT, PRODUCTION, ON_HOLD, COMPLETED
TaskPriority: URGENT, HIGH, MEDIUM, LOW
SuggestionStatus: PENDING, REVIEWING, ACCEPTED, REJECTED, IMPLEMENTED
SuggestionPriority: LOW, MEDIUM, HIGH
SprintStatus: PLANNING, ACTIVE, COMPLETED, CANCELLED
AlcanceStatus: DRAFT, PENDING_APPROVAL, APPROVED, REJECTED
ChannelType: DM, GROUP, PROJECT
NotificationType: (incluye TASK_APPROVAL_REQUESTED, TASK_APPROVAL_APPROVED, TASK_APPROVAL_REJECTED)
```

**Modelos clave:**
- **Task** (lines 490-538): tiene `reviewAttempts: Int @default(0)`, `boardColumnId`, `status`, `clientVisible`, `parentTaskId`
- **Project** (lines 361-405): tiene `status: ProjectStatus @default(DEFINITION)`, `clientId`, `alcanceStatus`
- **Board** (lines 427-440): pertenece a Project, tiene columns[]
- **BoardColumn** (lines 442-458): tiene `mappedStatus: TaskStatus?`, `color`, `taskLimit` (WIP)
- **Suggestion** (lines 892-912): tiene `projectId`, `clientId`, `title`, `description`, `priority`, `status`, `adminNotes`, `taskId` (link a Task)
- **Client** (lines 846-864): tiene `userId: String? @unique` (one-to-one con User para portal)
- **Channel** (lines 619-642): tiene `type: ChannelType`, `projectId?`
- **Message** (lines 659-675): tiene `channelId`, `userId`, `content`
- **AuditLog** (lines 817-840): tiene `action`, `resource`, `resourceId`, `oldData`, `newData`

### Board defaults (board.service.ts lines 40-47)
```
| Pos | Name            | Color   | mappedStatus |
|-----|-----------------|---------|--------------|
| 0   | Descubrimiento  | #8B5CF6 | BACKLOG      |
| 1   | Planificacion   | #3B82F6 | TODO         |
| 2   | Desarrollo      | #F59E0B | IN_PROGRESS  |
| 3   | Testing         | #10B981 | IN_REVIEW    |
| 4   | Deploy          | #06B6D4 | DONE         |
| 5   | Soporte         | #EF4444 | DONE         |
```

### Task approval flow (task-approval.service.ts)
- `approveTask()`: valida status === IN_REVIEW, cambia a DONE, mueve a columna DONE
- `rejectTask()`: valida status === IN_REVIEW, cambia a IN_PROGRESS, **incrementa reviewAttempts**, emite evento con `reason`
- Board drag-and-drop bloquea mover a columna DONE directamente (requiere aprobacion explicita)

### Portal (portal.controller.ts + portal.service.ts)
- Endpoints: `/portal/projects`, `/portal/projects/:id`, `/portal/suggestions`, `/portal/projects/:id/suggestions`
- Admin endpoints: `/projects/:id/suggestions`, `/projects/:id/suggestions/:id` (PATCH), `/projects/:id/suggestions/:id/convert` (POST)
- Portal sidebar items: Dashboard, Proyectos, Sugerencias, Notificaciones

### Chat system (chat.service.ts + chat.gateway.ts)
- REST: CRUD de channels + messages
- WebSocket gateway namespace `/chat`: eventos `message:send`, `message:typing`, `channel:join`, `channel:leave`
- ChannelTypes: DM, GROUP, PROJECT
- Cursor pagination para mensajes

### Client system (client.service.ts)
- CRUD basico + `createClientUser()`: crea User con rol "Cliente", permisos read (projects, tasks)
- Client.userId one-to-one con User
- Portal layout valida rol "Cliente" en organizationMembers

### Frontend structure
```
apps/web/src/
  app/
    (dashboard)/  -> Admin panel
      projects/[projectId]/
        board/page.tsx        -> Kanban de tareas
        tasks/[taskId]/page.tsx -> Detalle de tarea
        approvals/page.tsx    -> Aprobaciones
        suggestions/page.tsx  -> Gestion sugerencias (admin)
    (portal)/     -> Panel cliente
      portal/
        page.tsx              -> Dashboard
        projects/page.tsx     -> Proyectos
        suggestions/page.tsx  -> Sugerencias
        notifications/page.tsx
  components/
    kanban/board.tsx          -> Kanban con @dnd-kit/core
    kanban/column.tsx         -> Columna
    kanban/card.tsx           -> Card de tarea
    activity/activity-feed.tsx -> Feed de actividad
    chat/chat-window.tsx      -> Ventana de chat
    portal/portal-sidebar.tsx -> Sidebar portal
    layout/sidebar.tsx        -> Sidebar admin
    task/task-sheet.tsx       -> Modal detalle tarea
  lib/api-client.ts           -> Fetch-based HTTP client (credentials: 'include')
  types/index.ts              -> Tipos TypeScript
  stores/                     -> Zustand stores
  hooks/                      -> Custom hooks (use-auth, use-permissions, use-socket)
```

---

## EPICA 1: Task Detail Fixes

**Prioridad:** Alta (quick win, sin dependencias)
**Estimacion:** 2-3 horas

### 1a. Mostrar conteo de rechazos en detalle de tarea

**El campo `reviewAttempts` YA existe** en el modelo Task y se retorna en `getTaskById()`.

**Backend:** No necesita cambios. El campo ya se incluye en la respuesta.

**Frontend — archivo:** `apps/web/src/app/(dashboard)/projects/[projectId]/tasks/[taskId]/page.tsx`

**Cambio:** En el sidebar derecho (seccion de detalles), despues de "Columna" y antes de "Visible al cliente", agregar:

```tsx
{task.reviewAttempts > 0 && (
  <div className="flex items-center justify-between">
    <span className="text-sm text-muted-foreground">Rechazos</span>
    <Badge variant="destructive">{task.reviewAttempts}</Badge>
  </div>
)}
```

**Opcional — historial de rechazos:** Agregar una seccion debajo que muestre los audit logs filtrados por `action: 'task.approval.rejected'`:
- Endpoint: `GET /audit/tasks/{taskId}` (ya existe via `audit.service.ts listByTask()`)
- Filtrar en frontend los que tienen `action === 'task.approval.rejected'`
- Mostrar: fecha, quien rechazo, razon (en `newData.reason`)

### 1b. Fix activity logs en detalle de tarea

**Componente:** `apps/web/src/components/activity/activity-feed.tsx`

**Diagnostico probable:** El componente `ActivityFeed` recibe un prop `endpoint` y hace fetch. Verificar:

1. **Endpoint correcto:** Debe llamar a `/audit/tasks/{taskId}` o similar
2. **Verificar que audit.controller.ts expone el endpoint** — buscar en `apps/api/src/modules/audit/audit.controller.ts`:
   - Debe existir `GET /audit/tasks/:taskId` que llame a `auditService.listByTask(taskId)`
   - Si NO existe, crearlo:
   ```typescript
   @Get('audit/tasks/:taskId')
   @UseGuards(AuthGuard)
   async listByTask(
     @Param('taskId') taskId: string,
     @Query('page') page?: string,
     @Query('limit') limit?: string,
   ) {
     return this.auditService.listByTask(taskId, page ? +page : 1, limit ? +limit : 20);
   }
   ```
3. **Verificar audit.service.ts `listByTask()`** — el metodo ya existe, buscar que filtre por `resourceId: taskId` y ordene por `createdAt DESC`
4. **Verificar el componente frontend** — que el mapping de `action` a label sea correcto y que parsee `oldData`/`newData` para mostrar cambios

**Archivos a tocar:**
- `apps/api/src/modules/audit/audit.controller.ts` (verificar/crear endpoint)
- `apps/web/src/components/activity/activity-feed.tsx` (verificar endpoint URL y mapping)
- `apps/web/src/app/(dashboard)/projects/[projectId]/tasks/[taskId]/page.tsx` (verificar que pasa endpoint correcto)

---

## EPICA 2: Refactor Kanban de Tareas

**Prioridad:** Alta (fundacion para ticket->task flow)
**Estimacion:** 3-4 horas
**Dependencia:** Ninguna

### Objetivo
Simplificar de 6 columnas a 4: **Pendiente -> Desarrollo -> Testing -> Produccion**

### IMPORTANTE: NO cambiar el enum TaskStatus
Cambiar el enum es un breaking change masivo. Solo cambiar las columnas default del board.

### 2a. Cambiar columnas default en board.service.ts

**Archivo:** `apps/api/src/modules/board/board.service.ts` (lines 40-47)

**Reemplazar** el array de columnas default:

```typescript
const defaultColumns = [
  { name: 'Pendiente',   position: 0, color: '#8B5CF6', mappedStatus: 'BACKLOG' as TaskStatus },
  { name: 'Desarrollo',  position: 1, color: '#F59E0B', mappedStatus: 'IN_PROGRESS' as TaskStatus },
  { name: 'Testing',     position: 2, color: '#10B981', mappedStatus: 'IN_REVIEW' as TaskStatus },
  { name: 'Produccion',  position: 3, color: '#06B6D4', mappedStatus: 'DONE' as TaskStatus },
];
```

### 2b. Approval logic se mantiene intacta
- La logica en `task-approval.service.ts` sigue igual: IN_REVIEW -> approve -> DONE
- El board.service.ts ya bloquea drag a columnas DONE sin aprobacion
- Solo cambia el nombre visual: "Testing" (IN_REVIEW) requiere aprobacion para ir a "Produccion" (DONE)

### 2c. Boards existentes
- Los boards que ya existen con 6 columnas NO se migran automaticamente
- Opcion A: Crear endpoint para "resetear board a defaults" (recomendado)
- Opcion B: Migrar en Prisma seed/migration (peligroso si hay tareas en columnas custom)
- **Recomendacion:** Dejar los boards existentes como estan, solo nuevos boards usan las 4 columnas. Agregar boton "Restablecer columnas" en settings del board.

### 2d. Frontend
- Los nombres de columnas vienen del backend (column.name), NO estan hardcodeados
- No necesita cambios en componentes kanban

**Archivos a tocar:**
- `apps/api/src/modules/board/board.service.ts` (cambiar defaultColumns)

---

## EPICA 3: Kanban de Proyectos (NUEVO)

**Prioridad:** Media
**Estimacion:** 6-8 horas
**Dependencia:** Ninguna

### Objetivo
Vista kanban para gestionar proyectos por estado: **Descubrimiento -> Planificacion -> Desarrollo -> Testing -> Deploy -> Soporte**

### DECISION ARQUITECTONICA: NO crear Board model para proyectos
Over-engineering. Los proyectos se gestionan con su campo `status` directamente. El kanban es solo una vista frontend que agrupa por status.

### 3a. Actualizar ProjectStatus enum en Prisma

**Archivo:** `apps/api/prisma/schema.prisma`

```prisma
enum ProjectStatus {
  DISCOVERY       // antes DEFINITION
  PLANNING        // NUEVO
  DEVELOPMENT     // se mantiene
  TESTING         // NUEVO
  DEPLOY          // antes PRODUCTION
  SUPPORT         // NUEVO
  ON_HOLD         // se mantiene
  COMPLETED       // se mantiene
}
```

### 3b. Crear migracion Prisma

```bash
cd apps/api
npx prisma migrate dev --name update-project-statuses
```

**ANTES de migrar**, crear un script SQL que actualice datos existentes:
```sql
UPDATE "Project" SET status = 'DISCOVERY' WHERE status = 'DEFINITION';
UPDATE "Project" SET status = 'DEPLOY' WHERE status = 'PRODUCTION';
```

Agregar esto en la migracion generada ANTES del ALTER TYPE.

### 3c. Actualizar project.service.ts

**Archivo:** `apps/api/src/modules/project/project.service.ts`

- `create()`: default status cambia de `DEFINITION` a `DISCOVERY`
- `softDelete()`: verificar que el status final sigue siendo `COMPLETED` (OK)
- No necesita endpoint nuevo — `PATCH /projects/:id { status: 'TESTING' }` ya funciona

### 3d. Frontend: nuevo componente ProjectKanban

**Archivo nuevo:** `apps/web/src/components/project/project-kanban.tsx`

```tsx
// Columnas fijas basadas en ProjectStatus
const PROJECT_COLUMNS = [
  { status: 'DISCOVERY',    name: 'Descubrimiento', color: '#8B5CF6' },
  { status: 'PLANNING',     name: 'Planificacion',  color: '#3B82F6' },
  { status: 'DEVELOPMENT',  name: 'Desarrollo',     color: '#F59E0B' },
  { status: 'TESTING',      name: 'Testing',        color: '#10B981' },
  { status: 'DEPLOY',       name: 'Deploy',         color: '#06B6D4' },
  { status: 'SUPPORT',      name: 'Soporte',        color: '#EF4444' },
];
```

- Usa @dnd-kit/core (ya instalado)
- Cada columna filtra proyectos por status
- Drag-and-drop: `api.patch(`/projects/${projectId}`, { status: newStatus })`
- Excluir ON_HOLD y COMPLETED del kanban (mostrar como filtros laterales)

### 3e. Pagina de proyectos: toggle lista/kanban

**Archivo:** `apps/web/src/app/(dashboard)/projects/page.tsx`

- Agregar toggle (iconos LayoutGrid / LayoutList) en el header
- Estado local o query param: `?view=kanban` / `?view=list`
- Vista lista = lo que ya existe
- Vista kanban = nuevo componente `<ProjectKanban projects={projects} />`

### 3f. Actualizar tipos TypeScript frontend

**Archivo:** `apps/web/src/types/index.ts`

Actualizar `ProjectStatus`:
```typescript
type ProjectStatus = 'DISCOVERY' | 'PLANNING' | 'DEVELOPMENT' | 'TESTING' | 'DEPLOY' | 'SUPPORT' | 'ON_HOLD' | 'COMPLETED';
```

**Archivos a tocar:**
- `apps/api/prisma/schema.prisma`
- `apps/api/src/modules/project/project.service.ts`
- `apps/web/src/components/project/project-kanban.tsx` (NUEVO)
- `apps/web/src/app/(dashboard)/projects/page.tsx`
- `apps/web/src/types/index.ts`

---

## EPICA 4: Rename Sugerencias -> Tickets + Sistema de Tickets

**Prioridad:** Alta
**Estimacion:** 10-12 horas
**Dependencia:** Ninguna directa

### Objetivo
Transformar sugerencias en tickets con categorias, SLA, y adjuntos.

### 4a. Actualizar Prisma schema

**Archivo:** `apps/api/prisma/schema.prisma`

```prisma
enum TicketCategory {
  NEW_DEVELOPMENT
  SUPPORT_REQUEST
}

enum TicketStatus {
  OPEN
  IN_PROGRESS
  RESOLVED
  CLOSED
}

model Ticket {
  id              String           @id @default(cuid())
  organizationId  String           @map("organization_id")
  projectId       String?          @map("project_id")
  clientId        String           @map("client_id")
  title           String
  description     String?
  category        TicketCategory
  priority        SuggestionPriority @default(MEDIUM)
  status          TicketStatus     @default(OPEN)
  slaHours        Int?
  slaDeadline     DateTime?        @map("sla_deadline")
  adminNotes      String?          @map("admin_notes")
  taskId          String?          @unique @map("task_id")
  channelId       String?          @unique @map("channel_id")
  attachmentFileId String?         @map("attachment_file_id")
  createdAt       DateTime         @default(now()) @map("created_at")
  updatedAt       DateTime         @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  project      Project?     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  client       Client       @relation(fields: [clientId], references: [id], onDelete: Cascade)
  task         Task?        @relation(fields: [taskId], references: [id], onDelete: SetNull)
  channel      Channel?     @relation(fields: [channelId], references: [id], onDelete: SetNull)
  attachment   File?        @relation(fields: [attachmentFileId], references: [id], onDelete: SetNull)

  @@map("tickets")
}
```

**Nota:** Mantener el modelo Suggestion existente con `@@map("suggestions")` hasta migrar datos. O crear Ticket como modelo nuevo y migrar datos despues.

**Recomendacion:** Crear Ticket como modelo NUEVO. Migrar datos de Suggestion a Ticket con script. Eliminar Suggestion despues.

### 4b. SLA por prioridad

Calcular al crear ticket:
```typescript
const SLA_HOURS = {
  HIGH: 72,    // >3 dias
  MEDIUM: 48,  // 2 dias
  LOW: 24,     // 1 dia / 24 horas
};

const slaHours = SLA_HOURS[dto.priority];
const slaDeadline = new Date();
slaDeadline.setHours(slaDeadline.getHours() + slaHours);
```

### 4c. Nuevo modulo Ticket (backend)

**Crear carpeta:** `apps/api/src/modules/ticket/`

**Archivos:**
```
ticket/
  ticket.module.ts
  ticket.controller.ts     -> Endpoints admin
  ticket.service.ts         -> Logica de negocio
  dto/
    create-ticket.dto.ts
    update-ticket.dto.ts
    ticket-filter.dto.ts
```

**Endpoints portal (en portal.controller.ts):**
```
GET    /portal/tickets                          -> Listar mis tickets
GET    /portal/tickets/:ticketId                -> Detalle de ticket
POST   /portal/tickets                          -> Crear ticket
```

**Endpoints admin (en ticket.controller.ts):**
```
GET    /organizations/:orgId/tickets            -> Listar todos los tickets
GET    /tickets/:ticketId                       -> Detalle
PATCH  /tickets/:ticketId                       -> Actualizar status/adminNotes
POST   /tickets/:ticketId/assign                -> Asignar responsable
```

**CreateTicketDto:**
```typescript
export class CreateTicketDto {
  @IsString() @MinLength(3) @MaxLength(200)
  title: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsEnum(TicketCategory)
  category: TicketCategory;

  @IsOptional() @IsEnum(SuggestionPriority)
  priority?: SuggestionPriority;

  @IsOptional() @IsString()
  projectId?: string; // Requerido si category === SUPPORT_REQUEST

  @IsOptional() @IsString()
  attachmentFileId?: string; // Para NEW_DEVELOPMENT
}
```

### 4d. Frontend Portal: reemplazar Sugerencias por Tickets

**Sidebar:** `apps/web/src/components/portal/portal-sidebar.tsx`
- Cambiar item "Sugerencias" (`/portal/suggestions`) por "Tickets" (`/portal/tickets`)
- Icono: `Ticket` de lucide-react (o `LifeBuoy`)

**Pagina de tickets:** `apps/web/src/app/(portal)/portal/tickets/page.tsx` (NUEVA)
- Lista de tickets con status badges, prioridad, SLA countdown
- Boton "Nuevo Ticket" que abre modal

**Modal de creacion:** `apps/web/src/components/portal/create-ticket-dialog.tsx` (NUEVO)
```
Paso 1: Select categoria
  - "Nuevo desarrollo" -> muestra campo de adjuntar documento
  - "Solicitud de soporte" -> muestra select de proyecto

Paso 2: Formulario
  - Titulo (requerido)
  - Descripcion (opcional, textarea)
  - Prioridad: Alta (>3 dias), Media (2 dias), Baja (24 horas) — mostrar SLA al lado
  - [Si soporte] Select de proyecto
  - [Si nuevo desarrollo] Upload de documento (usar endpoint existente POST /files/upload)

Paso 3: Confirmar y enviar
```

**Detalle de ticket:** `apps/web/src/app/(portal)/portal/tickets/[ticketId]/page.tsx` (NUEVA)
- Layout split: izquierda = detalles, derecha = chat (si tiene channelId)
- Detalles: titulo, descripcion, categoria, prioridad, SLA, status, fecha creacion, admin notes
- Chat: componente `ChatWindow` embebido (reutilizar el existente)

**Archivos a tocar:**
- `apps/api/prisma/schema.prisma` (modelo Ticket)
- `apps/api/src/modules/ticket/` (modulo nuevo completo)
- `apps/api/src/modules/portal/portal.controller.ts` (nuevos endpoints de ticket)
- `apps/api/src/modules/portal/portal.service.ts` (logica de tickets)
- `apps/web/src/components/portal/portal-sidebar.tsx` (rename item)
- `apps/web/src/app/(portal)/portal/tickets/` (paginas nuevas)
- `apps/web/src/components/portal/create-ticket-dialog.tsx` (NUEVO)
- `apps/web/src/types/index.ts` (tipos Ticket)

---

## EPICA 5: Chat por Ticket

**Prioridad:** Media
**Estimacion:** 4-5 horas
**Dependencia:** Epica 4 (tickets)

### Objetivo
Cada ticket aprobado/en progreso tiene su propio canal de chat.

### 5a. Agregar ChannelType TICKET

**Archivo:** `apps/api/prisma/schema.prisma`

```prisma
enum ChannelType {
  DM
  GROUP
  PROJECT
  TICKET    // NUEVO
}
```

### 5b. Auto-crear Channel al cambiar status de ticket

**Archivo:** `apps/api/src/modules/ticket/ticket.service.ts`

Cuando el admin cambia status a `IN_PROGRESS`:
```typescript
// Crear canal de chat para el ticket
const channel = await this.chatService.createChannel({
  name: `Ticket: ${ticket.title}`,
  type: 'TICKET',
  organizationId: ticket.organizationId,
  memberIds: [adminUserId, clientUserId], // admin que atiende + cliente
});

// Vincular canal al ticket
await this.prisma.ticket.update({
  where: { id: ticketId },
  data: { channelId: channel.id },
});
```

### 5c. Frontend: chat embebido en detalle de ticket

**Archivo:** `apps/web/src/app/(portal)/portal/tickets/[ticketId]/page.tsx`

Layout del modal/pagina de detalle:
```
┌──────────────────────────────────────────────────────┐
│  Ticket #XYZ — Titulo del ticket                     │
├────────────────────────┬─────────────────────────────┤
│                        │                             │
│  DETALLES              │  CHAT EN VIVO               │
│                        │                             │
│  Estado: En progreso   │  [Mensajes del canal]       │
│  Prioridad: Alta       │                             │
│  SLA: 48h (quedan 32h) │                             │
│  Categoria: Soporte    │                             │
│  Proyecto: Zentik      │                             │
│  Creado: hace 2h       │                             │
│  Admin: Juan           │                             │
│                        │  ┌─────────────────────┐    │
│  Descripcion:          │  │ Escribe un mensaje  │    │
│  Lorem ipsum...        │  └─────────────────────┘    │
│                        │                             │
└────────────────────────┴─────────────────────────────┘
```

- Si `ticket.channelId` existe: renderizar `<ChatWindow channelId={ticket.channelId} />`
- Si no existe: mostrar mensaje "El chat se habilitara cuando el equipo atienda tu ticket"
- Reutilizar componente `apps/web/src/components/chat/chat-window.tsx` existente

### 5d. Notificaciones

Agregar a NotificationType enum:
```prisma
TICKET_CREATED
TICKET_ASSIGNED
TICKET_MESSAGE
```

Emitir eventos cuando:
- Cliente crea ticket -> notifica admins
- Admin responde en chat -> notifica cliente
- Ticket cambia status -> notifica cliente

**Archivos a tocar:**
- `apps/api/prisma/schema.prisma` (ChannelType TICKET, NotificationType)
- `apps/api/src/modules/ticket/ticket.service.ts` (auto-crear channel)
- `apps/api/src/modules/chat/chat.service.ts` (soporte para tipo TICKET)
- `apps/web/src/app/(portal)/portal/tickets/[ticketId]/page.tsx`

---

## EPICA 6: Ticket -> Task (auto-creacion para soporte)

**Prioridad:** Media
**Estimacion:** 3-4 horas
**Dependencia:** Epica 2 (kanban tareas) + Epica 4 (tickets)

### Objetivo
Tickets de "Solicitud de soporte" crean tarea automaticamente.

### 6a. Al crear ticket con category=SUPPORT_REQUEST

**Archivo:** `apps/api/src/modules/ticket/ticket.service.ts` (o portal.service.ts)

```typescript
async createTicket(dto: CreateTicketDto, clientId: string, organizationId: string) {
  const ticket = await this.prisma.ticket.create({ ... });

  // Si es soporte, crear tarea automaticamente
  if (dto.category === 'SUPPORT_REQUEST' && dto.projectId) {
    const task = await this.taskService.createTask(dto.projectId, {
      title: `[Ticket] ${dto.title}`,
      description: dto.description,
      priority: this.mapPriority(dto.priority), // SuggestionPriority -> TaskPriority
      status: 'BACKLOG', // Cae en columna "Pendiente"
      clientVisible: true,
    }, 'system'); // userId = system o el admin owner

    // Vincular ticket con tarea
    await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: { taskId: task.id },
    });
  }

  return ticket;
}
```

### 6b. Badge "Requiere configuracion" en tarea

**Archivo:** `apps/web/src/components/kanban/card.tsx`

Cuando una tarea viene de un ticket y no tiene assignee ni estimatedHours:
```tsx
{task.assignments.length === 0 && !task.estimatedHours && (
  <Badge variant="outline" className="text-amber-500 border-amber-500">
    Requiere configuracion
  </Badge>
)}
```

### 6c. Mapping de prioridad

```typescript
private mapPriority(suggestionPriority: SuggestionPriority): TaskPriority {
  const map = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };
  return map[suggestionPriority] as TaskPriority;
}
```

**Archivos a tocar:**
- `apps/api/src/modules/ticket/ticket.service.ts`
- `apps/api/src/modules/task/task.service.ts` (importar en ticket module)
- `apps/web/src/components/kanban/card.tsx` (badge)

---

## EPICA 7: Sub-usuarios de Cliente

**Prioridad:** Media
**Estimacion:** 5-6 horas
**Dependencia:** Ninguna directa, complementa Epica 4

### Objetivo
Cada cliente (empresa) puede tener multiples usuarios con acceso al portal.

### 7a. Actualizar Prisma schema

**Archivo:** `apps/api/prisma/schema.prisma`

Agregar al modelo User:
```prisma
model User {
  // ... campos existentes
  clientId    String?  @map("client_id")  // NUEVO: vincula sub-usuarios al cliente

  client      Client?  @relation("ClientUsers", fields: [clientId], references: [id], onDelete: SetNull)
  // ... relaciones existentes
}
```

Actualizar modelo Client:
```prisma
model Client {
  // ... campos existentes
  userId         String?  @unique @map("user_id")  // Owner del cliente

  user           User?    @relation("ClientOwner", fields: [userId], references: [id], onDelete: SetNull)
  users          User[]   @relation("ClientUsers")  // NUEVO: sub-usuarios
  // ... relaciones existentes
}
```

### 7b. Endpoint para crear sub-usuarios

**Archivo:** `apps/api/src/modules/client/client.controller.ts`

Agregar:
```typescript
@Post('organizations/:orgId/clients/:clientId/users')
@Permissions('manage:members')
async createSubUser(
  @Param('orgId') orgId: string,
  @Param('clientId') clientId: string,
  @Body() dto: CreateClientUserDto,
) {
  return this.clientService.createSubUser(orgId, clientId, dto);
}

@Get('organizations/:orgId/clients/:clientId/users')
async listSubUsers(
  @Param('clientId') clientId: string,
) {
  return this.clientService.listSubUsers(clientId);
}

@Delete('organizations/:orgId/clients/:clientId/users/:userId')
@Permissions('manage:members')
async deleteSubUser(
  @Param('clientId') clientId: string,
  @Param('userId') userId: string,
) {
  return this.clientService.deleteSubUser(clientId, userId);
}
```

### 7c. Service: createSubUser()

**Archivo:** `apps/api/src/modules/client/client.service.ts`

Similar a `createClientUser()` existente pero:
- NO setea `Client.userId` (ese es el owner)
- Setea `User.clientId = client.id`
- Mismo rol "Cliente" con permisos read
- `mustChangePassword: true`

### 7d. Portal: sub-usuarios ven lo mismo

**Archivo:** `apps/api/src/modules/portal/portal.service.ts`

Cambiar la query de proyectos del portal:
```typescript
// ANTES: filtra por Client.userId === user.id
// DESPUES: filtra por user.clientId O Client.userId === user.id
async getClientId(userId: string): Promise<string> {
  // Buscar si es owner
  const clientAsOwner = await this.prisma.client.findUnique({
    where: { userId },
  });
  if (clientAsOwner) return clientAsOwner.id;

  // Buscar si es sub-usuario
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { clientId: true },
  });
  if (user?.clientId) return user.clientId;

  throw new UnauthorizedException('No tiene acceso al portal');
}
```

### 7e. Frontend admin: gestion de sub-usuarios

**Archivo:** `apps/web/src/app/(dashboard)/clients/page.tsx` (o detalle del cliente)

Agregar seccion "Usuarios" en la vista de detalle de cliente:
- Lista de sub-usuarios con nombre, email, fecha creacion
- Boton "Agregar usuario" que abre modal con formulario (nombre, email, password)
- Boton eliminar por sub-usuario

**Archivos a tocar:**
- `apps/api/prisma/schema.prisma` (User.clientId, Client.users)
- `apps/api/src/modules/client/client.service.ts` (createSubUser, listSubUsers)
- `apps/api/src/modules/client/client.controller.ts` (endpoints)
- `apps/api/src/modules/portal/portal.service.ts` (query por clientId)
- `apps/web/src/app/(dashboard)/clients/page.tsx` (UI sub-usuarios)

---

## EPICA 8: Gestion de Horas Contratadas

**Prioridad:** Baja (depende de las demas)
**Estimacion:** 6-8 horas
**Dependencia:** Epica 7 + Epica 6

### Objetivo
Controlar horas de desarrollo por cliente, con prestamo si no tienen horas.

### 8a. Agregar campos al Client

**Archivo:** `apps/api/prisma/schema.prisma`

```prisma
model Client {
  // ... campos existentes
  contractedHours  Float    @default(0)  @map("contracted_hours")
  usedHours        Float    @default(0)  @map("used_hours")
  loanedHours      Float    @default(0)  @map("loaned_hours")
}
```

### 8b. Logica de negocio

Al crear tarea desde ticket de soporte:
1. Verificar `client.contractedHours - client.usedHours > 0`
2. Si tiene horas: restar de `usedHours`
3. Si NO tiene horas: marcar tarea como "Prestamo" y sumar a `loanedHours`
4. Requiere aprobacion del admin para proceder con prestamo

### 8c. Modelo HoursTransaction (historial)

```prisma
model HoursTransaction {
  id         String   @id @default(cuid())
  clientId   String   @map("client_id")
  type       String   // 'USAGE' | 'LOAN' | 'PURCHASE' | 'REFUND'
  hours      Float
  taskId     String?  @map("task_id")
  note       String?
  createdAt  DateTime @default(now()) @map("created_at")

  client Client @relation(fields: [clientId], references: [id])
  task   Task?  @relation(fields: [taskId], references: [id])

  @@map("hours_transactions")
}
```

### 8d. Frontend

**Admin:**
- En detalle de cliente: widget de horas (contratadas, usadas, prestadas, disponibles)
- Boton "Agregar horas" para cargar horas compradas
- Historial de transacciones

**Portal cliente:**
- Dashboard: card con horas restantes
- En creacion de ticket: warning si no tiene horas

**Archivos a tocar:**
- `apps/api/prisma/schema.prisma` (Client hours fields, HoursTransaction model)
- `apps/api/src/modules/client/client.service.ts` (logica de horas)
- `apps/api/src/modules/ticket/ticket.service.ts` (verificar horas al crear task)
- `apps/web/src/app/(dashboard)/clients/page.tsx` (widget horas)
- `apps/web/src/app/(portal)/portal/page.tsx` (card horas restantes)

---

## EPICA 9: Desactivar Panel de Aprobaciones de Sugerencias

**Prioridad:** Alta (quick win)
**Estimacion:** 30 minutos
**Dependencia:** Epica 4 (cuando tickets esten listos)

### Objetivo
Ocultar el sistema de sugerencias en la UI ya que sera reemplazado por tickets.

### Cambios

**Frontend solamente — NO eliminar codigo backend:**

1. **Sidebar del proyecto:** Si existe link a "Sugerencias" dentro del proyecto, ocultarlo con `{false && ...}` o remover el item
2. **Pagina de sugerencias admin:** `apps/web/src/app/(dashboard)/projects/[projectId]/suggestions/page.tsx` — mostrar mensaje "Este modulo ha sido reemplazado por el sistema de Tickets" con link a `/portal/tickets`
3. **Portal sidebar:** Ya se renombro en Epica 4

**NO tocar:**
- Backend endpoints de sugerencias (pueden ser necesarios para consultar datos historicos)
- Modelo Suggestion en Prisma (datos existentes)
- La aprobacion de TAREAS (approve/reject en Testing) SIGUE FUNCIONANDO — es otro sistema

---

## Orden de implementacion recomendado

```
Fase 1 (quick wins):
  EPICA 1 — Task detail fixes (2-3h)
  EPICA 9 — Desactivar aprobaciones sugerencias (30min)

Fase 2 (fundaciones):
  EPICA 2 — Refactor kanban tareas (3-4h)
  EPICA 3 — Kanban proyectos (6-8h)

Fase 3 (tickets):
  EPICA 4 — Sistema de tickets (10-12h)
  EPICA 5 — Chat por ticket (4-5h)
  EPICA 6 — Ticket -> Task (3-4h)

Fase 4 (clientes):
  EPICA 7 — Sub-usuarios cliente (5-6h)
  EPICA 8 — Horas contratadas (6-8h)
```

**Total estimado: ~40-50 horas de implementacion**

---

## Notas tecnicas importantes

1. **Migraciones Prisma:** Cada epica que modifica el schema necesita `npx prisma migrate dev`. Ejecutar en orden.
2. **@dnd-kit/core:** Ya instalado para kanban de tareas. Reutilizar para kanban de proyectos.
3. **WebSocket:** Gateway existente en `/chat`. Reutilizar para chat de tickets.
4. **API client:** `apps/web/src/lib/api-client.ts` — fetch-based con `credentials: 'include'`.
5. **Permisos:** Verificar que nuevos endpoints tengan `@UseGuards(AuthGuard, PermissionsGuard)`.
6. **Org verification:** Tras el fix de SEC-AUTHZ-001, todos los services deben recibir `organizationId` del usuario y filtrar por el.
7. **Tipos frontend:** Actualizar `apps/web/src/types/index.ts` con cada modelo nuevo.
