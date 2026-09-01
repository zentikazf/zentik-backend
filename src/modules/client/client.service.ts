import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { CreateClientUserDto } from './dto/create-client-user.dto';
import { EditHoursTransactionDto } from './dto/edit-hours-transaction.dto';
import { AppException, DuplicateResourceException } from '../../common/filters/app-exception';
import { PaginatedResult } from '../../common/interfaces/request.interface';
import { AuditService } from '../audit/audit.service';
import { EmailInvitationService } from '../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../auth/onboarding/onboarding.service';

// Buckets de movimiento del ledger de horas (String libre en el schema).
// Filtro opcional de `getHoursSummary`: ausente ⇒ todos los tipos (incl. INTERNAL);
// al elegir un bucket, INTERNAL queda fuera naturalmente por no pertenecer a ninguno.
const MOVEMENT_BUCKETS: Record<string, string[]> = {
  ACUMULADAS: ['PURCHASE', 'REFUND'],
  DESCUENTO: ['USAGE', 'LOAN'],
};

// #56: el techo del ledger y el umbral de aviso viven JUNTOS y el umbral se DERIVA del techo (80%),
// nunca como un segundo literal. El error clasico es dejar el techo en un lado y el umbral en otro:
// alguien sube el techo, se olvida del umbral, y el aviso queda MUERTO justo cuando mas se necesita.
// Si las dos no se mueven juntas, el aviso no sirve.
export const HOURS_SUMMARY_MAX_LIMIT = 500;
export const HOURS_SUMMARY_WARN_THRESHOLD = Math.floor(HOURS_SUMMARY_MAX_LIMIT * 0.8);
// #53: el cap sube de 100 a 500 porque la vista de cards por mes del staff necesita el
// ledger COMPLETO del cliente en una sola respuesta. Agrupar por mes sobre una pagina
// parcial produce totales que MIENTEN: el total de la card seria el de la porcion del mes
// que cayo en esa pagina, no el del mes entero. El cliente mas cargado hoy ronda los 100
// movimientos, asi que 500 da varios anios de margen. Si algun cliente se acerca al techo
// hay que pasar a paginacion por MES (agrupada en SQL), NO subir el numero.

// #57: techo de `page`. El `limit` ya tenia techo (HOURS_SUMMARY_MAX_LIMIT) pero `page` no tenia
// NINGUNO, y `skip = (page - 1) * limit` con un page gigante desborda el entero de 64 bits de
// Postgres: Prisma corta con "Unable to fit value 2e+22 into a 64-bit signed integer for field
// `skip`" ⇒ 500. NO es un problema de parseo del query param —`?page=99999999999999999999` en
// digitos planos ya reventaba antes de que el controller saneara nada—, por eso el techo va ACA:
// cubre a CUALQUIER llamador, venga del borde HTTP, de otro service o de un test.
//
// Por que 100_000: el peor skip posible pasa a ser (100_000 - 1) * HOURS_SUMMARY_MAX_LIMIT ≈ 5e7,
// once ordenes de magnitud por debajo del techo de int64 (~9.2e18) y todavia holgado contra int32.
// El valor se deriva del techo del limit a proposito: si manana alguien sube HOURS_SUMMARY_MAX_LIMIT
// el margen sigue siendo absurdo. En terminos de producto tampoco recorta nada real: el ledger mas
// cargado ronda los 100 movimientos, asi que cualquier pagina mas alla del techo devuelve vacio
// igual — capear solo cambia CUAL pagina vacia se devuelve, no que se pierda informacion.
export const HOURS_SUMMARY_MAX_PAGE = 100_000;

// #57 (cierre): techos del LISTADO DE CLIENTES (`findAll`).
//
// El commit de #57 dijo que el techo de pagina iba en el SERVICE porque "cubre a cualquier
// llamador", pero solo lo puso en `getHoursSummary`. `findAll`, en este MISMO archivo, seguia
// haciendo `page ?? 1` / `limit ?? 50` sin NINGUN techo, con dos 500 reproducibles:
//   - `?page=99999999999999999999` ⇒ skip ≈ 5e21 ⇒ Prisma "Unable to fit value into a 64-bit
//     signed integer for field `skip`" ⇒ HTTP 500.
//   - `?limit=1e21` ⇒ `take` gigante ⇒ el mismo 500. Y `?limit=1000000`, que NO revienta, es
//     peor: devuelve la tabla `client` ENTERA con `_count.projects` + `user` + `users` en una
//     sola respuesta. El saneo del controller no alcanza — `1e21` y los digitos planos son
//     numeros VALIDOS para `parsePaginationParam`, que solo descarta basura sintactica.
//
// Constantes PROPIAS y no las de `getHoursSummary`: aquellas acotan el ledger de horas de UN
// cliente (filas baratas, la pantalla de facturacion necesita el mes completo); estas acotan el
// padron de clientes de la organizacion (filas con includes). Son dos cosas distintas y tienen
// que poder moverse por separado — atarlas hacia que subir el ledger agrandara este payload.
//
// Por que 500 de limit: el front pide `?limit=200` en cinco pantallas (clientes, tickets,
// dashboard, proyectos, miembros), asi que el techo deja margen de sobra y hoy no recorta
// ninguna vista real. Si una organizacion llega a rozarlo, la salida NO es subir el numero: es
// paginar de verdad esas pantallas.
export const CLIENT_LIST_MAX_LIMIT = 500;
// Por que 100_000 de page: el peor skip posible pasa a ser (100_000 - 1) * CLIENT_LIST_MAX_LIMIT
// ≈ 5e7, once ordenes de magnitud por debajo del techo de int64 (~9.2e18). Se deriva del techo del
// limit a proposito, igual que su hermano de horas. No recorta nada real: ninguna organizacion
// tiene 100_000 paginas de clientes, asi que capear solo cambia CUAL pagina vacia se devuelve.
export const CLIENT_LIST_MAX_PAGE = 100_000;

@Injectable()
export class ClientService {
  private readonly logger = new Logger(ClientService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly emailInvitationService: EmailInvitationService,
    private readonly onboardingService: OnboardingService,
  ) {}

