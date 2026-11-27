import 'reflect-metadata';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { AppException } from '../../../common/filters/app-exception';
import { TaskService } from '../task.service';
import { TaskController } from '../task.controller';
import { PrismaService } from '../../../database/prisma.service';
import { ProjectService } from '../../project/project.service';
import { ClientService } from '../../client/client.service';
import { TaskHoursGuardService } from '../task-hours-guard.service';
import { TaskRelationService } from '../task-relation.service';
import { TaskApprovalService } from '../task-approval.service';
import { AuthenticatedUser } from '../../../common/interfaces/request.interface';

/**
 * #74 Bloque A (R2) — el detalle de tarea sabe cuál es el chat de su ticket y si quien pide
 * es miembro.
 *
 * `isChannelMember` lo calcula el backend (D4): el front no adivina la membresía provocando un
 * 403. La query extra corre SÓLO si hay canal y usuario. `userId` es el tercer parámetro y es
 * opcional: una llamada con la firma vieja sigue andando y devuelve `false` sin consultar nada.
 *
 * Prisma MOCKEADO — NUNCA toca DATABASE_URL.
 */
describe('TaskService.getTaskById — chat del ticket (#74 Bloque A)', () => {
  const TASK_ID = 'task-1';
  const ORG_ID = 'org-1';
  const USER_ID = 'user-aprobador';
  const CHANNEL_ID = 'channel-ticket-1';

  let prisma: DeepMockProxy<PrismaService>;
  let service: TaskService;

  /** Lo mínimo que `getTaskById` lee del resultado (timeEntries para el total). */
  function tareaCon(ticket: { id: string; ticketNumber: string | null; channelId: string | null } | null) {
    return { id: TASK_ID, title: 'Tarea', timeEntries: [{ duration: 30 }, { duration: 15 }], ticket };
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new TaskService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<ProjectService>(),
      mockDeep<ClientService>(),
      mockDeep<TaskHoursGuardService>(),
    );
  });

  it('R2.1 — incluye del ticket SÓLO id, ticketNumber y channelId (select, no include)', async () => {
    prisma.task.findFirst.mockResolvedValue(tareaCon(null) as never);

    await service.getTaskById(TASK_ID, ORG_ID, USER_ID);

    const args = prisma.task.findFirst.mock.calls[0][0] as { include: Record<string, unknown> };
    expect(args.include.ticket).toEqual({ select: { id: true, ticketNumber: true, channelId: true } });
  });

  it('R2.2 — tarea de ticket + quien pide ES miembro → isChannelMember true', async () => {
    prisma.task.findFirst.mockResolvedValue(
      tareaCon({ id: 'ticket-1', ticketNumber: 'TK-00001', channelId: CHANNEL_ID }) as never,
    );
    prisma.channelMember.findUnique.mockResolvedValue({ id: 'cm-1' } as never);

    const res = await service.getTaskById(TASK_ID, ORG_ID, USER_ID);

    expect(res.ticket).toEqual({ id: 'ticket-1', ticketNumber: 'TK-00001', channelId: CHANNEL_ID });
    expect(res.isChannelMember).toBe(true);
    expect(prisma.channelMember.findUnique).toHaveBeenCalledWith({
      where: { channelId_userId: { channelId: CHANNEL_ID, userId: USER_ID } },
      select: { id: true },
    });
  });

  it('R2.2 — tarea de ticket + quien pide NO es miembro → isChannelMember false', async () => {
    prisma.task.findFirst.mockResolvedValue(
      tareaCon({ id: 'ticket-1', ticketNumber: 'TK-00001', channelId: CHANNEL_ID }) as never,
    );
    prisma.channelMember.findUnique.mockResolvedValue(null as never);

    const res = await service.getTaskById(TASK_ID, ORG_ID, USER_ID);

    expect(res.isChannelMember).toBe(false);
  });

  it('R2.3 — tarea sin ticket → ticket null, isChannelMember false, sin query de membresía', async () => {
    prisma.task.findFirst.mockResolvedValue(tareaCon(null) as never);

    const res = await service.getTaskById(TASK_ID, ORG_ID, USER_ID);

    expect(res.ticket).toBeNull();
    expect(res.isChannelMember).toBe(false);
    expect(prisma.channelMember.findUnique).not.toHaveBeenCalled();
  });

  it('ticket sin canal → isChannelMember false, sin query de membresía', async () => {
    prisma.task.findFirst.mockResolvedValue(
      tareaCon({ id: 'ticket-1', ticketNumber: 'TK-00001', channelId: null }) as never,
    );

    const res = await service.getTaskById(TASK_ID, ORG_ID, USER_ID);

    expect(res.isChannelMember).toBe(false);
    expect(prisma.channelMember.findUnique).not.toHaveBeenCalled();
  });

  it('firma vieja (sin userId) sigue andando: mismo resultado + isChannelMember false, sin query', async () => {
    prisma.task.findFirst.mockResolvedValue(
      tareaCon({ id: 'ticket-1', ticketNumber: 'TK-00001', channelId: CHANNEL_ID }) as never,
    );

    const res = await service.getTaskById(TASK_ID, ORG_ID);

    expect(res.totalDuration).toBe(45);
    expect(res.isChannelMember).toBe(false);
    expect(prisma.channelMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.task.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TASK_ID, project: { organizationId: ORG_ID } } }),
    );
  });

  it('GET /tasks/:taskId pasa el id de quien pide al service', async () => {
    const taskService = mockDeep<TaskService>();
    taskService.getTaskById.mockResolvedValue({} as never);
    const controller = new TaskController(
      taskService,
      mockDeep<TaskRelationService>(),
      mockDeep<TaskApprovalService>(),
      mockDeep<ClientService>(),
    );

    await controller.getTask(TASK_ID, { id: USER_ID, organizationId: ORG_ID, organizationIds: [ORG_ID] } as AuthenticatedUser);

    expect(taskService.getTaskById).toHaveBeenCalledWith(TASK_ID, ORG_ID, USER_ID);
  });
});

