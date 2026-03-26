import { Module } from '@nestjs/common';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { PlanService } from './plan.service';
import { UsageTrackingService } from './usage-tracking.service';
import { FeatureGateService } from './feature-gate.service';

@Module({
  controllers: [SubscriptionController],
  providers: [SubscriptionService, PlanService, UsageTrackingService, FeatureGateService],
  exports: [SubscriptionService, PlanService, UsageTrackingService, FeatureGateService],
})
export class SubscriptionModule {}
