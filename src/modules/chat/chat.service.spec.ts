import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { MessageService } from './chat.service';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { OutboxService } from '../sync/outbox.service';
import { AppException } from '../../common/filters/app-exception';
import { SendMessageDto } from './dto/send-message.dto';

/**
 * Stub de `$transaction` en modo callback: ejecuta el callback con `tx` y
 * devuelve su resultado. `onCommit` corre cuando el callback ya resolvió — o sea,
 * el punto en el que Postgres commiteó y `create` sigue con el post-commit.
 *
 * Los casts son puntuales y documentados: `$transaction` está sobrecargado
 * (array | callback) y TS tipa la implementación contra la firma del array.
 */
function stubTransaction(
  prisma: DeepMockProxy<PrismaService>,
  tx: unknown,
  onCommit?: () => void,
): void {
  (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (cb: unknown) => {
    const out = await (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(
      tx as Prisma.TransactionClient,
    );
    onCommit?.();
    return out;
  });
}

/**
 * Tests del gate read-only de chat en tickets RESOLVED (feature #11, R1).
 *
 * Cuando un ticket queda RESOLVED (terminal), el chat del canal asociado queda
 * read-only PARA EL CLIENTE (`User.clientId !== null`): `MessageService.create`
 * rechaza con `AppException` 403 código `TICKET_RESOLVED_READ_ONLY`. El staff
 * (`clientId === null`) y los tickets en cualquier otro estado pasan sin cambios.
 *
 * El gate vive en `MessageService.create`, único punto por el que entran tanto el
 * POST HTTP (`/chat/channels/:id/messages`) como el WS (`message:send`).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod).
 */
describe('MessageService — gate read-only chat en ticket RESOLVED (feature #11, R1)', () => {
  let service: MessageService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let storage: DeepMockProxy<StorageService>;
  let outbox: DeepMockProxy<OutboxService>;

  const CHANNEL_ID = 'channel-1';
  const CLIENT_USER_ID = 'user-client-1';
  const STAFF_USER_ID = 'user-staff-1';
  const CLIENT_ID = 'client-1';
  const CREATED_MESSAGE_ID = 'message-created-1';

  const dto: SendMessageDto = { content: 'Hola' };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    storage = mockDeep<StorageService>();
    // OutboxService: 4º parametro del constructor desde #50 D5 (encolado del
    // mensaje como comentario de OSD). Mockeado — nada de esto toca la red.
    outbox = mockDeep<OutboxService>();

    service = new MessageService(prisma, eventEmitter, storage, outbox);

    // ── Stubs del camino feliz (cuando el gate NO bloquea) ──────────
    prisma.message.create.mockResolvedValue({
      id: CREATED_MESSAGE_ID,
      content: dto.content,
      channelId: CHANNEL_ID,
      user: { id: STAFF_USER_ID, name: 'Staff', email: 's@x.com', image: null, clientId: null },
      files: [],
    } as never);
    prisma.channel.update.mockResolvedValue({ id: CHANNEL_ID } as never);
    // `create` usa `$transaction` SOLO cuando hay fila de outbox que atomizar (ver
    // el bloque del FIX 5 al final del archivo); estos casos son de canal con
    // ticket sin categoría de soporte, así que van por el camino suelto. El stub
    // queda igual para que el spec no dependa de por cuál de los dos caminos entra:
    // ejecuta el callback con el PROPIO mock de prisma como `tx`, y así las
    // aserciones sobre `prisma.message.create` valen en los dos.
    stubTransaction(prisma, prisma);
  });

  /** Configura el sender (clientId) y el status del ticket del canal. */
  function arrange(senderClientId: string | null, ticketStatus: string | null) {
    // Por defecto el sender ES miembro del canal: el membership gate (feature #18)
    // corre ANTES del gate RESOLVED. Estos tests verifican el gate RESOLVED, asi que
    // necesitan pasar la barrera de membership. El caso "no miembro" se cubre aparte
    // en chat-membership.spec.ts.
    prisma.channelMember.findFirst.mockResolvedValue({ id: 'member-1' } as never);
    prisma.user.findUnique.mockResolvedValue(
      (senderClientId === undefined ? null : { clientId: senderClientId }) as never,
    );
    prisma.channel.findUnique.mockResolvedValue(
      (ticketStatus === null ? { ticket: null } : { ticket: { status: ticketStatus } }) as never,
    );
  }

  it('(a) cliente + ticket RESOLVED → lanza AppException TICKET_RESOLVED_READ_ONLY (403)', async () => {
    arrange(CLIENT_ID, 'RESOLVED');

    await expect(service.create(CHANNEL_ID, CLIENT_USER_ID, dto)).rejects.toMatchObject({
      code: 'TICKET_RESOLVED_READ_ONLY',
      statusCode: 403,
    });
    await expect(service.create(CHANNEL_ID, CLIENT_USER_ID, dto)).rejects.toBeInstanceOf(AppException);

    // No se creó el mensaje: el gate cortó antes.
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('(b) staff (clientId null) + ticket RESOLVED → permite enviar (no throw)', async () => {
    arrange(null, 'RESOLVED');

    await expect(service.create(CHANNEL_ID, STAFF_USER_ID, dto)).resolves.toBeDefined();
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
  });

  it('(c) cliente + ticket IN_PROGRESS → permite enviar (no throw)', async () => {
    arrange(CLIENT_ID, 'IN_PROGRESS');

    await expect(service.create(CHANNEL_ID, CLIENT_USER_ID, dto)).resolves.toBeDefined();
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * Encolado del mensaje de chat al outbox de OSD (#50 T4 · R2.1/R2.2 · D5).
 *
 * `MessageService.create` es el UNICO punto de entrada del chat (WS `message:send`
 * + POST REST), asi que aca se cubren los dos transportes de una sola vez. Lo que
 * se verifica:
 *
 * - La fila del outbox nace DENTRO de la misma `$transaction` que el mensaje (R2.1):
 *   `enqueueTx` recibe el `tx`, no `this.prisma` → si la tx revierte, la fila se va
 *   con ella (garantia nativa de Prisma, no hay compensacion que testear).
 * - El gate de encolado es `channel.ticket && ticket.category === 'SUPPORT_REQUEST'`:
 *   un canal sin ticket (DM / grupo / proyecto) o un ticket fuera del scope de la
 *   integracion no encolan NADA.
 * - `notifyEnqueued()` (drain-on-enqueue, R4.3) se dispara POST-COMMIT y solo si
 *   `enqueueTx` devolvio `true` (escribio fila de verdad; `false` = no-op por
 *   flag/whitelist, no hay a quien avisar).
 *
 * Prisma y OutboxService MOCKEADOS — NUNCA tocan DATABASE_URL (prod) ni OSD.
 */
describe('MessageService.create — encolado del chat al outbox OSD (#50 R2.1/R2.2)', () => {
  let service: MessageService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let storage: DeepMockProxy<StorageService>;
  let outbox: DeepMockProxy<OutboxService>;

  const CHANNEL_ID = 'channel-1';
  const STAFF_USER_ID = 'user-staff-1';
  const TICKET_ID = 'ticket-1';
  const ORG_ID = 'org-1';
  const CREATED_MESSAGE_ID = 'message-created-1';

  const dto: SendMessageDto = { content: 'Hola, ¿alguna novedad?' };

  /** Ticket sincronizable "de manual": soporte, org habilitada. */
  const TICKET_SOPORTE = {
    id: TICKET_ID,
    status: 'IN_PROGRESS',
    category: 'SUPPORT_REQUEST',
    organizationId: ORG_ID,
  };

  /** Configura qué devuelve el `channel.findUnique` del gate (ticket o null). */
  function arrangeChannel(ticket: Record<string, unknown> | null) {
    prisma.channel.findUnique.mockResolvedValue({ ticket } as never);
  }

  /** Primer argumento con el que se llamó `enqueueTx` (el `tx` de la transacción). */
  function enqueueTxArg(): unknown {
    return outbox.enqueueTx.mock.calls[0][0];
  }

  /** Input con el que se llamó `enqueueTx` (eventType + payload + scoping). */
  function enqueueInput() {
    return outbox.enqueueTx.mock.calls[0][1];
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    storage = mockDeep<StorageService>();
    outbox = mockDeep<OutboxService>();

    service = new MessageService(prisma, eventEmitter, storage, outbox);

    // El sender es miembro y es staff: los gates previos (membership #18 /
    // read-only #11) no son lo que se testea acá, tienen sus propios specs.
    prisma.channelMember.findFirst.mockResolvedValue({ id: 'member-1' } as never);
    prisma.user.findUnique.mockResolvedValue({ clientId: null } as never);
    prisma.message.create.mockResolvedValue({
      id: CREATED_MESSAGE_ID,
      content: dto.content,
      channelId: CHANNEL_ID,
      user: { id: STAFF_USER_ID, name: 'Staff', email: 's@x.com', image: null, clientId: null },
      files: [],
    } as never);
    prisma.channel.update.mockResolvedValue({ id: CHANNEL_ID } as never);
    stubTransaction(prisma, prisma);

    // Default: `enqueueTx` SÍ escribió fila (flag + whitelist habilitados). El
    // no-op (`false`) se fuerza en el test que lo necesita.
    outbox.enqueueTx.mockResolvedValue(true);
  });

  it('canal de un ticket SUPPORT_REQUEST → encola COMMENT_ADDED con { ticketId, messageId }', async () => {
    arrangeChannel(TICKET_SOPORTE);

    await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
    expect(enqueueInput()).toEqual({
      eventType: 'COMMENT_ADDED',
      // `aggregateId` = ticket.id: es la clave con la que el dispatcher busca el
      // `externalId` del TICKET_CREATED para el gate de orden (R2.4).
      aggregateId: TICKET_ID,
      // `organizationId` alimenta el gate de whitelist DENTRO de enqueueTx.
      organizationId: ORG_ID,
      payload: { ticketId: TICKET_ID, messageId: CREATED_MESSAGE_ID },
    });
  });

  it('el payload del chat NO lleva snapshot: el dispatcher RELEE el mensaje (R2.2)', async () => {
    arrangeChannel(TICKET_SOPORTE);

    await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    // El discriminante de `processComment` es `adminNoteSnapshot !== undefined`
    // (D1): si el chat lo mandara, el mensaje viajaría como nota INTERNA. Además
    // el contenido no se congela acá — un mensaje borrado antes del drain se
    // skipea, no se reenvía texto fantasma.
    const payload = enqueueInput().payload;
    expect(payload).not.toHaveProperty('adminNoteSnapshot');
    expect(payload).not.toHaveProperty('authorUserId');
    expect(payload).not.toHaveProperty('content');
  });

  it('canal SIN ticket (DM / grupo / proyecto) → NO encola nada', async () => {
    arrangeChannel(null);

    await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    // El mensaje se crea igual: el chat interno no depende de la integración.
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(outbox.enqueueTx).not.toHaveBeenCalled();
    expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
  });

  it('canal de un ticket que NO es SUPPORT_REQUEST → NO encola (mismo gate que ticket/portal)', async () => {
    arrangeChannel({ ...TICKET_SOPORTE, category: 'NEW_DEVELOPMENT' });

    await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(outbox.enqueueTx).not.toHaveBeenCalled();
    expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
  });

  it('enqueueTx = true → notifyEnqueued se llama DESPUES del commit (R4.3)', async () => {
    arrangeChannel(TICKET_SOPORTE);

    // El orden importa: disparar el drain adentro de la tx podría hacer que el
    // dispatcher lea una fila que todavía no commiteó (o que nunca commitee).
    const orden: string[] = [];
    stubTransaction(prisma, prisma, () => orden.push('commit'));
    outbox.notifyEnqueued.mockImplementation(() => {
      orden.push('notify');
    });

    await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    expect(outbox.notifyEnqueued).toHaveBeenCalledTimes(1);
    expect(orden).toEqual(['commit', 'notify']);
  });

  it('enqueueTx = false (no-op por flag/whitelist) → NO llama notifyEnqueued', async () => {
    arrangeChannel(TICKET_SOPORTE);
    outbox.enqueueTx.mockResolvedValue(false);

    await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    // Se intentó encolar (el gate de categoría pasó) pero no hay fila: avisar del
    // drenado sería trabajo al pedo para el dispatcher.
    expect(outbox.enqueueTx).toHaveBeenCalledTimes(1);
    expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
  });

  it('enqueueTx recibe el `tx` de la transacción, NUNCA this.prisma (R2.1: el rollback se lleva la fila)', async () => {
    arrangeChannel(TICKET_SOPORTE);

    // Acá el `tx` NO es el mock de prisma: es un cliente de transacción propio, así
    // que la identidad del objeto distingue "escribí dentro de la tx" de "escribí
    // por afuera". Si `enqueueTx` recibiera `this.prisma`, la fila sobreviviría al
    // rollback y OSD recibiría el comentario de un mensaje que no existe.
    const tx = mockDeep<Prisma.TransactionClient>();
    tx.message.create.mockResolvedValue({
      id: CREATED_MESSAGE_ID,
      content: dto.content,
      channelId: CHANNEL_ID,
      user: { id: STAFF_USER_ID, name: 'Staff', email: 's@x.com', image: null, clientId: null },
      files: [],
    } as never);
    tx.channel.update.mockResolvedValue({ id: CHANNEL_ID } as never);
    stubTransaction(prisma, tx);

    await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    expect(enqueueTxArg()).toBe(tx);
    expect(enqueueTxArg()).not.toBe(prisma);
    // Y el mensaje también se escribió por el tx, no por el cliente de afuera.
    expect(tx.message.create).toHaveBeenCalledTimes(1);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('si la tx revienta → no se avisa el drenado y el error propaga', async () => {
    arrangeChannel(TICKET_SOPORTE);
    // Postgres revirtió: Prisma rechaza la promesa de `$transaction` y `create`
    // nunca llega al `notifyEnqueued` de abajo (está post-commit, no en un finally).
    prisma.$transaction.mockRejectedValue(new Error('rollback') as never);

    await expect(service.create(CHANNEL_ID, STAFF_USER_ID, dto)).rejects.toThrow('rollback');

    expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});

/**
 * Alcance de la transacción de `MessageService.create` (revisión adversarial de
 * #50 — FIX 5).
 *
 * El primer pase de #50 envolvió SIEMPRE las 4 escrituras del mensaje en una
 * `$transaction`, incluso cuando no había NADA que encolar. Eso metía un modo de
 * falla nuevo (P2024/P2028 con los defaults de Prisma: maxWait 2s / timeout 5s)
 * en el path caliente del chat para la enorme mayoría de los mensajes del
 * producto — DMs, grupos, canales de proyecto, tickets fuera de SUPPORT_REQUEST —
 * donde antes de #50 las queries iban sueltas y el mensaje se guardaba igual. El
 * costo era que el usuario comía un 500 y PERDÍA el mensaje entero por rollback,
 * sin ninguna atomicidad que ganar a cambio.
 *
 * Lo que fija este bloque:
 * - Sin fila de outbox que atomizar → NO hay `$transaction` (el camino vuelve a
 *   ser el de antes de #50: la regla del dueño de probar el camino VIEJO).
 * - Con fila que atomizar → SÍ hay `$transaction`, y con `maxWait`/`timeout`
 *   EXPLÍCITOS y holgados, no los defaults que causaban el problema.
 * - La extracción del privado `writeMessage` no perdió ninguna de las 4
 *   escrituras en el camino suelto (link de archivos + touch del canal).
 * - Los dos gates previos (membership #18 / read-only #11) siguen cortando ANTES
 *   de escribir en AMBOS caminos.
 *
 * Prisma y OutboxService MOCKEADOS — NUNCA tocan DATABASE_URL (prod) ni OSD.
 */
describe('MessageService.create — la tx se abre SOLO si hay algo que encolar (FIX 5)', () => {
  let service: MessageService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let storage: DeepMockProxy<StorageService>;
  let outbox: DeepMockProxy<OutboxService>;

  const CHANNEL_ID = 'channel-1';
  const STAFF_USER_ID = 'user-staff-1';
  const CLIENT_USER_ID = 'user-client-1';
  const TICKET_ID = 'ticket-1';
  const ORG_ID = 'org-1';
  const CREATED_MESSAGE_ID = 'message-created-1';

  const dto: SendMessageDto = { content: 'Hola' };

  /** Ticket sincronizable: soporte → es el ÚNICO caso que abre transacción. */
  const TICKET_SOPORTE = {
    id: TICKET_ID,
    status: 'IN_PROGRESS',
    category: 'SUPPORT_REQUEST',
    organizationId: ORG_ID,
  };

  /** Ticket fuera del scope de la integración → NO abre transacción. */
  const TICKET_NO_SOPORTE = { ...TICKET_SOPORTE, category: 'NEW_DEVELOPMENT' };

  function arrangeChannel(ticket: Record<string, unknown> | null) {
    prisma.channel.findUnique.mockResolvedValue({ ticket } as never);
  }

  /** Mensaje "de manual" que devuelven `message.create` / `message.findUnique`. */
  function fakeMessage(files: unknown[] = []) {
    return {
      id: CREATED_MESSAGE_ID,
      content: dto.content,
      channelId: CHANNEL_ID,
      user: { id: STAFF_USER_ID, name: 'Staff', email: 's@x.com', image: null, clientId: null },
      files,
    } as never;
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    storage = mockDeep<StorageService>();
    outbox = mockDeep<OutboxService>();

    service = new MessageService(prisma, eventEmitter, storage, outbox);

    // Gates previos en verde: miembro del canal + staff. Lo que se testea acá es
    // el ALCANCE de la tx, no los gates (tienen sus propios bloques más arriba y
    // su no-regresión al final de éste).
    prisma.channelMember.findFirst.mockResolvedValue({ id: 'member-1' } as never);
    prisma.user.findUnique.mockResolvedValue({ clientId: null } as never);
    prisma.message.create.mockResolvedValue(fakeMessage());
    prisma.channel.update.mockResolvedValue({ id: CHANNEL_ID } as never);
    outbox.enqueueTx.mockResolvedValue(true);

    // OJO — el stub de `$transaction` queda ARMADO a propósito en los tests que
    // afirman que NO se usa: así, el código PRE-FIX (que envolvía siempre) pasaría
    // el camino feliz sin romperse, y lo único que falla es la aserción
    // `not.toHaveBeenCalled()`. El test apunta al defecto, no a un crash colateral.
    stubTransaction(prisma, prisma);
  });

  it('canal SIN ticket (DM / grupo / proyecto) → NO abre transacción, y el mensaje se crea igual', async () => {
    arrangeChannel(null);

    const result = await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    // El resultado observable es el de siempre: mensaje enriquecido + evento.
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: CREATED_MESSAGE_ID, senderType: 'team' });
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'message.sent',
      expect.objectContaining({ messageId: CREATED_MESSAGE_ID, channelId: CHANNEL_ID }),
    );
  });

  it('canal de un ticket que NO es SUPPORT_REQUEST → tampoco abre transacción', async () => {
    arrangeChannel(TICKET_NO_SOPORTE);

    const result = await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: CREATED_MESSAGE_ID });
  });

  it('canal de un ticket SUPPORT_REQUEST → SÍ abre transacción, con maxWait/timeout EXPLÍCITOS', async () => {
    arrangeChannel(TICKET_SOPORTE);

    await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Los defaults de Prisma (maxWait 2s / timeout 5s) son justo lo que hacía
    // perder el mensaje bajo pico de chat o pool chico en Railway: en el único
    // camino que SIGUE pagando transacción, los límites van explícitos y holgados.
    const [, options] = (prisma.$transaction as unknown as jest.Mock).mock.calls[0];
    expect(options).toEqual({ maxWait: 5_000, timeout: 15_000 });
  });

  it('camino SIN tx → sigue vinculando los fileIds y tocando channel.updatedAt (nada se perdió al extraer writeMessage)', async () => {
    arrangeChannel(null);
    const FILE_IDS = ['file-1', 'file-2'];
    // Con fileIds hay re-fetch: `writeMessage` relee el mensaje ya con los archivos.
    prisma.message.findUnique.mockResolvedValue(fakeMessage([{ id: 'file-1', key: 'k1' }]));

    await service.create(CHANNEL_ID, STAFF_USER_ID, { ...dto, fileIds: FILE_IDS });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    // Link de archivos: el `where` conserva el candado de ownership + no-reasignación.
    expect(prisma.file.updateMany).toHaveBeenCalledWith({
      where: { id: { in: FILE_IDS }, uploadedById: STAFF_USER_ID, messageId: null },
      data: { messageId: CREATED_MESSAGE_ID },
    });
    // Re-fetch para devolver el mensaje ya con los archivos vinculados.
    expect(prisma.message.findUnique).toHaveBeenCalledTimes(1);
    // Touch del canal: sin esto el canal se hunde en el orden por `updatedAt`.
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: CHANNEL_ID },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it('camino SIN tx → no encola ni avisa el drenado (no hay integración que alimentar)', async () => {
    arrangeChannel(null);

    await service.create(CHANNEL_ID, STAFF_USER_ID, dto);

    // Las tres aserciones son una sola idea: si no hay nada que encolar, no hay
    // fila, no hay drenado que avisar — y por lo tanto tampoco hay motivo para
    // pagar una transacción. La primera es la que distingue este camino del otro.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(outbox.enqueueTx).not.toHaveBeenCalled();
    expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
  });

  // ── No-regresión de los gates previos en AMBOS caminos ──────────────

  it('gate de membership corta ANTES de escribir, tanto en el camino con tx como en el suelto', async () => {
    prisma.channelMember.findFirst.mockResolvedValue(null as never);

    for (const ticket of [null, TICKET_SOPORTE]) {
      arrangeChannel(ticket);

      await expect(service.create(CHANNEL_ID, STAFF_USER_ID, dto)).rejects.toMatchObject({
        code: 'CHANNEL_FORBIDDEN',
        statusCode: 403,
      });
    }

    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(outbox.enqueueTx).not.toHaveBeenCalled();
  });

  it('gate read-only corta ANTES de escribir, tanto en el camino con tx como en el suelto', async () => {
    // Cliente (clientId !== null) + ticket RESOLVED: el chat es de sólo lectura.
    prisma.user.findUnique.mockResolvedValue({ clientId: 'client-1' } as never);

    for (const ticket of [
      { ...TICKET_NO_SOPORTE, status: 'RESOLVED' },
      { ...TICKET_SOPORTE, status: 'RESOLVED' },
    ]) {
      arrangeChannel(ticket);

      await expect(service.create(CHANNEL_ID, CLIENT_USER_ID, dto)).rejects.toMatchObject({
        code: 'TICKET_RESOLVED_READ_ONLY',
        statusCode: 403,
      });
    }

    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(outbox.enqueueTx).not.toHaveBeenCalled();
  });
});
