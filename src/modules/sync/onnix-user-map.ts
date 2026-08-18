/**
 * Constantes del mapeo de usuarios Zentik → OSD (#52 R0.1/R1.1).
 *
 * Molde exacto de `onnix-ticket-type-map.ts`: dato confirmado contra OSD vivo, en
 * codigo y no en env.
 */

/**
 * Equipo de OSD del que sale el padron de responsables (#52 R0.1).
 *
 * CONSTANTE EN CODIGO, NO env var — criterio de #46: no cambia por entorno, asi que
 * una variable solo agregaria una forma de que prod y local difieran sin que nadie
 * se entere. Valor CONFIRMADO por el dueño el 2026-08-14 contra
 * `GET /equipos/2/usuarios`: tras sumar a Ada, el equipo 2 contiene a los 5 miembros
 * del equipo de soporte, asi que la cobertura del seed es COMPLETA.
 *
 * ⚠️ El rol `integracion` de OSD solo puede asignar a miembros de SU PROPIO equipo.
 * Si mañana el equipo se reparte de nuevo en varios equipos de OSD (era el estado
 * previo: R0.1-bis), los que queden afuera van a dar 422 al asignar — y ese 422 es
 * justo el caso que `processAssign` skipea con warn en vez de envenenar la DLQ.
 * Multi-equipo esta FUERA DE ALCANCE hasta que exista un segundo equipo real.
 */
export const ONNIX_SUPPORT_TEAM_ID = 2;

/**
 * `entityType` de las filas de mapping de usuario (R1.1). La tabla ya soporta el
 * valor nuevo (`entityType String`) → CERO migraciones.
 *
 * Sin colision de claves con los otros tipos: `zentikId = User.id` (cuid) vive en su
 * propio `entityType`, asi que la unique `(organizationId, entityType, zentikId)` no
 * puede chocar con 'client' / 'project' / 'ticket_type'.
 */
export const ONNIX_ENTITY_TYPE_USER = 'user';

/**
 * Limite duro de `reason` en `POST /tickets/{code}/asignar` (OpenAPI: maxLength
 * 500) — #52 R3.3. El dispatcher trunca ANTES de llamar: un nombre largo no puede
 * convertir una asignacion valida en un 422 de validacion.
 */
export const ASSIGN_REASON_MAX_LEN = 500;
