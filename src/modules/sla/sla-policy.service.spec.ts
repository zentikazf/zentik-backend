import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { SlaPolicyService } from './sla-policy.service';

/**
 * Tests del guard `SLA_POLICY_IN_USE` (`deactivate`).
 *
 * Prisma MOCKEADO. Este service no tenía cobertura: el archivo nace con #58
 * porque la decisión 8 del dueño le suma un cuarto contador y romperlo no da
 * ningún síntoma visible — la política se apaga y los paquetes quedan podridos
 * hasta que alguien intente aplicarlos.
 */
describe('SlaPolicyService — deactivate: guard SLA_POLICY_IN_USE', () => {
  let service: SlaPolicyService;
  let prisma: DeepMockProxy<PrismaService>;

  const ORG = 'org-1';
  const POLICY = 'pol-1';
  const USER = 'user-1';

  /** Los 4 contadores del guard, todos en cero salvo lo que pida el test. */
  function counts({
    contracts = 0,
    projects = 0,
    clients = 0,
    packageItems = 0,
  }: { contracts?: number; projects?: number; clients?: number; packageItems?: number } = {}) {
    prisma.projectTicketTypeSla.count.mockResolvedValue(contracts as never);
    prisma.project.count.mockResolvedValue(projects as never);
    prisma.client.count.mockResolvedValue(clients as never);
    prisma.contractPackageItem.count.mockResolvedValue(packageItems as never);
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new SlaPolicyService(prisma, mockDeep<EventEmitter2>());

    prisma.slaPolicy.findFirst.mockResolvedValue({
      id: POLICY,
      organizationId: ORG,
      name: 'Estándar 4h',
      isActive: true,
    } as never);
    prisma.slaPolicy.update.mockResolvedValue({ id: POLICY, isActive: false } as never);
  });

  it('sin referencias, la desactiva', async () => {
    counts();

    await service.deactivate(ORG, POLICY, USER);

    expect(prisma.slaPolicy.update).toHaveBeenCalledWith({
      where: { id: POLICY },
      data: { isActive: false },
    });
  });

  /**
   * La decisión 8 del dueño. Sin este contador, dar de baja una política PUDRE
   * en silencio todos los paquetes que la usan: sus ítems no resuelven ningún
   * ticket, así que no hay ningún síntoma hasta el día que alguien aplica el
   * paquete y ve "2 ítems omitidos".
   */
  it('un ítem de paquete ACTIVO bloquea la baja', async () => {
    counts({ packageItems: 2 });

    await expect(service.deactivate(ORG, POLICY, USER)).rejects.toMatchObject({
      code: 'SLA_POLICY_IN_USE',
      statusCode: 409,
      details: { contracts: 0, projects: 0, clients: 0, packageItems: 2 },
    });
    expect(prisma.slaPolicy.update).not.toHaveBeenCalled();
  });

  it('el mensaje del 409 nombra los ítems de paquete (el front lo renderiza como string plano)', async () => {
    counts({ contracts: 1, packageItems: 3 });

    await expect(service.deactivate(ORG, POLICY, USER)).rejects.toMatchObject({
      message: expect.stringContaining('3 ítem(s) de paquete'),
    });
  });

  /**
   * Un paquete archivado no se puede aplicar, así que no tiene por qué frenar la
   * limpieza del catálogo de políticas. El filtro va en el `where` del count.
   */
  it('solo cuenta ítems de paquetes ACTIVOS y de ESTA organización', async () => {
    counts();

    await service.deactivate(ORG, POLICY, USER);

    expect(prisma.contractPackageItem.count).toHaveBeenCalledWith({
      where: { slaPolicyId: POLICY, package: { organizationId: ORG, isActive: true } },
    });
  });

  it('sigue bloqueando por contrato activo, proyecto y cliente', async () => {
    for (const scenario of [{ contracts: 1 }, { projects: 1 }, { clients: 1 }]) {
      counts(scenario);
      await expect(service.deactivate(ORG, POLICY, USER)).rejects.toMatchObject({
        code: 'SLA_POLICY_IN_USE',
      });
    }
  });
});
