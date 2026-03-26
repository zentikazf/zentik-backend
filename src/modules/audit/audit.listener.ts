import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditService } from './audit.service';

interface DomainEvent {
  type: string;
  entity: string;
  entityId: string;
  organizationId?: string;
  userId?: string;
  data?: Record<string, unknown>;
  oldData?: Record<string, unknown>;
}

@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name);

  constructor(private readonly auditService: AuditService) {}

  @OnEvent('**')
  async handleAllEvents(event: DomainEvent) {
    if (!event || !event.type || !event.entity) {
      return;
    }

    // Skip audit events themselves to prevent infinite loops
    if (event.entity === 'audit') {
      return;
    }

    if (!event.organizationId) {
      this.logger.debug(
        `Skipping audit for event ${event.type}: no organizationId`,
      );
      return;
    }

    try {
      await this.auditService.create({
        action: event.type,
        resource: event.entity,
        resourceId: event.entityId,
        organizationId: event.organizationId,
        userId: event.userId,
        newData: event.data,
        oldData: event.oldData,
      });
    } catch (error) {
      this.logger.error(
        `Failed to log audit event: ${event.type}`,
        error,
      );
    }
  }
}
