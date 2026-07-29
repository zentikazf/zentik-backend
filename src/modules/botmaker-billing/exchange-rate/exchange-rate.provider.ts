/**
 * #23 — Proveedor de tasa de cambio pluggable (D2). La impl v1 es SIMULADA (config); la de DNIT real
 * queda para fase 2 y se intercambia cambiando SOLO el `useClass` del token, sin tocar el motor de ciclos.
 *
 * La tasa que devuelve es una SUGERENCIA para prellenar el preview: el admin la revisa/corrige a mano
 * (nunca se factura con una tasa que el admin no pudo ver — R5 AC2). `null` = sin sugerencia (la pega el admin).
 */
export interface ExchangeRateProvider {
  getRate(date: Date, from: string, to: string): Promise<number | null>;
}

/** Token DI para inyectar la implementación activa del proveedor de tasa. */
export const EXCHANGE_RATE_PROVIDER = Symbol('EXCHANGE_RATE_PROVIDER');
