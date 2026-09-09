import { PrismaService } from '../../database/prisma.service';

/**
 * #69 — De que organizacion habla una request.
 *
 * EL PROBLEMA QUE RESUELVE. Hasta #68 F1b habia DOS formas de saberlo: el `:orgId` de la URL, o
 * una interseccion de compromiso cuando no estaba. Y ninguna validaba que esa organizacion fuera
 * del usuario. Peor: `permissions.guard.ts:24` deja pasar cualquier ruta que no declare
 * `@Permissions`, y son **176 de las 302 rutas del repo** — entre ellas las 22 de
 * `ticket.controller.ts`, que ni siquiera monta `PermissionsGuard`. Ahi el vaciado de permisos de
 * F1b no sirve de nada, porque nadie mira ese array.
 *
 * Este archivo deja UNA sola forma: la organizacion sale del `:orgId` si esta, y del RECURSO si
 * no. Despues `AuthGuard` valida la membresia y lanza el 403.
 *
 * ES UNA FUNCION PURA Y NO UN PROVIDER, a proposito: `AuthGuard` se instancia en el contexto de
 * cada modulo que lo monta (~30), asi que un provider inyectable obligaria a exportarlo desde
 * todos. `PrismaService` ya es `@Global()` (prisma.module.ts:4) y `AuthGuard` lo tiene a mano, asi
 * que alcanza con pasarselo. Diff chico y cero grafo de dependencias nuevo.
 */

/**
 * Como llegar de un parametro de ruta a su `organizationId`.
 *
 * `ruta` son las relaciones a atravesar. Se traduce a UNA consulta con `select` anidado, nunca a
 * N consultas encadenadas:
 *
 *   ruta: []                  ->  { organizationId: true }
 *   ruta: ['project']         ->  { project: { select: { organizationId: true } } }
 *   ruta: ['task','project']  ->  { task: { select: { project: { select: { organizationId: true } } } } }
 *
 * Verificado contra `prisma/schema.prisma`, no de memoria: 22 de 56 modelos tienen
 * `organizationId` directo; el resto llega por `Project`.
 *
 * EL ORDEN IMPORTA: se prueba de arriba hacia abajo y gana el primero presente. `orgId` va primero
 * porque no necesita consulta; despues los de un salto, y al final los mas profundos.
 */
export const MAPA_ORG: ReadonlyArray<{
  param: string;
  modelo: string;
  ruta: readonly string[];
}> = [
  // Un salto: el modelo tiene `organizationId` propio.
  { param: 'projectId', modelo: 'project', ruta: [] },
  { param: 'clientId', modelo: 'client', ruta: [] },
  { param: 'ticketId', modelo: 'ticket', ruta: [] },
  { param: 'channelId', modelo: 'channel', ruta: [] },
  { param: 'fileId', modelo: 'file', ruta: [] },
  // Dos saltos: cuelgan de un proyecto.
  { param: 'taskId', modelo: 'task', ruta: ['project'] },
  { param: 'boardId', modelo: 'board', ruta: ['project'] },
  { param: 'sprintId', modelo: 'sprint', ruta: ['project'] },
  { param: 'meetingId', modelo: 'meeting', ruta: ['project'] },
  // Tres saltos.
  { param: 'commentId', modelo: 'comment', ruta: ['task', 'project'] },
];

/**
 * Prefijos de path que el guard NO toca.
 *
 * Cada uno tiene su razon y ninguno es "por las dudas". Sacar uno de esta lista es un cambio
 * visible en el diff, y hay un test que enumera la lista para que no se mueva sin querer.
 */
export const PREFIJOS_EXENTOS: readonly string[] = [
  // Scoping propio: el portal filtra por el `clientId` del usuario, no por organizacion. Meterle
  // un candado de organizacion es redundante y arriesga romper el portal entero.
  '/portal',
  // Publicas o pre-sesion por diseno.
  '/auth',
  '/health',
  '/onboarding',
  // Operan sobre EL PROPIO USUARIO, no sobre una organizacion. Su tenencia es
  // `userId === session.userId`, que es otro eje y no lo cubre este spec.
  '/users',
  '/notifications',
];

export interface OrganizacionResuelta {
  /** La organizacion de la que habla la request, si se pudo determinar. */
  orgId: string | null;
  /**
   * `true` cuando el param existia en el mapa Y el recurso existe. `false` tanto para un recurso
   * INEXISTENTE como para uno que no se pudo resolver: son el mismo caso a propositito, para que la
   * respuesta no sirva de oraculo de existencia.
   */
  encontrado: boolean;
  /** `true` si hizo falta ir a la base. Lo usan los tests para verificar el atajo de 1 membership. */
  consulto: boolean;
}

