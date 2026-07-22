import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { HoursListener } from '../hours.listener';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';

/**
 * H1 OBJ-3 — cableado del listener time_entry.confirmed → recordHoursUsage.
 * Verifica la conversión seg→min (Math.round(duration/60), hours.listener.ts:53) y las
 * salvaguardas (legacyMigration / duration<=0). NO prueba el descuento (eso es
 * record-hours-usage.spec.ts) — solo el gate.
 */
describe('HoursListener.onTimeEntryConfirmed — H1 cableado seg→min (OBJ-3)', () => {
  let clientService: DeepMockProxy<ClientService>;
  let prisma: DeepMockProxy<PrismaService>;
  let listener: HoursListener;

  beforeEach(() => {
    clientService = mockDeep<ClientService>();
    prisma = mockDeep<PrismaService>();
    listener = new HoursListener(clientService, prisma);
  });

  it('confirma → convierte segundos a minutos y llama recordHoursUsage(taskId, minutos, {clave H2})', async () => {
    await listener.onTimeEntryConfirmed({
      timeEntryId: 'te1',
      taskId: 't1',
      duration: 3600, // 3600 s = 60 min
      legacyMigration: false,
      version: 2, // H2: el ciclo de confirm se forwardea como entry_version
    });

    // H2: además de (taskId, minutos), forwardea la clave de idempotencia del ledger.
    expect(clientService.recordHoursUsage).toHaveBeenCalledWith('t1', 60, {
      timeEntryId: 'te1',
      entryVersion: 2,
    });
  });

  it('evento sin version (compat) → entryVersion cae en el default 1', async () => {
    await listener.onTimeEntryConfirmed({
      timeEntryId: 'te1',
      taskId: 't1',
      duration: 3600,
      legacyMigration: false,
    });

    expect(clientService.recordHoursUsage).toHaveBeenCalledWith('t1', 60, {
      timeEntryId: 'te1',
      entryVersion: 1,
    });
  });

  it('legacyMigration=true → SKIP (no descuenta)', async () => {
    await listener.onTimeEntryConfirmed({
      timeEntryId: 'te1',
      taskId: 't1',
      duration: 3600,
      legacyMigration: true,
    });

    expect(clientService.recordHoursUsage).not.toHaveBeenCalled();
  });

  it('duration<=0 → SKIP (no descuenta)', async () => {
    await listener.onTimeEntryConfirmed({
      timeEntryId: 'te1',
      taskId: 't1',
      duration: 0,
      legacyMigration: false,
    });

    expect(clientService.recordHoursUsage).not.toHaveBeenCalled();
  });
});
