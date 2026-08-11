/**
 * Tabla de mappings slug Zentik → id de tipo de incidencia de OSD (#50 R1.4).
 *
 * DATO CONFIRMADO por el dueño contra el catálogo REAL de OSD: no se inventa, no
 * se "corrige" y no se completa con slugs que no estén acá. Es la fuente de verdad
 * del seed (`OnnixMappingService.seedTicketTypeMappings`), que la materializa como
 * filas `onnix_entity_mappings` con `entityType: 'ticket_type'`.
 *
 * Los ids NO son correlativos a propósito (falta el 23, salta al 94): así viene el
 * catálogo de OSD. Cualquier "arreglo" acá manda tickets al tipo equivocado.
 *
 * Las carpetas ocultas de #48 no llevan mapping propio por diseño: para los tipos
 * nuevos creados dentro de una rama está la cascada al padre (R1.1 paso 2).
 */
export const ONNIX_TICKET_TYPE_SLUG_MAP: Readonly<Record<string, number>> = {
  'fallo-total-en-flujos-o-canales': 15,
  'error-en-colas-y-derivaciones': 16,
  'problemas-de-integracion-whatsapp-web': 17,
  'nuevo-desarrollo': 18,
  'cambio-de-textos-o-mensajes-speech': 19,
  'actualizacion-de-datos-ciudades-asesores': 20,
  'dudas-y-consultas-de-uso-general': 21,
  'capacitacion-sobre-la-plataforma': 22,
  'flujo-o-formulario-especifico-con-error': 24,
  'fallo-en-logica-de-asignacion-asesor': 25,
  'errores-en-notificaciones-y-alertas': 26,
  'solicitud-de-creacion-de-usuario': 94,
};

/**
 * `entityType` de las filas de mapping de tipo de incidencia (R1.2). La tabla ya
 * soporta el valor nuevo (`entityType String`) → CERO migraciones.
 *
 * Sin colisión de claves con el default histórico: el fallback usa
 * `zentikId = 'SUPPORT_REQUEST'` (valor del enum) y la cascada nodo/padre usa
 * `zentikId = TicketType.id` (cuid). Mismo `entityType`, espacios de ids disjuntos.
 */
export const ONNIX_ENTITY_TYPE_TICKET_TYPE = 'ticket_type';
