import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import request from 'supertest';
import { ChatController } from './chat.controller';
import { ChannelService, MessageService } from './chat.service';
import { AuthGuard } from '../auth/guards';
import { PrismaService } from '../../database/prisma.service';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator';
import { GlobalExceptionFilter } from '../../common/filters';
import { AppConfigService } from '../../config/app.config';

/**
 * #74 Bloque 0 (R1) — quién puede agregar o quitar miembros de un canal.
 *
 * El hueco: `POST /channels/:channelId/members` y `DELETE /channels/:channelId/members/:userId`
 * sólo exigían el `read:chat` del controller, y `ChannelService.addMember/removeMember` no miran
 * quién pide. Los usuarios del portal tienen `read:chat` (rol "Cliente",
 * `client.service.ts` → `ensureClienteRole`). El candado de tenencia de #69 resuelve
 * `channelId` a su organización: frena ENTRE organizaciones, no DENTRO de la misma. Cadena:
 * un usuario del portal se agrega a sí mismo al canal TICKET de un ticket de OTRO cliente de su
 * misma organización, y después lo lee con la membresía recién creada.
 *
 * Por eso esto es un test HTTP y no sólo de metadata: levanta un Nest real con el controller
 * real, el `PermissionsGuard` real y el `ChannelService` real (Prisma mockeado, NUNCA toca
 * DATABASE_URL). Lo único reemplazado es `AuthGuard`, por un stub que deja en el request al
 * usuario ya autenticado — en producción ese guard incluye el candado de #69, que con una sola
 * organización deja pasar al usuario del portal igual que este stub.
 *
 * Ojo con la semántica del guard: `PermissionsGuard` usa `getAllAndOverride`, así que el
 * `@Permissions` del método REEMPLAZA al del controller, no se suma. Por eso las rutas declaran
 * `read:chat` Y `manage:projects` explícitamente, y un caso lo fija.
 */