  async create(orgId: string, dto: CreateClientDto) {
    const client = await this.prisma.client.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        notes: dto.notes,
        developmentHourlyRate: dto.developmentHourlyRate,
        supportHourlyRate: dto.supportHourlyRate,
        ...(dto.currency && { currency: dto.currency }),
        ...(dto.portalBillingEnabled !== undefined && { portalBillingEnabled: dto.portalBillingEnabled }),
        ...(dto.botmakerAccountId !== undefined && { botmakerAccountId: dto.botmakerAccountId || null }),
        // #63: IVA del cliente. Sin el campo, el cliente nace SIN IVA (columna nullable, sin default).
        ...(dto.taxRate !== undefined && { taxRate: dto.taxRate }),
        ...(dto.taxMode !== undefined && { taxMode: dto.taxMode }),
      },
    });

    this.logger.log(`Client created: ${client.id} in org: ${orgId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.created',
      resource: 'client',
      resourceId: client.id,
      newData: { name: dto.name, email: dto.email },
    });
    return client;
  }

  async findAll(
    orgId: string,
    params: { search?: string; page?: number; limit?: number; status?: string; withUsers?: boolean },
  ): Promise<PaginatedResult<any>> {
    // Techos del listado: ver CLIENT_LIST_MAX_PAGE / CLIENT_LIST_MAX_LIMIT arriba (el porque de
    // cada numero). Sin el techo de `page` el `skip` desborda int64 y Prisma tira 500; sin el de
    // `limit` un `take` gigante hace lo mismo, y uno grande pero valido devuelve el padron entero.
    // Van ACA y no solo en el controller: cubren a cualquier llamador (otro service, un test, un
    // job), y el saneo del borde HTTP deja pasar numeros validos aunque sean absurdos.
    // `Math.max(1, ...)` mantiene el piso: 0 y negativos caen en la pagina 1 / 1 fila.
    const page = Math.min(Math.max(1, params.page ?? 1), CLIENT_LIST_MAX_PAGE);
    const limit = Math.min(Math.max(1, params.limit ?? 50), CLIENT_LIST_MAX_LIMIT);
    const skip = (page - 1) * limit;

    const where: Prisma.ClientWhereInput = { organizationId: orgId };

    if (params.status) {
      where.status = params.status as any;
    }

    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { email: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    // Si withUsers=true, incluir owner + sub-users del cliente para la vista
    // unificada de miembros (Feature #7: rediseno-vista-miembros-organizacion).
    const userInclude = params.withUsers
      ? {
          user: {
            select: {
              id: true, name: true, email: true,
              emailVerified: true, createdAt: true, image: true,
            },
          },
          users: {
            select: {
              id: true, name: true, email: true,
              emailVerified: true, createdAt: true, image: true,
            },
          },
        }
      : {
          user: { select: { email: true } },
        };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.client.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: {
          _count: { select: { projects: true } },
          ...userInclude,
        },
      }),
      this.prisma.client.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findById(orgId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId },
      include: {
        _count: { select: { projects: true, users: true } },
        projects: {
          where: { lifecycleStatus: 'ACTIVE' },
          select: { id: true, name: true, status: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        user: { select: { id: true, name: true, email: true } },
        users: { select: { id: true, name: true, email: true, emailVerified: true, createdAt: true } },
      },
    });

    if (!client) {
      throw new AppException('El cliente no existe', 'CLIENT_NOT_FOUND', 404, { clientId });
    }

    return client;
  }

  async update(orgId: string, clientId: string, dto: UpdateClientDto) {
    const existing = await this.findById(orgId, clientId);

    const client = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.client.update({
        where: { id: clientId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(dto.developmentHourlyRate !== undefined && { developmentHourlyRate: dto.developmentHourlyRate }),
          ...(dto.supportHourlyRate !== undefined && { supportHourlyRate: dto.supportHourlyRate }),
          ...(dto.currency !== undefined && { currency: dto.currency }),
          ...(dto.portalBillingEnabled !== undefined && { portalBillingEnabled: dto.portalBillingEnabled }),
          ...(dto.botmakerAccountId !== undefined && { botmakerAccountId: dto.botmakerAccountId || null }),
          // #63: IVA del cliente. `null` explícito es un valor VÁLIDO —apagar el IVA de un cliente que
          //   lo tenía—, por eso el guard es `!== undefined` y no un truthy: con `dto.taxRate &&` no
          //   habría forma de apagarlo. Cambiar esto NO toca ninguna factura ya emitida: el rate/modo
          //   quedan estampados en cada ciclo (ver `closeCycle`), que es lo que hace que una NC vieja
          //   siga devolviendo el IVA que esa factura cobró.
          ...(dto.taxRate !== undefined && { taxRate: dto.taxRate }),
          ...(dto.taxMode !== undefined && { taxMode: dto.taxMode }),
        },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      // Sync User.name if client has a linked user account
      if (dto.name !== undefined && existing.userId) {
        await tx.user.update({
          where: { id: existing.userId },
          data: { name: dto.name },
        });
      }

      return updated;
    });

    this.logger.log(`Client updated: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.updated',
      resource: 'client',
      resourceId: clientId,
      oldData: { name: existing.name, email: existing.email },
      newData: { name: dto.name, email: dto.email },
    });
    return client;
  }

  async changeStatus(
    orgId: string,
    clientId: string,
    newStatus: 'ACTIVE' | 'DISABLED' | 'ARCHIVED',
    userId: string,
  ) {
    const client = await this.findById(orgId, clientId);

    await this.prisma.$transaction(async (tx) => {
      // Update client status
      await tx.client.update({
        where: { id: clientId },
        data: { status: newStatus },
      });

      if (newStatus === 'DISABLED' || newStatus === 'ARCHIVED') {
        // Collect all user IDs linked to this client
        const userIds: string[] = [];
        if (client.userId) userIds.push(client.userId);

        const subUsers = await tx.user.findMany({
          where: { clientId },
          select: { id: true },
        });
        subUsers.forEach((u) => userIds.push(u.id));

        // Invalidate all sessions immediately
        if (userIds.length > 0) {
          await tx.session.deleteMany({ where: { userId: { in: userIds } } });
        }

        await this.closeOpenTicketsForDisabledClient(tx, clientId, userId);
      }

      if (newStatus === 'ACTIVE') {
        await this.restoreTicketsForReactivatedClient(tx, clientId, userId);
      }
    });

    const actionMap = {
      ACTIVE: 'client.reactivated',
      DISABLED: 'client.disabled',
      ARCHIVED: 'client.archived',
    };

    this.logger.log(`Client ${newStatus}: ${clientId} in org: ${orgId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: actionMap[newStatus],
      resource: 'client',
      resourceId: clientId,
      newData: { status: newStatus, name: client.name },
    });
  }

  /**
   * Cierre honesto de los tickets abiertos al deshabilitar/archivar un cliente
   * (#43 R3). Reemplaza el `updateMany` mudo que pisaba `adminNotes` (destruía
   * notas internas del staff) por un loop transaccional que:
   *  - marca `status=CLOSED` + `closedAt` + `closeNote` + `closedByUserId`, SIN
   *    tocar `adminNotes`;
   *  - escribe un `TicketEvent` STATUS_CHANGE con `fromValue` = estado previo
   *    real y `metadata.reason = 'CLIENT_DISABLED'`. Ese `fromValue` es la
   *    fuente de la restauración de R4, y el `reason` en metadata es el
   *    discriminador (el enum `TicketCloseReason` no tiene `CLIENT_DISABLED` y
   *    el spec manda NO migrarlo — design §D4).
   *
   * Incluye `IN_REVIEW` (tombstone #43) en el barrido para drenarlo también.
   * `closeReason` queda null a propósito: el discriminador vive en el evento,
   * no en el enum; el `closeNote` 'Cliente deshabilitado' es interno (staff-only,
   * en la lista anti-fuga del portal) y da el texto del banner (R3.4).
   */
  private async closeOpenTicketsForDisabledClient(
    tx: Prisma.TransactionClient,
    clientId: string,
    userId: string,
  ) {
    const openTickets = await tx.ticket.findMany({
      where: { clientId, status: { in: ['OPEN', 'IN_PROGRESS', 'IN_REVIEW'] } },
      select: { id: true, status: true },
    });
    const now = new Date();
    for (const t of openTickets) {
      await tx.ticket.update({
        where: { id: t.id },
        data: {
          status: 'CLOSED',
          closedAt: now,
          closeNote: 'Cliente deshabilitado',
          closedByUserId: userId,
          // adminNotes NO se toca — antes se pisaba y destruía notas internas.
        },
      });
      // Molde de TicketEventsService.writeEventTx (ticket-events.service.ts:48):
      // se escribe inline para no acoplar ClientModule → TicketModule.
      await tx.ticketEvent.create({
        data: {
          ticketId: t.id,
          type: 'STATUS_CHANGE',
          fromValue: t.status,
          toValue: 'CLOSED',
          source: 'SYSTEM',
          userId,
          metadata: { reason: 'CLIENT_DISABLED' },
        },
      });
    }
  }

  /**
   * Restauración total al reactivar el cliente (#43 R4): cada ticket que se
   * cerró por CLIENT_DISABLED vuelve a su estado natural (el `fromValue` del
   * último evento de cierre), limpiando los campos del cierre y dejando el
   * `TicketEvent` espejo.
   *
   * DISCRIMINADOR = `closeReason IS NULL` a nivel TICKET. El cierre por
   * deshabilitación (closeOpenTicketsForDisabledClient) es el ÚNICO writer que
   * deja `closeReason` en null; la cancelación manual (closeTicket) SIEMPRE
   * setea un `closeReason` (el DTO lo exige) y un `CLOSED` histórico también lo
   * tiene. Así R4.3 (no tocar manuales ni históricos) sale del `where`, sin
   * depender de la metadata del evento — que era frágil: la cancelación manual
   * escribe un evento `type:'CLOSED'` (no `STATUS_CHANGE`), invisible a la query
   * de discriminación por evento, con lo que un cierre-deshabilitación viejo
   * podía "ganar" y revivir un ticket cancelado a mano. Idempotente (R4.5): tras
   * restaurar, el ticket ya no está `CLOSED` ni con `closeReason` null.
   */
  private async restoreTicketsForReactivatedClient(
    tx: Prisma.TransactionClient,
    clientId: string,
    userId: string,
  ) {
    const closedTickets = await tx.ticket.findMany({
      where: { clientId, status: 'CLOSED', closeReason: null },
      select: { id: true },
    });
    for (const t of closedTickets) {
      // El `fromValue` (estado natural) viene del evento de cierre por
      // deshabilitación — el único STATUS_CHANGE→CLOSED que escribimos.
      const lastClose = await tx.ticketEvent.findFirst({
        where: { ticketId: t.id, type: 'STATUS_CHANGE', toValue: 'CLOSED' },
        orderBy: { createdAt: 'desc' },
        select: { fromValue: true },
      });
      const restoreTo = (lastClose?.fromValue as TicketStatus) ?? 'OPEN';
      await tx.ticket.update({
        where: { id: t.id },
        data: {
          status: restoreTo,
          closedAt: null,
          closeReason: null,
          closeNote: null,
          closedByUserId: null,
        },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId: t.id,
          type: 'STATUS_CHANGE',
          fromValue: 'CLOSED',
          toValue: restoreTo,
          source: 'SYSTEM',
          userId,
          metadata: { reason: 'CLIENT_REACTIVATED' },
        },
      });
    }
  }

  async createClientUser(orgId: string, clientId: string, dto: CreateClientUserDto) {
    const client = await this.findById(orgId, clientId);

    if (client.userId) {
      throw new AppException('Este cliente ya tiene un usuario asignado', 'CLIENT_USER_EXISTS', 400);
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new DuplicateResourceException('usuario', 'email', dto.email);
    }

    // Find or create "Cliente" role for the organization
    const clienteRole = await this.ensureClienteRole(orgId);

    const tempPassword = dto.password || randomBytes(6).toString('base64url');
    const hashedPassword = await bcrypt.hash(tempPassword, 12);
    const emailEnabled = this.emailInvitationService.isEnabled;

    const updatedClient = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          emailVerified: !emailEnabled,
        },
      });

      await tx.account.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: 'credential',
          password: hashedPassword,
        },
      });

      await tx.organizationMember.create({
        data: {
          organizationId: orgId,
          userId: user.id,
          roleId: clienteRole.id,
        },
      });

      const updated = await tx.client.update({
        where: { id: clientId },
        data: { userId: user.id },
        include: {
          user: { select: { id: true, email: true, name: true } },
          _count: { select: { projects: true } },
        },
      });

      return updated;
    });

    this.logger.log(`Client user created: ${updatedClient.userId} for client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.user.created',
      resource: 'client',
      resourceId: clientId,
      newData: { email: dto.email, name: dto.name, userId: updatedClient.userId },
    });

    // Decidir si enviar link de activacion (email) o temp password (UI fallback)
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });

    let activationMode: 'email-sent' | 'temp-password' = 'temp-password';
    if (!dto.password && updatedClient.userId) {
      const result = await this.onboardingService.createActivation({
        userId: updatedClient.userId,
        userName: dto.name,
        userEmail: dto.email.toLowerCase(),
        organizationName: org?.name ?? null,
      });
      activationMode = result.mode;
    }

    if (activationMode === 'temp-password') {
      this.emailInvitationService.sendClientUserEmail({
        email: dto.email.toLowerCase(),
        clientName: dto.name,
        organizationName: org?.name || 'la organizacion',
        temporaryPassword: tempPassword,
      }).catch((err) => {
        this.logger.error(`Failed to send client user email to ${dto.email}`, err);
      });
    }

    return {
      ...updatedClient,
      temporaryPassword: activationMode === 'temp-password' && !dto.password ? tempPassword : undefined,
      activationMode,
    };
  }

  // ── Portal toggle ──────────────────────────────────────

  async togglePortal(orgId: string, clientId: string, enabled: boolean) {
    await this.findById(orgId, clientId);
    const updated = await this.prisma.client.update({
      where: { id: clientId },
      data: { portalEnabled: enabled },
    });
    this.logger.log(`Portal ${enabled ? 'enabled' : 'disabled'} for client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.portal.toggled',
      resource: 'client',
      resourceId: clientId,
      newData: { portalEnabled: enabled },
    });
    return updated;
  }

  // ── Sub-usuarios ──────────────────────────────────────

  async createSubUser(orgId: string, clientId: string, dto: CreateClientUserDto) {
    const client = await this.findById(orgId, clientId);

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existingUser) {
      throw new DuplicateResourceException('usuario', 'email', dto.email);
    }

    const clienteRole = await this.ensureClienteRole(orgId);

    const tempPassword = dto.password || randomBytes(6).toString('base64url');
    const hashedPassword = await bcrypt.hash(tempPassword, 12);
    const emailEnabled = this.emailInvitationService.isEnabled;

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          emailVerified: !emailEnabled,
          mustChangePassword: true,
          clientId: client.id,
        },
      });

      await tx.account.create({
        data: {
          userId: created.id,
          accountId: created.id,
          providerId: 'credential',
          password: hashedPassword,
        },
      });

      await tx.organizationMember.create({
        data: {
          organizationId: orgId,
          userId: created.id,
          roleId: clienteRole.id,
        },
      });

      return created;
    });

    this.logger.log(`Sub-user created: ${user.id} for client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.subuser.created',
      resource: 'client',
      resourceId: clientId,
      newData: { email: dto.email, name: dto.name, userId: user.id },
    });

    // Decidir si enviar link de activacion (email) o temp password (UI fallback)
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });

    let activationMode: 'email-sent' | 'temp-password' = 'temp-password';
    if (!dto.password) {
      const result = await this.onboardingService.createActivation({
        userId: user.id,
        userName: dto.name,
        userEmail: dto.email.toLowerCase(),
        organizationName: org?.name ?? null,
      });
      activationMode = result.mode;
    }

    if (activationMode === 'temp-password') {
      this.emailInvitationService.sendClientSubUserEmail({
        email: dto.email.toLowerCase(),
        userName: dto.name,
        clientName: client.name,
        organizationName: org?.name || 'la organizacion',
        temporaryPassword: tempPassword,
      }).catch((err) => {
        this.logger.error(`Failed to send client sub-user email to ${dto.email}`, err);
      });
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      temporaryPassword: activationMode === 'temp-password' && !dto.password ? tempPassword : undefined,
      activationMode,
    };
  }

  async listSubUsers(clientId: string) {
    return this.prisma.user.findMany({
      where: { clientId },
      select: { id: true, name: true, email: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteSubUser(orgId: string, clientId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, clientId },
    });
    if (!user) {
      throw new AppException('Sub-usuario no encontrado', 'SUB_USER_NOT_FOUND', 404);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.deleteMany({
        where: { userId, organizationId: orgId },
      });
      await tx.account.deleteMany({ where: { userId } });
      await tx.session.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
    });

    this.logger.log(`Sub-user deleted: ${userId} from client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.subuser.deleted',
      resource: 'client',
      resourceId: clientId,
      oldData: { userId, name: user.name, email: user.email },
    });
  }

  async resendActivation(orgId: string, clientId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, clientId },
      select: { id: true, name: true, email: true, emailVerified: true },
    });
    if (!user) {
      throw new AppException('Sub-usuario no encontrado', 'SUB_USER_NOT_FOUND', 404);
    }

    if (user.emailVerified) {
      throw new AppException(
        'Este usuario ya verificó su correo — no hace falta reenviar la activación',
        'USER_ALREADY_VERIFIED',
        409,
      );
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    });

    // Invalidar links de activacion previos sin usar: al reenviar, solo el ultimo
    // email debe funcionar (evita confusion de "cual link uso" y reduce superficie).
    await this.prisma.userActivationToken.deleteMany({
      where: { userId, usedAt: null },
    });

    const result = await this.onboardingService.createActivation({
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      organizationName: org?.name ?? null,
    });

    // createActivation cae a 'temp-password' si Resend esta caido o el envio fallo.
    // Para un reenvio explicito de admin eso es un fallo real: no devolver 200 mintiendo.
    if (result.mode !== 'email-sent') {
      throw new AppException(
        'No se pudo enviar el email de activación. El servicio de correo no está disponible en este momento.',
        'EMAIL_SERVICE_UNAVAILABLE',
        503,
      );
    }

    this.logger.log(`Activation email resent: ${user.email} (client: ${clientId})`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.subuser.activation_resent',
      resource: 'client',
      resourceId: clientId,
      newData: { userId: user.id, email: user.email },
    });

    return { message: 'Email de activación reenviado' };
  }

  // ── Horas contratadas ─────────────────────────────────

  async getHoursSummary(orgId: string, clientId: string, page = 1, limit = 20, movement?: string) {
    const client = await this.findById(orgId, clientId);
    const available = Math.max(client.contractedHours - client.usedHours - client.loanedHours, 0);

    // Techo de pagina: ver HOURS_SUMMARY_MAX_PAGE arriba (comentario de #57 con el porque).
    // Sin este `Math.min` el `skip` de abajo desborda int64 y Prisma tira un 500.
    const safePage = Math.min(Math.max(1, page), HOURS_SUMMARY_MAX_PAGE);
    // Techo del ledger: ver HOURS_SUMMARY_MAX_LIMIT arriba (comentario de #53 con el porque).
    const safeLimit = Math.min(Math.max(1, limit), HOURS_SUMMARY_MAX_LIMIT);
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.HoursTransactionWhereInput = { clientId, deletedAt: null };

    if (movement !== undefined) {
      const bucket = MOVEMENT_BUCKETS[movement];
      if (!bucket) {
        throw new AppException('Filtro de movimiento inválido', 'INVALID_MOVEMENT_FILTER', 400);
      }
      where.type = { in: bucket };
    }

    const [transactions, total, billableAggregate] = await this.prisma.$transaction([
      this.prisma.hoursTransaction.findMany({
        where,
        include: {
          task: { select: { id: true, title: true, type: true, project: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.hoursTransaction.count({ where }),
      this.prisma.hoursTransaction.aggregate({
        // H9b: excluye las filas ESPEJO (rebilledFromTransactionId != null) para NO doble-contar
        // la espejo con su original en el "Total facturable" del cartel del staff.
        where: { ...where, type: { in: ['USAGE', 'LOAN'] }, priceAmount: { not: null }, rebilledFromTransactionId: null },
        _sum: { priceAmount: true },
      }),
    ]);

    // #56: aviso de que el ledger de este cliente se esta acercando al techo. Se emite SOLO al
    // cruzar el umbral: por debajo, silencio absoluto — un warn que aparece siempre deja de leerse.
    // Es REACTIVO a proposito (solo salta cuando alguien pide las horas de ese cliente): un cron
    // que barra todos los clientes seria sobre-ingenieria para el volumen real, y la cobertura
    // practica alcanza porque esta pantalla se abre para facturar y el ledger solo crece cuando
    // alguien carga horas.
    //
    // `total` es el conteo DE ESTA VISTA, no el del cliente: cuando viene `movement` el count lleva
    // el mismo `where.type` que filtra las filas, asi que cuenta solo el bucket elegido. Por eso el
    // texto habla de la vista — decir "el cliente tiene N" hacia que el numero (y el aviso mismo)
    // se moviera al apretar una pildora de filtro, y quien lo leyera concluia que el aviso era un
    // error. NO se agrega un count sin filtro a proposito: seria una query mas en el camino caliente
    // de la pantalla de facturacion, y sin filtro —el estado por defecto— la vista ES el ledger
    // completo, que es el caso en el que este aviso importa.
    if (total > HOURS_SUMMARY_WARN_THRESHOLD) {
      this.logger.warn(
        `Ledger de horas cerca del techo: la vista del cliente ${clientId} ya trae ${total} ` +
          `movimientos (umbral ${HOURS_SUMMARY_WARN_THRESHOLD}, techo ${HOURS_SUMMARY_MAX_LIMIT}). ` +
          `Al llegar al techo la respuesta deja de traer el ledger completo y los totales por mes ` +
          `de la vista del staff vuelven a MENTIR (agrupan en el navegador). ` +
          `La salida correcta NO es subir el techo: hay que paginar por MES agrupando en SQL.`,
      );
    }

    const totalAmount = billableAggregate._sum.priceAmount
      ? parseFloat(billableAggregate._sum.priceAmount.toString())
      : 0;

    return {
      contractedHours: client.contractedHours,
      usedHours: client.usedHours,
      loanedHours: client.loanedHours,
      availableHours: available,
      developmentHourlyRate: client.developmentHourlyRate,
      supportHourlyRate: client.supportHourlyRate,
      currency: client.currency,
      totalAmount,
      transactions,
      transactionsTotal: total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async addHours(orgId: string, clientId: string, hours: number, note?: string) {
    const client = await this.findById(orgId, clientId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.hoursTransaction.create({
        data: {
          clientId,
          type: 'PURCHASE',
          hours,
          note: note || `Carga de ${hours} horas`,
        },
      });

      return tx.client.update({
        where: { id: clientId },
        data: { contractedHours: { increment: hours } },
      });
    });

    this.logger.log(`Added ${hours} hours to client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.hours.purchased',
      resource: 'client',
      resourceId: clientId,
      newData: { hours, note, totalContracted: updated.contractedHours },
    });
    return updated;
  }

  async deleteHoursTransaction(orgId: string, clientId: string, transactionId: string, deletedById: string, reason: string) {
    await this.findById(orgId, clientId);

    const tx = await this.prisma.hoursTransaction.findFirst({
      where: { id: transactionId, clientId, deletedAt: null },
    });

    if (!tx) {
      throw new AppException('Transacción no encontrada', 'TRANSACTION_NOT_FOUND', 404);
    }

    // R9 (#25): un movimiento ya facturado es inmutable. Reabrir el ciclo lo libera.
    // Guard check-then-act (§1.7 fallback aceptado): la ventana close-vs-delete del
    // mismo cliente es ínfima (ambas son acciones manuales del admin).
    if (tx.billedCycleId) {
      throw new AppException(
        'El movimiento ya fue facturado. Reabrí el ciclo para editarlo o eliminarlo.',
        'TRANSACTION_BILLED',
        409,
        { transactionId, billedCycleId: tx.billedCycleId },
      );
    }

    // #54: la fila ESPEJO de una nota de crédito (rebilledFromTransactionId != null) SÍ se puede
    // borrar, pero su delete es ASIMÉTRICO respecto de todos los demás tipos: NO revierte cupo.
    //
    // Por qué se permite: no existe flujo para "corregir el origen". No hay endpoint de anulación
    // ni de borrado de NC, el modelo CreditNote no tiene status/cancelledAt, reabrir el ciclo con
    // NCs tira CYCLE_HAS_CREDIT_NOTES y reemitir choca LINE_ALREADY_CREDITED por el @unique de
    // creditedTransactionId. Como `returnHoursToBillable` es el DEFAULT, una espejo emitida por
    // error quedaría inmutable, indeleteable y sin salida. Borrarla no desincroniza nada: el
    // CreditNoteLine congelado sigue intacto; esto es literalmente "deshacer la devolución de
    // horas al pool facturable", una acción legítima del admin.
    //
    // Por qué SIN reversa de contadores: la espejo nació "NO toca cupo"
    // (client-billing.service.ts) — nunca incrementó usedHours/loanedHours. Correr el decrement
    // de más abajo le regalaría ese cupo al cliente, que es exactamente el bug que #54 vino a
    // matar. El EDIT sí sigue prohibido (ver editHoursTransaction): ahí el problema es distinto
    // (dato derivado que se desincroniza del original), y borrar la fila es la salida.
    if (tx.rebilledFromTransactionId) {
      await this.prisma.hoursTransaction.update({
        where: { id: transactionId },
        data: { deletedAt: new Date(), deletedById, deleteReason: reason },
      });

      const deletedByMirror = await this.prisma.user.findUnique({
        where: { id: deletedById },
        select: { name: true, email: true },
      });

      this.logger.log(
        `Hours transaction ${transactionId} (fila espejo de NC) deleted by ${deletedByMirror?.email} — ` +
          `reason: ${reason} — cupo NO revertido (la espejo nunca lo movió)`,
      );
      await this.auditService.create({
        organizationId: orgId,
        action: 'client.hours.deleted',
        resource: 'client',
        resourceId: clientId,
        oldData: {
          transactionId,
          type: tx.type,
          hours: tx.hours,
          note: tx.note,
          rebilledFromTransactionId: tx.rebilledFromTransactionId,
        },
        newData: {
          deletedBy: deletedByMirror?.name,
          reason,
          mirrorRow: true,
          quotaReverted: false,
        },
      });
      return;
    }

    // ── #65 T7 (B2.2) — un REFUND no se borra a mano ────────────────────────────────────────
    //
    // Un REFUND no es un movimiento que alguien cargue: lo fabrica `hours.listener` cuando se
    // revierte una carga de tiempo, y nace ATADO a dos efectos que el borrado no puede deshacer
    // solo. Al crearse (hours.listener.ts:116-152) el listener hace TRES cosas en una
    // transacción: inserta el REFUND, TOMBSTONEA el cargo original, y baja `usedHours` o
    // `loanedHours` según el tipo de ese cargo.
    //
    // Borrar el REFUND deshace UNA de las tres. Las otras dos quedan como estaban: el cargo
    // original sigue tombstoneado —o sea fuera del pool facturable para siempre, porque no
    // existe endpoint que lo reviva— y el cupo sigue devuelto. Por eso la decisión del dueño es
    // prohibirlo en vez de intentar una reversa parcial que deja el ledger a medio camino.
    //
    // Los dos casos llevan código propio a propósito: dicen cosas distintas y se arreglan
    // distinto.
    if (tx.type === 'REFUND') {
      if (tx.reversesTransactionId) {
        throw new AppException(
          'Un REFUND lo genera el sistema al revertir una carga y no se elimina a mano. Si la ' +
            'reversión fue un error, volvé a aprobar o a cargar el tiempo en la tarea: eso emite ' +
            'un cargo nuevo y limpio.',
          'REFUND_NOT_DELETABLE',
          409,
          { transactionId, reversesTransactionId: tx.reversesTransactionId },
        );
      }
      // Sin `reversesTransactionId` (REFUND legacy, anterior a H9a) no hay forma de saber si el
      // cargo que revirtió era USAGE o LOAN, así que tampoco hay forma de saber qué contador
      // tocaría el borrado. Fallar explícito es la única salida honesta: adivinar acá es
      // exactamente el bug que este bloque vino a matar, sólo que en el otro contador (B2.1).
      throw new AppException(
        'Este REFUND es anterior al registro de reversas y no se puede eliminar: no hay forma de ' +
          'saber qué cargo revirtió, y por lo tanto qué horas habría que devolver.',
        'REFUND_ORPHAN_NOT_DELETABLE',
        409,
        { transactionId },
      );
    }

    await this.prisma.$transaction(async (prisma) => {
      // Soft-delete the transaction
      await prisma.hoursTransaction.update({
        where: { id: transactionId },
        data: { deletedAt: new Date(), deletedById, deleteReason: reason },
      });

      // ── #65 T9 (B3) — reversa de contadores, un caso por CADA type del enum ────────────────
      //
      // Antes era una cadena `if/else if` sin cierre, y ahí vivía el bug: la rama REFUND
      // decrementaba `contractedHours`, un contador que crear un REFUND NUNCA incrementó
      // (hours.listener.ts:142-152 sólo baja usedHours/loanedHours). Le restaba al cliente horas
      // COMPRADAS, en la misma dirección que la creación en vez de revertirla. La causa probable
      // está en client.service.ts:19, donde el filtro de la UI agrupa `ACUMULADAS: ['PURCHASE',
      // 'REFUND']`: alguien leyó "el REFUND suma cupo, como un PURCHASE" y copió su reversa.
      //
      // La tabla que queda fija, verificada contra los 5 únicos sitios de creación del repo:
      //
      //   type      | al CREAR mueve                            | al BORRAR
      //   ----------|-------------------------------------------|--------------------------------
      //   PURCHASE  | contractedHours +h   (addHours :833)      | contractedHours −h
      //   USAGE     | usedHours       +h   (recordHours :1257)  | usedHours       −h
      //   LOAN      | loanedHours     +h   (recordHours :1252)  | loanedHours     −h
      //   REFUND    | usedHours|loanedHours −h  (listener :145) | PROHIBIDO (guard de arriba)
      //   INTERNAL  | NADA                 (recordHours :1179)  | NADA
      //
      // INTERNAL no tiene rama porque es CORRECTO que no la tenga, no porque falte: su creación
      // no toca ningún contador (es tiempo no facturable, se registra sólo para trazabilidad),
      // así que la reversa de un contador que nunca movió sería regalarle cupo al cliente. Va
      // como `case` vacío y explícito para que se lea como decisión y no como olvido — que es
      // justo la ambigüedad que dejó pasar el bug del REFUND.
      //
      // El `default` es el candado: `type` es un String libre en el schema, no un enum de
      // Postgres (schema.prisma:1571). Si mañana alguien agrega un tipo nuevo y se olvida de
      // esta tabla, hoy caería en el else implícito y se soft-detearía EN SILENCIO, dejando los
      // contadores desincronizados sin que nadie se entere. Ahora falla ruidoso y la transacción
      // se revierte entera.
      switch (tx.type) {
        case 'PURCHASE':
          await prisma.client.update({
            where: { id: clientId },
            data: { contractedHours: { decrement: tx.hours } },
          });
          break;

        case 'USAGE':
          await prisma.client.update({
            where: { id: clientId },
            data: { usedHours: { decrement: tx.hours } },
          });
          break;

        case 'LOAN':
          await prisma.client.update({
            where: { id: clientId },
            data: { loanedHours: { decrement: tx.hours } },
          });
          break;

        case 'INTERNAL':
          // Nació sin mover contadores. Se borra sin moverlos. Simétrico.
          break;

        case 'REFUND':
          // Inalcanzable: el guard de arriba corta antes. Queda como fail-safe por si alguien
          // lo saca — no tocar nada es siempre menos dañino que tocar el contador equivocado.
          throw new AppException(
            'Un REFUND no se elimina a mano.',
            'REFUND_NOT_DELETABLE',
            409,
            { transactionId },
          );

        default:
          throw new AppException(
            `Tipo de movimiento desconocido: no se sabe qué contador revertir (${tx.type}).`,
            'UNKNOWN_TRANSACTION_TYPE',
            500,
            { transactionId, type: tx.type },
          );
      }
    });

    const deletedByUser = await this.prisma.user.findUnique({
      where: { id: deletedById },
      select: { name: true, email: true },
    });

    this.logger.log(`Hours transaction ${transactionId} deleted by ${deletedByUser?.email} — reason: ${reason}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.hours.deleted',
      resource: 'client',
      resourceId: clientId,
      oldData: { transactionId, type: tx.type, hours: tx.hours, note: tx.note },
      newData: { deletedBy: deletedByUser?.name, reason },
    });
  }

  async editHoursTransaction(
    orgId: string,
    clientId: string,
    transactionId: string,
    dto: EditHoursTransactionDto,
    editedById: string,
  ) {
    const client = await this.findById(orgId, clientId);

    const tx = await this.prisma.hoursTransaction.findFirst({
      where: { id: transactionId, clientId, deletedAt: null },
    });

    if (!tx) {
      throw new AppException(
        'Transaccion no encontrada o ya eliminada',
        'TRANSACTION_NOT_FOUND',
        404,
      );
    }

    // R9 (#25): un movimiento ya facturado es inmutable (horas/tarifa congeladas en el
    // snapshot del ciclo). Reabrir el ciclo lo libera. Guard check-then-act (§1.7 fallback).
    if (tx.billedCycleId) {
      throw new AppException(
        'El movimiento ya fue facturado. Reabrí el ciclo para editarlo.',
        'TRANSACTION_BILLED',
        409,
        { transactionId, billedCycleId: tx.billedCycleId },
      );
    }

    // #54: la fila ESPEJO de una nota de crédito (rebilledFromTransactionId != null) es
    // inmutable. Va ANTES del guard de `type` a propósito: la espejo copia el type del original
    // (USAGE/LOAN), así que ese guard la dejaría pasar. Es una COPIA derivada congelada al emitir
    // la NC y nació SIN mover el cupo; editarla aplicaría el `increment` del delta sobre un
    // contador que nunca tocó (sube "Consumidas" con horas que nadie trabajó) y la desincroniza
    // del original. La salida es ELIMINAR la fila (deleteHoursTransaction la borra sin tocar cupo):
    // no existe flujo de anulación ni de reemisión de NC, así que el mensaje no puede prometerlo.
    if (tx.rebilledFromTransactionId) {
      throw new AppException(
        'La fila espejo de una nota de crédito no se edita: es una copia derivada del movimiento original. Si la devolución de horas fue un error, eliminá la fila.',
        'MIRROR_ROW_READONLY',
        409,
        { transactionId, rebilledFromTransactionId: tx.rebilledFromTransactionId },
      );
    }

    // Solo USAGE y LOAN son editables (afectan cupo del cliente).
    // PURCHASE/REFUND/INTERNAL no son consumo facturable y no se editan.
    if (tx.type !== 'USAGE' && tx.type !== 'LOAN') {
      throw new AppException(
        'Solo se pueden editar transacciones de uso (USAGE) o prestamo (LOAN)',
        'TRANSACTION_NOT_EDITABLE',
        400,
        { type: tx.type },
      );
    }

    if (dto.hours === undefined && dto.priceRate === undefined) {
      throw new AppException(
        'Debes enviar al menos un campo a editar (hours o priceRate)',
        'NOTHING_TO_EDIT',
        400,
      );
    }

    // Calcular nuevos valores. priceRate=null/0 limpia la tarifa.
    const newHours = dto.hours ?? tx.hours;
    const newRate: number | null =
      dto.priceRate !== undefined
        ? (dto.priceRate ?? 0) > 0
          ? Number(dto.priceRate)
          : null
        : tx.priceRate
        ? parseFloat(tx.priceRate.toString())
        : null;
    const newAmount =
      newRate !== null && newRate > 0
        ? parseFloat((newHours * newRate).toFixed(2))
        : null;
    // Currency: preservar la original si ya existia. Si la tx nunca tuvo
    // currency y ahora se agrega tarifa por primera vez, usar la moneda
    // actual del cliente.
    const newCurrency = tx.priceCurrency
      ? tx.priceCurrency
      : newAmount !== null
      ? client.currency
      : null;

    const delta = newHours - tx.hours;

    const oldData = {
      hours: tx.hours,
      priceAmount: tx.priceAmount ? parseFloat(tx.priceAmount.toString()) : null,
      priceRate: tx.priceRate ? parseFloat(tx.priceRate.toString()) : null,
      priceCurrency: tx.priceCurrency,
    };

    await this.prisma.$transaction(async (prisma) => {
      await prisma.hoursTransaction.update({
        where: { id: transactionId },
        data: {
          hours: newHours,
          priceAmount: newAmount,
          priceRate: newRate,
          priceCurrency: newCurrency,
        },
      });

      // Ajustar cupo del cliente segun el delta de horas. USAGE->usedHours,
      // LOAN->loanedHours. Si delta=0, no hace nada.
      if (delta !== 0) {
        const counterField: 'usedHours' | 'loanedHours' =
          tx.type === 'USAGE' ? 'usedHours' : 'loanedHours';
        await prisma.client.update({
          where: { id: clientId },
          data: { [counterField]: { increment: delta } },
        });
      }
    });

    const editedByUser = await this.prisma.user.findUnique({
      where: { id: editedById },
      select: { name: true, email: true },
    });

    this.logger.log(
      `Hours transaction ${transactionId} edited by ${editedByUser?.email} — ` +
        `hours: ${tx.hours} -> ${newHours}, rate: ${oldData.priceRate} -> ${newRate}, ` +
        `amount: ${oldData.priceAmount} -> ${newAmount}`,
    );

    await this.auditService.create({
      organizationId: orgId,
      action: 'client.hours.edited',
      resource: 'client',
      resourceId: clientId,
      oldData: { transactionId, type: tx.type, ...oldData },
      newData: {
        editedBy: editedByUser?.name,
        hours: newHours,
        priceAmount: newAmount,
        priceRate: newRate,
        priceCurrency: newCurrency,
      },
    });

    return { success: true, transactionId };
  }

  async recordHoursUsage(
    taskId: string,
    durationMinutes: number,
    opts?: { timeEntryId?: string; entryVersion?: number; workedOn?: Date | string | null },
  ) {
    // H2: clave de idempotencia del ledger. El único parcial (time_entry_id, entry_version) impide
    // que un MISMO time_entry.confirmed cree dos cobros (doble evento, retry de job, doble click).
    // Es opcional: el caller inalcanzable syncMissedHours no la pasa → esas filas quedan fuera del índice.
    const timeEntryId = opts?.timeEntryId ?? null;
    const entryVersion = opts?.entryVersion ?? null;
    // H8a: día trabajado del caller; si no viene, fallback a "ahora" (coincide con createdAt @default(now())).
    // Materializa la invariante "toda fila billable tiene workedOn" sin reintroducir el `?? createdAt` distribuido.
    // @db.Date ignora la hora → queda date-only del día PG.
    const workedOn = opts?.workedOn ? new Date(opts.workedOn) : new Date();
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        type: true,
        billable: true,
        hourlyRate: true, // Override por tarea (Fase Precio Hora)
        project: {
          select: { id: true, name: true, clientId: true, organizationId: true },
        },
      },
    });

    if (!task?.project?.clientId) {
      this.logger.warn(`recordHoursUsage: Task ${taskId} — project ${task?.project?.id} (${task?.project?.name}) has no clientId. Cannot deduct hours.`);
      return;
    }

    // H1 OBJ-1 (candado de emergencia): SOLO las tareas SUPPORT descuentan el cupo del cliente.
    // Las tareas PROJECT NO crean ninguna HoursTransaction (ni USAGE/LOAN ni INTERNAL), no tocan
    // usedHours/loanedHours y no dejan rastro en el libro mayor por ahora. El valor/tarifa de las
    // horas de proyecto se persistirá en el TimeEntry en H4; por eso la rama developmentHourlyRate
    // (más abajo) queda VIVA como gancho futuro, pero acá cortamos ANTES de llegar a ella.
    // El descuento de SUPPORT se dispara desde HoursListener al recibir time_entry.confirmed.
    if (task.type === 'PROJECT') {
      this.logger.log(`recordHoursUsage: task ${taskId} es PROJECT — H1 OBJ-1: no consume cupo, sin transacción. Skip.`);
      return;
    }

    const clientId = task.project.clientId;
    const hours = parseFloat((durationMinutes / 60).toFixed(4));

    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return;

    // Tarea no facturable (trabajo interno): registramos la transaccion como INTERNAL
    // para trazabilidad, pero NO incrementamos usedHours ni guardamos precio.
    if (!task.billable) {
      try {
        await this.prisma.hoursTransaction.create({
          data: {
            clientId,
            type: 'INTERNAL',
            hours,
            taskId,
            note: `Tiempo interno (no facturable): ${task.title}`,
            timeEntryId,
            entryVersion,
            workedOn, // H8a
          },
        });
      } catch (e) {
        // H2: mismo time_entry.confirmed disparado dos veces → el único parcial lo rebota. Idempotente.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          this.logger.log(`recordHoursUsage: INTERNAL idempotente (timeEntry ${timeEntryId} v${entryVersion} ya registrado). Skip.`);
          return;
        }
        throw e;
      }
      this.logger.log(`Recorded ${hours}h INTERNAL (no descuenta) for task ${taskId}, client ${clientId}`);
      await this.auditService.create({
        organizationId: task.project.organizationId,
        action: 'client.hours.internal',
        resource: 'client',
        resourceId: clientId,
        newData: { hours, taskId, taskTitle: task.title },
      });
      return;
    }

    // Resolver tarifa snapshot (Fase Precio Hora):
    // Prioridad: task.hourlyRate (override) → client.{type}HourlyRate
    // Si no hay tarifa configurada, priceAmount queda null (transacción sin precio).
    const resolvedRate = (() => {
      if (task.hourlyRate) return parseFloat(task.hourlyRate.toString());
      if (task.type === 'SUPPORT' && client.supportHourlyRate) {
        return parseFloat(client.supportHourlyRate.toString());
      }
      // H1: tras el guard PROJECT (arriba) TS estrecha task.type a 'SUPPORT', pero dejamos esta
      // rama VIVA como gancho de H4 (tarifa de proyecto en el TimeEntry). Cast puntual a string para
      // no romper el narrowing sin usar `any`; comportamiento idéntico (rama inalcanzable para SUPPORT).
      if ((task.type as string) === 'PROJECT' && client.developmentHourlyRate) {
        return parseFloat(client.developmentHourlyRate.toString());
      }
      return null;
    })();

    const priceAmount = resolvedRate !== null
      ? parseFloat((hours * resolvedRate).toFixed(2))
      : null;

    const available = client.contractedHours - client.usedHours;
    const isLoan = available <= 0;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.hoursTransaction.create({
          data: {
            clientId,
            type: isLoan ? 'LOAN' : 'USAGE',
            hours,
            taskId,
            note: `Tiempo registrado en: ${task.title}`,
            priceAmount,
            priceRate: resolvedRate,
            priceCurrency: priceAmount !== null ? client.currency : null,
            timeEntryId,
            entryVersion,
            workedOn, // H8a: esta fila JAMÁS puede quedar con workedOn null (es lo que H8b factura)
          },
        });

        if (isLoan) {
          await tx.client.update({
            where: { id: clientId },
            data: { loanedHours: { increment: hours } },
          });
        } else {
          await tx.client.update({
            where: { id: clientId },
            data: { usedHours: { increment: hours } },
          });
        }
      });
    } catch (e) {
      // H2: idempotencia. Si el único parcial (time_entry_id, entry_version) rebota el insert (P2002),
      // toda la $transaction hace rollback (no crea la 2da transacción NI incrementa el contador).
      // Es el mismo time_entry.confirmed disparado dos veces → doble cobro evitado.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        this.logger.log(`recordHoursUsage: USAGE/LOAN idempotente (timeEntry ${timeEntryId} v${entryVersion} ya cobrado). Skip.`);
        return;
      }
      throw e;
    }

    this.logger.log(
      `Recorded ${hours}h ${isLoan ? '(loan)' : '(usage)'} for client ${clientId} ` +
      `[rate: ${resolvedRate ?? 'null'}, amount: ${priceAmount ?? 'null'} ${client.currency}]`,
    );

    await this.auditService.create({
      organizationId: task.project.organizationId,
      action: isLoan ? 'client.hours.loaned' : 'client.hours.consumed',
      resource: 'client',
      resourceId: clientId,
      newData: {
        hours,
        priceAmount,
        priceRate: resolvedRate,
        taskId,
        taskTitle: task.title,
        type: isLoan ? 'LOAN' : 'USAGE',
      },
    });
  }

  /**
   * Find SUPPORT tasks in DONE status that were never recorded as hour usage
   * and process them. Fixes tasks that were completed before the event emit was added.
   */
  async syncMissedHours(orgId: string, clientId: string) {
    const client = await this.findById(orgId, clientId);

    // Find all DONE SUPPORT tasks for this client's projects that don't have a corresponding USAGE/LOAN transaction
    const tasks = await this.prisma.task.findMany({
      where: {
        status: 'DONE',
        type: 'SUPPORT',
        project: {
          clientId,
          organizationId: orgId,
        },
      },
      select: {
        id: true,
        title: true,
        estimatedHours: true,
        createdAt: true,
      },
    });

    const existingTxns = await this.prisma.hoursTransaction.findMany({
      where: {
        clientId,
        type: { in: ['USAGE', 'LOAN'] },
        taskId: { in: tasks.map((t) => t.id) },
      },
      select: { taskId: true },
    });

    const processedTaskIds = new Set(existingTxns.map((t) => t.taskId));
    const missed = tasks.filter((t) => !processedTaskIds.has(t.id));

    let synced = 0;
    for (const task of missed) {
      const minutes = task.estimatedHours
        ? task.estimatedHours * 60
        : Math.round((Date.now() - new Date(task.createdAt).getTime()) / 60000);

      if (minutes > 0) {
        await this.recordHoursUsage(task.id, minutes);
        synced++;
        this.logger.log(`Synced missed hours: ${(minutes / 60).toFixed(2)}h for task ${task.id} (${task.title})`);
      }
    }

    return { total: tasks.length, alreadyProcessed: processedTaskIds.size, synced };
  }

  /**
   * Get available hours for a client linked to a project.
   * Returns null if the project has no client.
   */
  async getAvailableHoursByProject(projectId: string): Promise<{ clientId: string; clientName: string; availableHours: number; contractedHours: number; usedHours: number; loanedHours: number } | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { clientId: true },
    });
    if (!project?.clientId) return null;

    const client = await this.prisma.client.findUnique({
      where: { id: project.clientId },
      select: { id: true, name: true, contractedHours: true, usedHours: true, loanedHours: true },
    });
    if (!client) return null;

    return {
      clientId: client.id,
      clientName: client.name,
      availableHours: Math.max(client.contractedHours - client.usedHours - client.loanedHours, 0),
      contractedHours: client.contractedHours,
      usedHours: client.usedHours,
      loanedHours: client.loanedHours,
    };
  }

  // ── Helpers ──────────────────────────────────────────

  /**
   * Find or create the "Cliente" role for an organization and ensure
   * it always has the required permissions (read:projects, read:tasks, read:chat, write:chat).
   */
  async ensureClienteRole(orgId: string) {
    let clienteRole = await this.prisma.role.findFirst({
      where: { organizationId: orgId, name: 'Cliente' },
    });

    if (!clienteRole) {
      clienteRole = await this.prisma.role.create({
        data: {
          organizationId: orgId,
          name: 'Cliente',
          description: 'Cliente externo con acceso al portal',
          isSystem: true,
          isDefault: false,
        },
      });
      this.logger.log(`Created "Cliente" role for org: ${orgId}`);
    }

    // Ensure chat permissions exist globally
    await this.prisma.permission.upsert({
      where: { action_resource: { action: 'read', resource: 'chat' } },
      update: {},
      create: { action: 'read', resource: 'chat', description: 'Read chat' },
    });
    await this.prisma.permission.upsert({
      where: { action_resource: { action: 'write', resource: 'chat' } },
      update: {},
      create: { action: 'write', resource: 'chat', description: 'Write chat' },
    });

    // Ensure all required permissions are assigned to the role
    const requiredPermissions = await this.prisma.permission.findMany({
      where: {
        OR: [
          { action: 'read', resource: 'projects' },
          { action: 'read', resource: 'tasks' },
          { action: 'read', resource: 'chat' },
          { action: 'write', resource: 'chat' },
        ],
      },
    });

    if (requiredPermissions.length > 0) {
      await this.prisma.rolePermission.createMany({
        data: requiredPermissions.map((p) => ({
          roleId: clienteRole.id,
          permissionId: p.id,
        })),
        skipDuplicates: true,
      });
    }

    return clienteRole;
  }
}
