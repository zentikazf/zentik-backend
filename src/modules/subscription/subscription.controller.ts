import { Controller, Get, Post, Patch, Body, Param, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@modules/auth/guards/auth.guard';
import { RolesGuard } from '@modules/auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { SubscriptionService } from './subscription.service';
import { PlanService } from './plan.service';
import { UsageTrackingService } from './usage-tracking.service';
import { UpgradePlanDto } from './dto/upgrade-plan.dto';

@ApiTags('Subscriptions')
@ApiBearerAuth()
@UseGuards(AuthGuard, RolesGuard)
@Controller('subscriptions')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly planService: PlanService,
    private readonly usageTrackingService: UsageTrackingService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: 'List available plans' })
  getPlans() {
    return this.planService.getPlans();
  }

  @Get('current')
  @ApiOperation({ summary: 'Get current subscription' })
  getCurrentSubscription(@CurrentUser() user: any) {
    return this.subscriptionService.getCurrentSubscription(user.organizationId);
  }

  @Post('upgrade')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Upgrade subscription plan' })
  upgradePlan(@CurrentUser() user: any, @Body() dto: UpgradePlanDto) {
    return this.subscriptionService.upgradePlan(user.organizationId, dto);
  }

  @Post('downgrade')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Downgrade subscription plan' })
  downgradePlan(@CurrentUser() user: any, @Body() dto: UpgradePlanDto) {
    return this.subscriptionService.downgradePlan(user.organizationId, dto);
  }

  @Post('cancel')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Cancel subscription' })
  cancelSubscription(@CurrentUser() user: any) {
    return this.subscriptionService.cancelSubscription(user.organizationId);
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get usage statistics' })
  getUsage(@CurrentUser() user: any) {
    return this.usageTrackingService.getUsage(user.organizationId);
  }

  @Get('invoices')
  @ApiOperation({ summary: 'List invoices' })
  getInvoices(@CurrentUser() user: any, @Query('page') page?: number) {
    return this.subscriptionService.getInvoices(user.organizationId, page);
  }
}
