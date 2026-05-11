/**
 * Catalogo de tipos de evento soportados por el sistema de notificaciones.
 * Cada entrada define: key interna, label visible, descripcion, y defaults
 * separados para los canales PUSH (navegador) y EMAIL.
 *
 * Nota: el archivo conserva el prefijo "push" por compatibilidad con imports
 * existentes, pero el catalogo aplica para todos los canales de notificacion.
 */

export const PUSH_EVENT_TYPES = {
  CHAT_MESSAGE: 'chat.message',
  TASK_ASSIGNED: 'task.assigned',
  TICKET_STATUS_CHANGED: 'ticket.status_changed',
  SLA_BREACHED: 'sla.breached',
  SLA_WARNING: 'sla.warning',
  TICKET_CREATED: 'ticket.created',
  COMMENT_CREATED: 'comment.created',
  APPROVAL_REQUESTED: 'approval.requested',
  CLIENT_DOCUMENT_SHARED: 'client.document.shared',
  ALCANCE_SUBMITTED: 'alcance.submitted',
} as const;

export type PushEventType = (typeof PUSH_EVENT_TYPES)[keyof typeof PUSH_EVENT_TYPES];

export interface PushEventMeta {
  eventType: PushEventType;
  label: string;
  description: string;
  /** Default para canal PUSH (navegador) */
  defaultPushEnabled: boolean;
  /** Default para canal EMAIL — mas conservador para evitar saturar */
  defaultEmailEnabled: boolean;
  /** Audiencia a la que aplica el evento. Por defecto solo team. */
  audience?: 'team' | 'client' | 'both';
}

export const PUSH_EVENT_CATALOG: PushEventMeta[] = [
  {
    eventType: PUSH_EVENT_TYPES.CHAT_MESSAGE,
    label: 'Mensajes en tickets',
    description: 'Cuando alguien escribe en el chat de un ticket.',
    defaultPushEnabled: true,
    defaultEmailEnabled: false,
    audience: 'both',
  },
  {
    eventType: PUSH_EVENT_TYPES.TASK_ASSIGNED,
    label: 'Tareas asignadas',
    description: 'Cuando te asignan una tarea.',
    defaultPushEnabled: true,
    defaultEmailEnabled: true,
  },
  {
    eventType: PUSH_EVENT_TYPES.SLA_BREACHED,
    label: 'SLA vencido',
    description: 'Cuando el SLA de un ticket se incumple.',
    defaultPushEnabled: true,
    defaultEmailEnabled: true,
  },
  {
    eventType: PUSH_EVENT_TYPES.SLA_WARNING,
    label: 'SLA por vencer',
    description: 'Cuando un ticket esta cerca de su deadline.',
    defaultPushEnabled: true,
    defaultEmailEnabled: false,
  },
  {
    eventType: PUSH_EVENT_TYPES.TICKET_CREATED,
    label: 'Nuevos tickets',
    description: 'Cuando un cliente crea un ticket nuevo.',
    defaultPushEnabled: true,
    defaultEmailEnabled: false,
  },
  {
    eventType: PUSH_EVENT_TYPES.TICKET_STATUS_CHANGED,
    label: 'Cambio de estado de ticket',
    description: 'Cuando un ticket que te involucra cambia de estado.',
    defaultPushEnabled: true,
    defaultEmailEnabled: false,
    audience: 'both',
  },
  {
    eventType: PUSH_EVENT_TYPES.COMMENT_CREATED,
    label: 'Comentarios en tareas',
    description: 'Cuando alguien comenta en una tarea donde estas asignado.',
    defaultPushEnabled: false,
    defaultEmailEnabled: false,
  },
  {
    eventType: PUSH_EVENT_TYPES.APPROVAL_REQUESTED,
    label: 'Aprobaciones pendientes',
    description: 'Cuando se solicita tu aprobacion.',
    defaultPushEnabled: true,
    defaultEmailEnabled: true,
  },
  {
    eventType: PUSH_EVENT_TYPES.CLIENT_DOCUMENT_SHARED,
    label: 'Documentos compartidos',
    description: 'Cuando el equipo te comparte un documento nuevo en algún proyecto.',
    defaultPushEnabled: false,
    defaultEmailEnabled: false,
    audience: 'client',
  },
  {
    eventType: PUSH_EVENT_TYPES.ALCANCE_SUBMITTED,
    label: 'Alcance pendiente de aprobación',
    description: 'Cuando un proyecto envia su alcance para que lo apruebes.',
    defaultPushEnabled: true,
    defaultEmailEnabled: true,
    audience: 'client',
  },
];

/** Canales de notificacion soportados */
export const NOTIFICATION_CHANNELS = ['PUSH', 'EMAIL'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
