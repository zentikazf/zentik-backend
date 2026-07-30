import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { BotmakerBillingService } from '../botmaker-billing.service';
import { BotmakerClientService } from '../botmaker-client.service';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { AppConfigService } from '../../../config/app.config';
import { BotmakerConsumptionsResponse } from '../types/botmaker.types';

/**
 * #23 — Normalización del payload REAL de Botmaker + cache. Prisma/HTTP/Redis MOCKEADOS (nunca tocan prod).
 * Foco: arrays multi-moneda en balance/totalSpend + productId REPETIDO (se suma usage + totalSpend).
 */
describe('BotmakerBillingService (#23)', () => {
  let client: DeepMockProxy<BotmakerClientService>;
  let redis: DeepMockProxy<RedisService>;
  let prisma: DeepMockProxy<PrismaService>;

  const ORG = 'org-1';
  const PERIOD = '2026-04';

  // Payload realista: cuenta madre + 1 sub-cuenta; SESSIONS repetido 3 veces (array + número + array).
  const payload: BotmakerConsumptionsResponse = {
    accountId: 'MOTHER',
    accountName: 'Agencia',
    balance: [{ total: 1000, currency: 'USD' }],
    totalSpend: [{ total: 500, currency: 'USD' }],
    productUsage: [],
    accounts: [
      {
        accountId: 'IC0XXEN8LOZW38EW2XP2',
        accountName: 'fortaleza',
        accountAlias: 'Fortaleza Inmuebles',
        totalSpend: [{ total: 200, currency: 'USD' }],
        productUsage: [
          { productId: 'SESSIONS', usage: 100, totalSpend: [{ total: 10, currency: 'USD' }] },
          { productId: 'SESSIONS', usage: 50, totalSpend: 5 },
          { productId: 'SESSIONS', usage: 25, totalSpend: [{ total: 2.5, currency: 'USD' }] },
          { productId: 'FEE', usage: 1, totalSpend: 100 },
          // Payload REAL: totalSpend como OBJETO único { total, currency } (el que hacía dar 0).
          { productId: 'MESSAGES', usage: 500, totalSpend: { total: 42, currency: 'USD' } },
          { productId: 'ZERO', usage: 999, totalSpend: 0 },
        ],
      },
    ],
  };

  function makeService(enabled: boolean): BotmakerBillingService {
    const config = { botmakerBillingEnabled: enabled, botmakerCacheTtlSec: 1800 } as unknown as AppConfigService;
    return new BotmakerBillingService(client, redis, config, prisma);
  }

  beforeEach(() => {
    client = mockDeep<BotmakerClientService>();
    redis = mockDeep<RedisService>();
    prisma = mockDeep<PrismaService>();
    client.fetchConsumptions.mockResolvedValue(payload);
    redis.get.mockResolvedValue(null as never); // cache miss → fetch
    redis.set.mockResolvedValue('OK' as never);
    prisma.client.findMany.mockResolvedValue([] as never); // sin mapeos previos
  });

  it('lista cuentas (madre + sub) ordenadas por gasto, sin mapeo', async () => {
    const service = makeService(true);
    const res = await service.listAccounts(ORG, PERIOD);

    expect(res.enabled).toBe(true);
    expect(res.accounts.map((a) => a.accountId)).toEqual(['MOTHER', 'IC0XXEN8LOZW38EW2XP2']); // 500 > 200
    const fortaleza = res.accounts.find((a) => a.accountId === 'IC0XXEN8LOZW38EW2XP2')!;
    expect(fortaleza.accountAlias).toBe('Fortaleza Inmuebles');
    expect(fortaleza.totalSpend).toBe(200); // declarado en el array
    expect(fortaleza.mappedTo).toBeNull();
  });

  it('normaliza productId REPETIDO: suma usage + totalSpend (array + número + array)', async () => {
    const service = makeService(true);
    const items = await service.importVariables('IC0XXEN8LOZW38EW2XP2', PERIOD);

    const sessions = items.find((i) => i.label === 'SESSIONS');
    expect(sessions).toBeDefined();
    expect(sessions!.rawValue).toBe(17.5); // 10 + 5 + 2.5
    expect(sessions!.usage).toBe(175); // #23: 100 + 50 + 25 (suma de usage por productId)
    expect(sessions!.commercialValue).toBe(0);
    expect(sessions!.source).toBe('BOTMAKER');

    // totalSpend como OBJETO único { total, currency } se lee bien (antes daba 0).
    expect(items.find((i) => i.label === 'MESSAGES')!.rawValue).toBe(42);

    // ZERO (totalSpend 0) se excluye del import; FEE (100) y MESSAGES (42) entran.
    expect(items.map((i) => i.label).sort()).toEqual(['FEE', 'MESSAGES', 'SESSIONS']);
  });

  it('marca cuentas ya mapeadas a un cliente de la org', async () => {
    prisma.client.findMany.mockResolvedValue([
      { id: 'cli-9', name: 'Otro Cliente', botmakerAccountId: 'IC0XXEN8LOZW38EW2XP2' },
    ] as never);
    const service = makeService(true);
    const res = await service.listAccounts(ORG, PERIOD);
    const fortaleza = res.accounts.find((a) => a.accountId === 'IC0XXEN8LOZW38EW2XP2')!;
    expect(fortaleza.mappedTo).toEqual({ clientId: 'cli-9', clientName: 'Otro Cliente' });
  });

  it('flag off: listAccounts NO llama a Botmaker y devuelve enabled:false', async () => {
    const service = makeService(false);
    const res = await service.listAccounts(ORG, PERIOD);
    expect(res).toEqual({ enabled: false, accounts: [] });
    expect(client.fetchConsumptions).not.toHaveBeenCalled();
  });

  it('flag off: importVariables lanza BOTMAKER_DISABLED', async () => {
    const service = makeService(false);
    await expect(service.importVariables('ACC', PERIOD)).rejects.toMatchObject({ code: 'BOTMAKER_DISABLED' });
  });

  it('usa el cache Redis si hay hit (no re-fetch)', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify([
        { accountId: 'CACHED', accountName: 'c', accountAlias: 'c', totalSpend: 9, products: [] },
      ]) as never,
    );
    const service = makeService(true);
    const res = await service.listAccounts(ORG, PERIOD);
    expect(res.accounts.map((a) => a.accountId)).toEqual(['CACHED']);
    expect(client.fetchConsumptions).not.toHaveBeenCalled();
  });
});
