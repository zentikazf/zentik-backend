import { Injectable } from '@nestjs/common';
import { PrismaService } from '@database/prisma.service';
import { RedisService } from '@infrastructure/redis/redis.service';
import { PlanService } from './plan.service';
import { FeatureNotAvailableException } from '@common/filters/app-exception';

@Injectable()
export class FeatureGateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly planService: PlanService,
  ) {}

  async checkFeatureAccess(organizationId: string, feature: string): Promise<boolean> {
    const cacheKey = `zentik:feature-gate:${organizationId}:${feature}`;
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) return cached === 'true';

    const subscription = await this.prisma.subscription.findFirst({
      where: { organizationId, status: 'ACTIVE' },
    });

    const planId = subscription?.plan || 'FREE';
    const hasAccess = this.planService.hasFeature(planId, feature);

    await this.redis.setex(cacheKey, 600, String(hasAccess));
    return hasAccess;
  }

  async requireFeature(organizationId: string, feature: string): Promise<void> {
    const hasAccess = await this.checkFeatureAccess(organizationId, feature);
    if (!hasAccess) {
      const subscription = await this.prisma.subscription.findFirst({
        where: { organizationId, status: 'ACTIVE' },
      });
      const currentPlan = subscription?.plan || 'FREE';
      throw new FeatureNotAvailableException(feature, currentPlan);
    }
  }
}
