/**
 * Catalogo de tipos de evento soportados por push notifications.
 * Cada entrada define: key interna, label visible y default enabled (segun criticidad).
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
} as const;

export type PushEventType = (typeof PUSH_EVENT_TYPES)[keyof typeof PUSH_EVENT_TYPES];

export interface PushEventMeta {
  eventType: PushEventType;
  label: string;
  description: string;
  defaultEnabled: boolean; // criticos vienen en true, el resto false
}

export const PUSH_EVENT_CATALOG: PushEventMeta[] = [
  {
    eventType: PUSH_EVENT_TYPES.CHAT_MESSAGE,
    label: 'Mensajes en tickets',
    description: 'Cuando un cliente escribe en el chat de un ticket.',
    defaultEnabled: true,
  },
  {
    eventType: PUSH_EVENT_TYPES.TASK_ASSIGNED,
    label: 'Tareas asignadas',
    description: 'Cuando te asignan una tarea.',
    defaultEnabled: true,
  },
  {
    eventType: PUSH_EVENT_TYPES.SLA_BREACHED,
    label: 'SLA vencido',
    description: 'Cuando el SLA de un ticket se incumple.',
    defaultEnabled: true,
  },
  {
    eventType: PUSH_EVENT_TYPES.SLA_WARNING,
    label: 'SLA por vencer',
    description: 'Cuando un ticket esta cerca de su deadline.',
    defaultEnabled: true,
  },
  {
    eventType: PUSH_EVENT_TYPES.TICKET_CREATED,
    label: 'Nuevos tickets',
    description: 'Cuando un cliente crea un ticket nuevo.',
    defaultEnabled: true,
  },
  {
    eventType: PUSH_EVENT_TYPES.TICKET_STATUS_CHANGED,
    label: 'Cambio de estado de ticket',
    description: 'Cuando un ticket que te involucra cambia de estado.',
    defaultEnabled: false,
  },
  {
    eventType: PUSH_EVENT_TYPES.COMMENT_CREATED,
    label: 'Comentarios en tareas',
    description: 'Cuando alguien comenta en una tarea donde estas asignado.',
    defaultEnabled: false,
  },
  {
    eventType: PUSH_EVENT_TYPES.APPROVAL_REQUESTED,
    label: 'Aprobaciones pendientes',
    description: 'Cuando se solicita tu aprobacion.',
    defaultEnabled: true,
  },
];
