import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { HttpStatus } from '@nestjs/common';
import { ClientController } from '../client.controller';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * H1 OBJ-2 — tombstone 410 de POST /organizations/:orgId/clients/:clientId/hours/sync.
 *
 * El handler syncHours quedó congelado: responde 410 Gone con código HOURS_SYNC_DEPRECATED
 * y NO ejecuta syncMissedHours (KEEP-CODE: el cuerpo sigue en disco pero inalcanzable). Se usa
 * un ClientService REAL con Prisma mockeado para probar que la primera query de syncMissedHours
 * (prisma.task.findMany, client.service.ts:963) NUNCA se dispara — cero horas fantasma posibles.
 *
 * Clon del precedente billing/__tests__/billing-tombstone.spec.ts (feature #27).
 */
describe('ClientController.syncHours — H1 tombstone 410 (OBJ-2)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let controller: ClientController;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    const clientService = new ClientService(
      prisma,
      mockDeep<AuditService>(),
      mockDeep<EmailInvitationService>(),
      mockDeep<OnboardingService>(),
    );
    controller = new ClientController(clientService);
  });

  it('devuelve 410 HOURS_SYNC_DEPRECATED y NO ejecuta syncMissedHours (task.findMany intacto)', () => {
    let thrown: unknown;
    try {
      controller.syncHours();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toMatchObject({
      code: 'HOURS_SYNC_DEPRECATED',
      statusCode: HttpStatus.GONE, // 410
    });
    // KEEP-CODE: la primera query de syncMissedHours (client.service.ts:963) jamás se ejecuta.
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });
});