const SIN_RESOLVER: OrganizacionResuelta = { orgId: null, encontrado: false, consulto: false };

/** `{ organizationId: true }` envuelto en tantos `select` anidados como diga `ruta`. */
function construirSelect(ruta: readonly string[]): Record<string, unknown> {
  let select: Record<string, unknown> = { organizationId: true };

  for (const relacion of [...ruta].reverse()) {
    select = { [relacion]: { select } };
  }

  return select;
}

/** Baja por el resultado siguiendo el mismo camino con el que se construyo el `select`. */
function extraerOrgId(fila: unknown, ruta: readonly string[]): string | null {
  let actual = fila as Record<string, unknown> | null;

  for (const relacion of ruta) {
    if (!actual) return null;
    actual = actual[relacion] as Record<string, unknown> | null;
  }

  return (actual?.organizationId as string) ?? null;
}

export function estaExento(path: string): boolean {
  // Se normaliza en dos pasos porque el guard lee `request.path ?? request.url` y los dos NO son
  // lo mismo: `path` viene sin query string, `url` CON. Sin cortar el `?`, una ruta exenta con
  // query (`/notifications?page=1`) dejaba de matchear y se le aplicaba el candado.
  // Y el prefijo global (`/api/v1`) puede venir o no segun de donde se lea.
  const limpio = path.split('?')[0].replace(/^\/api\/v\d+/, '');

  // La comparacion exige limite de segmento: `/usersomething` NO es `/users`.
  return PREFIJOS_EXENTOS.some((p) => limpio === p || limpio.startsWith(`${p}/`));
}

/**
 * Resuelve la organizacion de la request a partir de sus parametros de ruta.
 *
 * `orgId` gana siempre y no cuesta una consulta. Si no esta, se prueba el primer param del mapa
 * que aparezca y se hace UNA sola query.
 *
 * Devuelve `encontrado: false` —sin distinguir el motivo— cuando no hay ningun param conocido o
 * cuando el recurso no existe. `AuthGuard` traduce eso a "no interferir" y "403" respectivamente,
 * segun si hubo o no un param que resolver.
 */
export async function resolverOrganizacion(
  prisma: PrismaService,
  params: Record<string, string> | undefined,
  opciones: {
    /**
     * #70 — Saltea el atajo de `orgId` y resuelve SIEMPRE por el recurso.
     *
     * Existe para poder COMPARAR las dos fuentes. Con el comportamiento por defecto, `orgId` gana
     * y el recurso no se mira nunca — que es lo correcto para *resolver*, pero deja abiertas las
     * 43 rutas que traen `orgId` Y un id de recurso: ahi se puede poner la organizacion propia en
     * la URL y pedir un recurso ajeno.
     *
     * Es un parametro y no una funcion aparte a proposito: el mapa y la navegacion se escriben
     * una sola vez.
     */
    ignorarOrgId?: boolean;
  } = {},
): Promise<OrganizacionResuelta> {
  if (!params) return SIN_RESOLVER;

  // El camino barato: la URL ya lo dice.
  if (params.orgId && !opciones.ignorarOrgId) {
    return { orgId: params.orgId, encontrado: true, consulto: false };
  }

  const entrada = MAPA_ORG.find((m) => params[m.param]);
  if (!entrada) return SIN_RESOLVER;

  // `prisma[modelo]` es acceso dinamico: el mapa es data, no codigo generado. El cast es puntual
  // y esta acotado a esta linea; el test de T1.2 verifica el `select` de cada entrada contra el
  // modelo real, asi que una entrada mal escrita se cae en la suite y no en produccion.
  const delegate = (prisma as unknown as Record<string, { findUnique: Function }>)[entrada.modelo];
  if (!delegate?.findUnique) return SIN_RESOLVER;

  const fila = await delegate.findUnique({
    where: { id: params[entrada.param] },
    select: construirSelect(entrada.ruta),
  });

  // Recurso inexistente y recurso ajeno dan lo mismo: `encontrado: false` con `consulto: true`.
  if (!fila) return { orgId: null, encontrado: false, consulto: true };

  const orgId = extraerOrgId(fila, entrada.ruta);

  return { orgId, encontrado: orgId !== null, consulto: true };
}
