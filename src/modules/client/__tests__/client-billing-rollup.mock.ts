import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import {
  ClientBillingService,
  HoursBillingRollup,
} from '../../client-billing/client-billing.service';

/**
 * #72 A — Doble del motor de facturación para los specs de `ClientService`.
 *
 * `getHoursSummary` pasó a colgar el rollup de las tres cards (`getHoursBillingRollup`), así que
 * todo spec que lo llame necesita el doble resuelto o revienta con `undefined`. El helper vive
 * acá y no copiado en cada archivo para que el día que el rollup gane un campo se agregue en UN
 * solo lugar.
 *
 * ⚠️ No matchea el `testRegex` de jest (`*.spec.ts` / `*.e2e-spec.ts`), así que no se ejecuta como
 * suite pese a estar en `__tests__`.
 */

/** Rollup vacío: nada facturable, ninguna factura, ningún ciclo. */
export const emptyHoursBillingRollup = (): HoursBillingRollup => ({
  billing: {
    pending: { amount: '0', taxMode: null },
    invoiced: { amount: '0', invoices: [] },
    paid: { amount: '0', invoices: [] },
  },
  stateByCycleId: {},
});

/** Mock de `ClientBillingService` con el rollup ya resuelto. */
export function mockClientBilling(
  rollup: HoursBillingRollup = emptyHoursBillingRollup(),
): DeepMockProxy<ClientBillingService> {
  const billing = mockDeep<ClientBillingService>();
  billing.getHoursBillingRollup.mockResolvedValue(rollup);
  return billing;
}
