import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@database/prisma.service';
import { RedisService } from '@infrastructure/redis/redis.service';
import { PlanService } from './plan.service';

@Injectable()
export class UsageTrackingService {
  private readonly logger = new Logger(UsageTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly planService: PlanService,
  ) {}

  async getUsage(organizationId: string) {
    const cacheKey = `zentik:usage:${organizationId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [projectCount, memberCount, storageUsed] = await Promise.all([
      this.prisma.project.count({ where: { organizationId } }),
      this.prisma.organizationMember.count({ where: { organizationId } }),
      this.getStorageUsage(organizationId),
    ]);

    const usage = {
      projects: projectCount,
      members: memberCount,
      storageUsedBytes: storageUsed,
      storageUsedGB: Math.round((storageUsed / (1024 * 1024 * 1024)) * 100) / 100,
    };

    await this.redis.setex(cacheKey, 300, JSON.stringify(usage));
    return usage;
  }

  async checkLimit(organizationId: string, resource: string): Promise<boolean> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { organizationId, status: 'ACTIVE' },
    });

    const planId = subscription?.plan || 'FREE';
    const usage = await this.getUsage(organizationId);

    switch (resource) {
      case 'projects':
        const maxProjects = this.planService.getLimit(planId, 'maxProjects');
        return maxProjects === -1 || usage.projects < maxProjects;
      case 'members':
        const maxMembers = this.planService.getLimit(planId, 'maxMembers');
        return maxMembers === -1 || usage.members < maxMembers;
      default:
        return true;
    }
  }

  private async getStorageUsage(organizationId: string): Promise<number> {
    const result = await this.prisma.file.aggregate({
      where: { organizationId },
      _sum: { size: true },
    });
    return result._sum.size || 0;
  }
}
