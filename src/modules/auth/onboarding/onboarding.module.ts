import { Global, Module } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { OnboardingController } from './onboarding.controller';

/**
 * Modulo Global para evitar dependency cycles. OnboardingService se usa desde
 * OrganizationModule (addMember) y ClientModule (createClientUser, createSubUser),
 * y AuthModule importa OrganizationModule — sin @Global tendriamos ciclo.
 */
@Global()
@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
