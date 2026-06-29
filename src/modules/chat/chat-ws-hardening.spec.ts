import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { ChatGateway } from './chat.gateway';
import { MessageService } from './chat.service';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { SessionValidityService } from '../auth/session-validity.service';

/**
 * Tests del hardening WS P1 del gateway /chat (#19).
 *
 * Cubre:
 * - ALTO-2: assertLiveSession rechaza message:send con sesion revocada; el
 *   @Interval desconecta sockets no-vivos emitiendo session:expired.
 * - MEDIO-2: handleTyping usa la identidad del SOCKET (no del payload) y descarta
 *   typing en canales no joineados (gate client.rooms.has).
 * - BAJO-2: rejectAuth emite auth:error con el code correcto ANTES de disconnect.
 *
 * Prisma + SessionValidityService MOCKEADOS — NUNCA tocan DATABASE_URL (prod).
 */
describe('Chat — WS hardening P1 (#19)', () => {
  const CHANNEL_ID = 'channel-1';
  const USER_ID = 'user-1';
  const SESSION_ID = 'sess-1';

  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let storage: DeepMockProxy<StorageService>;
  let sessionValidity: DeepMockProxy<SessionValidityService>;
  let messageService: MessageService;
  let gateway: ChatGateway;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    storage = mockDeep<StorageService>();
    sessionValidity = mockDeep<SessionValidityService>();

    messageService = new MessageService(prisma, eventEmitter, storage);
    gateway = new ChatGateway(messageService, prisma, sessionValidity);
  });

  /** Stub de Socket local con los campos que tocan los handlers. */
  function makeClient(overrides: Partial<Record<string, unknown>> = {}): Socket {
    return {
      id: 'sock-1',
      userId: USER_ID,
      userName: 'Alice',
      data: { sessionId: SESSION_ID },
      emit: jest.fn(),
      disconnect: jest.fn(),
      to: jest.fn(),
      rooms: new Set<string>(),
      ...overrides,
    } as unknown as Socket;
  }

  // ── ALTO-2: assertLiveSession en message:send ───────────────────────

  describe('ALTO-2 — assertLiveSession (message:send)', () => {
    it('sesion revocada → rechaza, emite session:expired + disconnect, NO crea mensaje', async () => {
      sessionValidity.isSessionLive.mockResolvedValue(false);
      const createSpy = jest.spyOn(messageService, 'create');
      const client = makeClient();

      const result = await gateway.handleMessage(client, {
        channelId: CHANNEL_ID,
        content: 'hola',
      });

      expect(result).toEqual({ success: false, error: 'Sesión expirada' });
      expect(client.emit).toHaveBeenCalledWith('session:expired');
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('sesion viva → no corta (sigue al flujo normal de create)', async () => {
      sessionValidity.isSessionLive.mockResolvedValue(true);
      const createSpy = jest
        .spyOn(messageService, 'create')
        .mockResolvedValue({ id: 'msg-1' } as never);
      const client = makeClient();

      const result = await gateway.handleMessage(client, {
        channelId: CHANNEL_ID,
        content: 'hola',
      });

      expect(client.emit).not.toHaveBeenCalledWith('session:expired');
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, data: { id: 'msg-1' } });
    });
  });

  // ── ALTO-2: heartbeat @Interval ─────────────────────────────────────

  describe('ALTO-2 — revalidateSessions (@Interval)', () => {
    it('desconecta el socket no-vivo y emite session:expired; deja vivo al vivo', async () => {
      const dead = {
        id: 'sock-dead',
        data: { sessionId: 'sess-dead' },
        emit: jest.fn(),
        disconnect: jest.fn(),
      };
      const alive = {
        id: 'sock-alive',
        data: { sessionId: 'sess-alive' },
        emit: jest.fn(),
        disconnect: jest.fn(),
      };
      const server = {
        fetchSockets: jest.fn().mockResolvedValue([dead, alive]),
      } as unknown as Server;
      gateway.server = server;

      sessionValidity.isSessionLive.mockImplementation(async (id: string) =>
        id === 'sess-alive',
      );

      await gateway.revalidateSessions();

      expect(dead.emit).toHaveBeenCalledWith('session:expired');
      expect(dead.disconnect).toHaveBeenCalledWith(true);
      expect(alive.emit).not.toHaveBeenCalled();
      expect(alive.disconnect).not.toHaveBeenCalled();
    });

    it('un fallo global del ciclo no propaga (try/catch, no mata el proceso)', async () => {
      const server = {
        fetchSockets: jest.fn().mockRejectedValue(new Error('adapter down')),
      } as unknown as Server;
      gateway.server = server;

      await expect(gateway.revalidateSessions()).resolves.toBeUndefined();
    });
  });

  // ── MEDIO-2: handleTyping no-spoofeable ─────────────────────────────

  describe('MEDIO-2 — handleTyping (no-spoofeable)', () => {
    it('usa la identidad del SOCKET, ignora userId/userName del payload', async () => {
      const emit = jest.fn();
      const to = jest.fn().mockReturnValue({ emit });
      const client = makeClient({ to, rooms: new Set([CHANNEL_ID]) });

      // payload spoofeado: el cliente intenta hacerse pasar por otro user
      await gateway.handleTyping(client, {
        channelId: CHANNEL_ID,
        userId: 'attacker-id',
        userName: 'Mallory',
      } as never);

      expect(to).toHaveBeenCalledWith(CHANNEL_ID);
      expect(emit).toHaveBeenCalledWith('message:typing', {
        userId: USER_ID,
        userName: 'Alice',
        channelId: CHANNEL_ID,
      });
    });

    it('typing en canal NO joineado (rooms no lo contiene) → se descarta, no reemite', async () => {
      const emit = jest.fn();
      const to = jest.fn().mockReturnValue({ emit });
      const client = makeClient({ to, rooms: new Set<string>() });

      await gateway.handleTyping(client, { channelId: CHANNEL_ID });

      expect(to).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('sin channelId → se descarta', async () => {
      const emit = jest.fn();
      const to = jest.fn().mockReturnValue({ emit });
      const client = makeClient({ to, rooms: new Set([CHANNEL_ID]) });

      await gateway.handleTyping(client, {} as never);

      expect(to).not.toHaveBeenCalled();
    });
  });

  // ── BAJO-2: rejectAuth ──────────────────────────────────────────────

  describe('BAJO-2 — rejectAuth (handleConnection)', () => {
    it('sin token → emite auth:error NO_TOKEN antes de disconnect(true)', async () => {
      const client = {
        id: 'sock-x',
        handshake: { auth: {}, headers: {} },
        emit: jest.fn(),
        disconnect: jest.fn(),
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleConnection(client);

      expect(client.emit).toHaveBeenCalledWith('auth:error', { code: 'NO_TOKEN' });
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('session invalida → emite auth:error INVALID_SESSION antes de disconnect(true)', async () => {
      prisma.session.findFirst.mockResolvedValue(null as never);
      const client = {
        id: 'sock-y',
        handshake: { auth: { token: 'tok' }, headers: {} },
        emit: jest.fn(),
        disconnect: jest.fn(),
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleConnection(client);

      expect(client.emit).toHaveBeenCalledWith('auth:error', { code: 'INVALID_SESSION' });
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('excepcion de DB en el handshake → emite auth:error SERVER_ERROR antes de disconnect(true)', async () => {
      prisma.session.findFirst.mockRejectedValue(new Error('db down') as never);
      const client = {
        id: 'sock-z',
        handshake: { auth: { token: 'tok' }, headers: {} },
        emit: jest.fn(),
        disconnect: jest.fn(),
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleConnection(client);

      expect(client.emit).toHaveBeenCalledWith('auth:error', { code: 'SERVER_ERROR' });
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });
  });
});
