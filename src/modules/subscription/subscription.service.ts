import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@database/prisma.service';
import { RedisService } from '@infrastructure/redis/redis.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppException } from '@common/filters/app-exception';
import { PlanTier } from '@prisma/client';
import { UpgradePlanDto } from './dto/upgrade-plan.dto';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async getCurrentSubscription(organizationId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { organizationId, status: 'ACTIVE' },
    });

    if (!subscription) {
      return { plan: 'FREE', status: 'ACTIVE' };
    }

    return subscription;
  }

  async upgradePlan(organizationId: string, dto: UpgradePlanDto) {
    const current = await this.getCurrentSubscription(organizationId);

    const subscription = await this.prisma.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        plan: dto.plan as PlanTier,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      update: {
        plan: dto.plan as PlanTier,
        status: 'ACTIVE',
      },
    });

    await this.redis.del(`zentik:subscription:${organizationId}`);
    this.eventEmitter.emit('subscription.upgraded', { organizationId, plan: dto.plan });

    return subscription;
  }

  async downgradePlan(organizationId: string, dto: UpgradePlanDto) {
    const subscription = await this.prisma.subscription.updateMany({
      where: { organizationId, status: 'ACTIVE' },
      data: { plan: dto.plan as PlanTier },
    });

    await this.redis.del(`zentik:subscription:${organizationId}`);
    this.eventEmitter.emit('subscription.downgraded', { organizationId, plan: dto.plan });

    return subscription;
  }

  async cancelSubscription(organizationId: string) {
    await this.prisma.subscription.updateMany({
      where: { organizationId, status: 'ACTIVE' },
      data: { status: 'CANCELLED', cancelAtPeriodEnd: true },
    });

    await this.redis.del(`zentik:subscription:${organizationId}`);
    this.eventEmitter.emit('subscription.cancelled', { organizationId });

    return { message: 'Subscription cancelled successfully' };
  }

  async getInvoices(organizationId: string, page = 1) {
    const limit = 20;
    const skip = (page - 1) * limit;

    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.invoice.count({ where: { organizationId } }),
    ]);

    return {
      data: invoices,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
