import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { OrganizationModule } from '../organization/organization.module';
import { OnboardingController } from './onboarding/onboarding.controller';
import { OnboardingService } from './onboarding/onboarding.service';

@Module({
  imports: [OrganizationModule],
  controllers: [AuthController, OnboardingController],
  providers: [AuthService, AuthGuard, RolesGuard, OnboardingService],
  exports: [AuthService, AuthGuard, RolesGuard, OnboardingService],
})
export class AuthModule {}
