import { SetMetadata } from '@nestjs/common';

export const PLAN_FEATURE_KEY = 'plan-feature';
export const RequiresPlan = (feature: string) => SetMetadata(PLAN_FEATURE_KEY, feature);
