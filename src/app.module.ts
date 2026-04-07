import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CorrelationIdMiddleware } from './common/middleware';
import { PrismaModule } from './database/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { EmailModule } from './infrastructure/email/email.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { AppConfigModule } from './config/config.module';
import databaseConfig from './config/database.config';
import redisConfig from './config/redis.config';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { RoleModule } from './modules/role/role.module';
import { ProjectModule } from './modules/project/project.module';
import { BoardModule } from './modules/board/board.module';
import { TaskModule } from './modules/task/task.module';
import { SprintModule } from './modules/sprint/sprint.module';
import { TimeTrackingModule } from './modules/time-tracking/time-tracking.module';
import { ChatModule } from './modules/chat/chat.module';
import { NotificationModule } from './modules/notification/notification.module';
import { FileModule } from './modules/file/file.module';
import { BillingModule } from './modules/billing/billing.module';
import { ReportModule } from './modules/report/report.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { AuditModule } from './modules/audit/audit.module';
import { HealthModule } from './modules/health/health.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { CommentModule } from './modules/comment/comment.module';
import { ClientModule } from './modules/client/client.module';
import { PortalModule } from './modules/portal/portal.module';
import { LabelModule } from './modules/label/label.module';
import { MeetingModule } from './modules/meeting/meeting.module';
import { TicketModule } from './modules/ticket/ticket.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';

@Module({
  imports: [
    // Config
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    AppConfigModule,
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 3 },
      { name: 'medium', ttl: 10000, limit: 20 },
      { name: 'long', ttl: 60000, limit: 100 },
    ]),

    // Infrastructure
    PrismaModule,
    RedisModule,
    EmailModule,
    StorageModule,
    QueueModule,

    // Feature modules
    AuthModule,
    UserModule,
    OrganizationModule,
    RoleModule,
    ProjectModule,
    BoardModule,
    TaskModule,
    SprintModule,
    TimeTrackingModule,
    ChatModule,
    NotificationModule,
    FileModule,
    BillingModule,
    ReportModule,
    CalendarModule,
    AuditModule,
    HealthModule,
    SubscriptionModule,
    CommentModule,
    ClientModule,
    PortalModule,
    LabelModule,
    MeetingModule,
    TicketModule,
    DashboardModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  exports: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
