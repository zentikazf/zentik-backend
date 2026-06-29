import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Server } from 'socket.io';
import { TicketsGateway } from './tickets.gateway';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { SessionValidityService } from '../auth/session-validity.service';

/**
 * Tests del listener de invalidacion de badge de aprobaciones (#20).
 *
 * Cubre R2 (accion ajena → senal fina por-org):
 * - `task.approval.requested/.approved/.rejected` → emit `approvals:updated`
 *   { orgId } a `org:${orgId}` (copia del shape de los emit de ticket).
 * - Guard `!organizationId`: si falta la org, NO emite (evita broadcast global).
 * - Gate de `task.moved`: solo emite cuando el movimiento toca IN_REVIEW (entra
 *   o sale), nunca en cada drag.
 *
 * Prisma + AppConfigService + SessionValidityService MOCKEADOS — NUNCA tocan
 * DATABASE_URL (prod). El emit no toca DB; solo verifica el contrato WS.
 */
describe('TicketsGateway — invalidacion de badge de aprobaciones (#20)', () => {
  const ORG_ID = 'org-1';

  let prisma: DeepMockProxy<PrismaService>;
  let config: DeepMockProxy<AppConfigService>;
  let sessionValidity: DeepMockProxy<SessionValidityService>;
  let gateway: TicketsGateway;
  let emit: jest.Mock;
  let to: jest.Mock;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    config = mockDeep<AppConfigService>();
    sessionValidity = mockDeep<SessionValidityService>();

    gateway = new TicketsGateway(prisma, config, sessionValidity);

    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    gateway.server = { to } as unknown as Server;
  });

  describe('task.approval.* → approvals:updated', () => {
    it('approval.requested → emite approvals:updated { orgId } a org:${orgId}', () => {
      gateway.emitApprovalsUpdatedFromApproval({ organizationId: ORG_ID });

      expect(to).toHaveBeenCalledWith(`org:${ORG_ID}`);
      expect(emit).toHaveBeenCalledWith('approvals:updated', { orgId: ORG_ID });
    });

    it('approval.approved/.rejected reusan el mismo handler → mismo emit', () => {
      // El mismo metodo cablea los 3 @OnEvent; basta verificar el contrato 1 vez
      // mas con un orgId distinto para confirmar que usa el payload, no un literal.
      gateway.emitApprovalsUpdatedFromApproval({ organizationId: 'org-2' });

      expect(to).toHaveBeenCalledWith('org:org-2');
      expect(emit).toHaveBeenCalledWith('approvals:updated', { orgId: 'org-2' });
    });

    it('sin organizationId → NO emite (no broadcast global)', () => {
      gateway.emitApprovalsUpdatedFromApproval({});

      expect(to).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('task.moved → gate de IN_REVIEW', () => {
    it('entra a IN_REVIEW (newStatus) → emite', () => {
      gateway.emitApprovalsUpdatedFromMove({
        organizationId: ORG_ID,
        previousStatus: 'IN_PROGRESS',
        newStatus: 'IN_REVIEW',
      });

      expect(to).toHaveBeenCalledWith(`org:${ORG_ID}`);
      expect(emit).toHaveBeenCalledWith('approvals:updated', { orgId: ORG_ID });
    });

    it('sale de IN_REVIEW (previousStatus) → emite', () => {
      gateway.emitApprovalsUpdatedFromMove({
        organizationId: ORG_ID,
        previousStatus: 'IN_REVIEW',
        newStatus: 'DONE',
      });

      expect(emit).toHaveBeenCalledWith('approvals:updated', { orgId: ORG_ID });
    });

    it('movimiento que NO toca IN_REVIEW → NO emite (no refetch en cada drag)', () => {
      gateway.emitApprovalsUpdatedFromMove({
        organizationId: ORG_ID,
        previousStatus: 'TODO',
        newStatus: 'IN_PROGRESS',
      });

      expect(to).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('sin organizationId → NO emite aunque toque IN_REVIEW', () => {
      gateway.emitApprovalsUpdatedFromMove({
        previousStatus: 'IN_PROGRESS',
        newStatus: 'IN_REVIEW',
      });

      expect(to).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
