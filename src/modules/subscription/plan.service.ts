import { Injectable } from '@nestjs/common';

export interface PlanDefinition {
  id: string;
  name: string;
  price: number;
  currency: string;
  interval: 'monthly' | 'yearly';
  features: Record<string, boolean | number>;
  limits: {
    maxProjects: number;
    maxMembers: number;
    maxStorageGB: number;
    maxFileSize: number;
  };
}

@Injectable()
export class PlanService {
  private readonly plans: PlanDefinition[] = [
    {
      id: 'FREE',
      name: 'Free',
      price: 0,
      currency: 'USD',
      interval: 'monthly',
      features: {
        kanbanBoards: true,
        sprints: false,
        timeTracking: false,
        chat: false,
        reports: false,
        customRoles: false,
        auditLog: false,
        apiAccess: false,
      },
      limits: {
        maxProjects: 3,
        maxMembers: 5,
        maxStorageGB: 1,
        maxFileSize: 10 * 1024 * 1024,
      },
    },
    {
      id: 'PRO',
      name: 'Pro',
      price: 12,
      currency: 'USD',
      interval: 'monthly',
      features: {
        kanbanBoards: true,
        sprints: true,
        timeTracking: true,
        chat: true,
        reports: true,
        customRoles: false,
        auditLog: false,
        apiAccess: true,
      },
      limits: {
        maxProjects: 20,
        maxMembers: 25,
        maxStorageGB: 10,
        maxFileSize: 50 * 1024 * 1024,
      },
    },
    {
      id: 'ENTERPRISE',
      name: 'Enterprise',
      price: 29,
      currency: 'USD',
      interval: 'monthly',
      features: {
        kanbanBoards: true,
        sprints: true,
        timeTracking: true,
        chat: true,
        reports: true,
        customRoles: true,
        auditLog: true,
        apiAccess: true,
      },
      limits: {
        maxProjects: -1,
        maxMembers: -1,
        maxStorageGB: 100,
        maxFileSize: 200 * 1024 * 1024,
      },
    },
  ];

  getPlans(): PlanDefinition[] {
    return this.plans;
  }

  getPlan(planId: string): PlanDefinition | undefined {
    return this.plans.find((p) => p.id === planId);
  }

  hasFeature(planId: string, feature: string): boolean {
    const plan = this.getPlan(planId);
    if (!plan) return false;
    return !!plan.features[feature];
  }

  getLimit(planId: string, limit: keyof PlanDefinition['limits']): number {
    const plan = this.getPlan(planId);
    if (!plan) return 0;
    return plan.limits[limit];
  }
}
