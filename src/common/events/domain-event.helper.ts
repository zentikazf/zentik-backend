export interface DomainEvent {
  type: string;
  entity: string;
  entityId: string;
  organizationId?: string;
  userId?: string;
  data?: Record<string, unknown>;
  oldData?: Record<string, unknown>;
}

export function domainEvent(
  eventName: string,
  entity: string,
  entityId: string,
  organizationId: string,
  userId?: string,
  data?: Record<string, unknown>,
  oldData?: Record<string, unknown>,
): DomainEvent {
  return {
    type: eventName,
    entity,
    entityId,
    organizationId,
    userId,
    data,
    oldData,
  };
}