/**
 * #74 Bloque B (R3) — "Unirme": la única forma de entrar al chat del ticket desde la tarea.
 *
 * D1: la membresía del canal sigue siendo la ÚNICA regla para leer al cliente (REST y socket).
 * Entrar es explícito, idempotente y queda en el log de actividad de la tarea (R3.4: `AuditLog`
 * acepta una acción libre, sin migración). La fila se escribe DIRECTO, no por evento: el
 * `@OnEvent('**')` del AuditListener no recibe nada porque `EventEmitterModule.forRoot()` corre
 * sin `wildcard`. Un test que sólo verificara un `emit` daría verde sin que la fila exista
 * (hallazgo B1 del reviewer) — por eso se asierta `auditLog.create`.
 */
describe('POST /tasks/:taskId/ticket-chat/join (#74 Bloque B)', () => {
  const TASK_ID = 'task-1';
  const ORG_ID = 'org-1';
  const USER_ID = 'user-aprobador';
  const CHANNEL_ID = 'channel-ticket-1';
  const ORG_IDS = [ORG_ID];

  let prisma: DeepMockProxy<PrismaService>;
  let events: DeepMockProxy<EventEmitter2>;
  let service: TaskService;

  function tarea(ticket: { id: string; channelId: string | null } | null) {
    return { id: TASK_ID, title: 'Tarea', projectId: 'project-1', project: { organizationId: ORG_ID }, ticket };
  }

  function capturar(fn: () => unknown): Promise<AppException | null> {
    return Promise.resolve()
      .then(fn)
      .then(() => null, (e: AppException) => e);
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    events = mockDeep<EventEmitter2>();
    service = new TaskService(
      prisma,
      events,
      mockDeep<ProjectService>(),
      mockDeep<ClientService>(),
      mockDeep<TaskHoursGuardService>(),
    );
  });

  describe('R3.1 — permiso', () => {
    const guard = new PermissionsGuard(new Reflector());
    const handler = TaskController.prototype.joinTicketChat;

    function ctx(permissions: string[]): ExecutionContext {
      return {
        getHandler: () => handler,
        getClass: () => TaskController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', permissions } }) }),
      } as unknown as ExecutionContext;
    }

    it('declara exactamente manage:projects (el mismo permiso que aprobar)', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['manage:projects']);
    });

    it('usuario del portal (rol Cliente) → 403', async () => {
      const err = await capturar(() => guard.canActivate(ctx(['read:projects', 'read:tasks', 'read:chat', 'write:chat'])));
      expect(err).toBeInstanceOf(AppException);
      expect(err!.statusCode).toBe(403);
    });

    it('quien aprueba (manage:projects) entra', () => {
      expect(guard.canActivate(ctx(['manage:projects']))).toBe(true);
    });

    it('responde 200 (idempotente: unirse dos veces no crea nada nuevo)', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.OK);
    });
  });

  it('R3.2 — busca la tarea SÓLO en las organizaciones del usuario; de otra organización → 404', async () => {
    prisma.task.findFirst.mockResolvedValue(null as never);

    const err = await capturar(() => service.joinTicketChat(TASK_ID, USER_ID, ORG_IDS));

    expect(err).toBeInstanceOf(AppException);
    expect(err!.statusCode).toBe(404);
    expect(prisma.task.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TASK_ID, project: { organizationId: { in: ORG_IDS } } } }),
    );
    expect(prisma.channelMember.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('R3.2 — tarea sin ticket → 404, no toca la membresía', async () => {
    prisma.task.findFirst.mockResolvedValue(tarea(null) as never);

    const err = await capturar(() => service.joinTicketChat(TASK_ID, USER_ID, ORG_IDS));

    expect(err!.statusCode).toBe(404);
    expect(prisma.channelMember.upsert).not.toHaveBeenCalled();
  });

  it('R3.2 — ticket sin canal → 404', async () => {
    prisma.task.findFirst.mockResolvedValue(tarea({ id: 'ticket-1', channelId: null }) as never);

    const err = await capturar(() => service.joinTicketChat(TASK_ID, USER_ID, ORG_IDS));

    expect(err!.statusCode).toBe(404);
    expect(prisma.channelMember.upsert).not.toHaveBeenCalled();
  });

  it('R3.3/R3.4/R3.5 — se une con upsert, queda en la actividad de la tarea y devuelve { channelId }', async () => {
    prisma.task.findFirst.mockResolvedValue(tarea({ id: 'ticket-1', channelId: CHANNEL_ID }) as never);
    prisma.channelMember.findUnique.mockResolvedValue(null as never);

    const res = await service.joinTicketChat(TASK_ID, USER_ID, ORG_IDS);

    expect(res).toEqual({ channelId: CHANNEL_ID });
    expect(prisma.channelMember.upsert).toHaveBeenCalledWith({
      where: { channelId_userId: { channelId: CHANNEL_ID, userId: USER_ID } },
      create: { channelId: CHANNEL_ID, userId: USER_ID },
      update: {},
    });
    // resource 'task' + resourceId = taskId es exactamente el `where` de
    // AuditService.listByTask (audit.service.ts:103) → GET /tasks/:id/activity.
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG_ID,
        userId: USER_ID,
        action: 'task.ticket_chat.joined',
        resource: 'task',
        resourceId: TASK_ID,
        newData: { taskTitle: 'Tarea', projectId: 'project-1', ticketId: 'ticket-1', channelId: CHANNEL_ID },
      },
    });
    // Membresía y auditoría van juntas: o quedan las dos o ninguna.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((prisma.$transaction.mock.calls[0][0] as unknown[]).length).toBe(2);
    // Sin evento muerto: no hay listener que lo reciba.
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('R3.3 — dos llamadas → una sola escritura y un solo registro de actividad; las dos devuelven { channelId }', async () => {
    prisma.task.findFirst.mockResolvedValue(tarea({ id: 'ticket-1', channelId: CHANNEL_ID }) as never);
    prisma.channelMember.findUnique
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: 'cm-1' } as never);

    const primera = await service.joinTicketChat(TASK_ID, USER_ID, ORG_IDS);
    const segunda = await service.joinTicketChat(TASK_ID, USER_ID, ORG_IDS);

    expect(primera).toEqual({ channelId: CHANNEL_ID });
    expect(segunda).toEqual({ channelId: CHANNEL_ID });
    expect(prisma.channelMember.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('el controller pasa taskId, id y organizaciones de quien pide', async () => {
    const taskService = mockDeep<TaskService>();
    taskService.joinTicketChat.mockResolvedValue({ channelId: CHANNEL_ID });
    const controller = new TaskController(
      taskService,
      mockDeep<TaskRelationService>(),
      mockDeep<TaskApprovalService>(),
      mockDeep<ClientService>(),
    );

    const res = await controller.joinTicketChat(TASK_ID, { id: USER_ID, organizationIds: ORG_IDS } as AuthenticatedUser);

    expect(res).toEqual({ channelId: CHANNEL_ID });
    expect(taskService.joinTicketChat).toHaveBeenCalledWith(TASK_ID, USER_ID, ORG_IDS);
  });
});