describe('ChatController — agregar/quitar miembros exige manage:projects (#74 Bloque 0)', () => {
  const ORG_ID = 'org-1';
  /** Canal TICKET del ticket del cliente B. */
  const CHANNEL_ID = 'channel-ticket-cliente-b';
  /** Usuario del portal del cliente A: ajeno a ese ticket. */
  const PORTAL_USER_A = 'user-portal-cliente-a';
  /** Usuario del portal del cliente B: el dueño legítimo de la conversación. */
  const PORTAL_USER_B = 'user-portal-cliente-b';
  const STAFF_USER = 'user-staff';

  /** Permisos reales del rol "Cliente" (ensureClienteRole). */
  const PERMISOS_PORTAL = ['read:projects', 'read:tasks', 'read:chat', 'write:chat'];
  /** Rol "Developer" del seed: chatea, pero no aprueba tareas. */
  const PERMISOS_DEVELOPER = ['read:projects', 'manage:tasks', 'read:sprints', 'read:boards', 'manage:time-entries', 'manage:chat'];
  /** Quien aprueba tareas: manage:projects + chat. */
  const PERMISOS_APROBADOR = ['manage:projects', 'manage:tasks', 'manage:chat'];

  let app: INestApplication;
  let prisma: DeepMockProxy<PrismaService>;
  let usuarioActual: { id: string; permissions: string[] };

  const authStub: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest().user = {
        ...usuarioActual,
        email: `${usuarioActual.id}@test.local`,
        name: usuarioActual.id,
        organizationId: ORG_ID,
        organizationIds: [ORG_ID],
      };
      return true;
    },
  };

  function como(id: string, permissions: string[]) {
    usuarioActual = { id, permissions };
  }

  beforeAll(async () => {
    prisma = mockDeep<PrismaService>();

    const modulo = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        ChannelService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: mockDeep<EventEmitter2>() },
        { provide: MessageService, useValue: mockDeep<MessageService>() },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue(authStub)
      .compile();

    app = modulo.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new GlobalExceptionFilter({ isProduction: false } as AppConfigService));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prisma.channel.findUnique.mockReset();
    prisma.channelMember.findUnique.mockReset();
    prisma.channelMember.create.mockReset();
    prisma.channelMember.delete.mockReset();

    prisma.channel.findUnique.mockResolvedValue({ id: CHANNEL_ID, type: 'TICKET', organizationId: ORG_ID } as never);
  });

  describe('POST /channels/:channelId/members', () => {
    beforeEach(() => {
      prisma.channelMember.findUnique.mockResolvedValue(null as never);
      prisma.channelMember.create.mockResolvedValue({ id: 'cm-nuevo', channelId: CHANNEL_ID, userId: PORTAL_USER_A } as never);
    });

    it('R1.1 — un usuario del portal NO puede agregarse al canal del ticket de otro cliente → 403', async () => {
      como(PORTAL_USER_A, PERMISOS_PORTAL);

      await request(app.getHttpServer())
        .post(`/channels/${CHANNEL_ID}/members`)
        .send({ userId: PORTAL_USER_A })
        .expect(403);

      expect(prisma.channelMember.create).not.toHaveBeenCalled();
    });

    it('R1.2 — staff sin manage:projects (Developer) → 403', async () => {
      como(STAFF_USER, PERMISOS_DEVELOPER);

      await request(app.getHttpServer())
        .post(`/channels/${CHANNEL_ID}/members`)
        .send({ userId: STAFF_USER })
        .expect(403);

      expect(prisma.channelMember.create).not.toHaveBeenCalled();
    });

    it('R1.2 — manage:projects sin ningún permiso de chat → 403 (exige los dos)', async () => {
      como(STAFF_USER, ['manage:projects']);

      await request(app.getHttpServer())
        .post(`/channels/${CHANNEL_ID}/members`)
        .send({ userId: STAFF_USER })
        .expect(403);
    });

    it('R1.2 — staff con manage:projects + chat → 201 y la membresía se crea', async () => {
      como(STAFF_USER, PERMISOS_APROBADOR);

      await request(app.getHttpServer())
        .post(`/channels/${CHANNEL_ID}/members`)
        .send({ userId: STAFF_USER })
        .expect(201);

      expect(prisma.channelMember.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { channelId: CHANNEL_ID, userId: STAFF_USER } }),
      );
    });

    it('declara exactamente read:chat + manage:projects (el del método reemplaza al del controller)', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, ChatController.prototype.addMember)).toEqual([
        'read:chat',
        'manage:projects',
      ]);
    });
  });

  describe('DELETE /channels/:channelId/members/:userId (R1.3 — mismo hueco)', () => {
    beforeEach(() => {
      prisma.channelMember.findUnique.mockResolvedValue({ id: 'cm-b', channelId: CHANNEL_ID, userId: PORTAL_USER_B } as never);
      prisma.channelMember.delete.mockResolvedValue({ id: 'cm-b' } as never);
    });

    it('un usuario del portal NO puede sacar al cliente dueño del canal de su ticket → 403', async () => {
      como(PORTAL_USER_A, PERMISOS_PORTAL);

      await request(app.getHttpServer())
        .delete(`/channels/${CHANNEL_ID}/members/${PORTAL_USER_B}`)
        .expect(403);

      expect(prisma.channelMember.delete).not.toHaveBeenCalled();
    });

    it('staff sin manage:projects (Developer) → 403', async () => {
      como(STAFF_USER, PERMISOS_DEVELOPER);

      await request(app.getHttpServer())
        .delete(`/channels/${CHANNEL_ID}/members/${PORTAL_USER_B}`)
        .expect(403);

      expect(prisma.channelMember.delete).not.toHaveBeenCalled();
    });

    it('staff con manage:projects + chat → 204 y la membresía se borra', async () => {
      como(STAFF_USER, PERMISOS_APROBADOR);

      await request(app.getHttpServer())
        .delete(`/channels/${CHANNEL_ID}/members/${PORTAL_USER_B}`)
        .expect(204);

      expect(prisma.channelMember.delete).toHaveBeenCalledWith({
        where: { channelId_userId: { channelId: CHANNEL_ID, userId: PORTAL_USER_B } },
      });
    });

    it('declara exactamente read:chat + manage:projects', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, ChatController.prototype.removeMember)).toEqual([
        'read:chat',
        'manage:projects',
      ]);
    });
  });
});
