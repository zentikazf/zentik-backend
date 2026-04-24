import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private configService: ConfigService) {}

  get nodeEnv(): string { return this.configService.getOrThrow<string>('NODE_ENV'); }
  get port(): number { return this.configService.getOrThrow<number>('PORT'); }
  get apiUrl(): string { return this.configService.getOrThrow<string>('API_URL'); }
  get webUrl(): string { return this.configService.getOrThrow<string>('WEB_URL'); }
  get apiPrefix(): string { return this.configService.getOrThrow<string>('API_PREFIX'); }
  get isProduction(): boolean { return this.nodeEnv === 'production'; }
  get isDevelopment(): boolean { return this.nodeEnv === 'development'; }

  get databaseUrl(): string { return this.configService.getOrThrow<string>('DATABASE_URL'); }
  get redisUrl(): string { return this.configService.getOrThrow<string>('REDIS_URL'); }

  get betterAuthSecret(): string { return this.configService.getOrThrow<string>('BETTER_AUTH_SECRET'); }
  get betterAuthUrl(): string { return this.configService.getOrThrow<string>('BETTER_AUTH_URL'); }

  get googleClientId(): string | undefined { return this.configService.get<string>('GOOGLE_CLIENT_ID'); }
  get googleClientSecret(): string | undefined { return this.configService.get<string>('GOOGLE_CLIENT_SECRET'); }
  get githubClientId(): string | undefined { return this.configService.get<string>('GITHUB_CLIENT_ID'); }
  get githubClientSecret(): string | undefined { return this.configService.get<string>('GITHUB_CLIENT_SECRET'); }

  get resendApiKey(): string | undefined { return this.configService.get<string>('RESEND_API_KEY'); }
  get emailFrom(): string { return this.configService.get<string>('EMAIL_FROM') || 'Zentikk <noreply@zentikk.com>'; }

  get storageEndpoint(): string | undefined { return this.configService.get<string>('STORAGE_ENDPOINT'); }
  get storageAccessKey(): string | undefined { return this.configService.get<string>('STORAGE_ACCESS_KEY'); }
  get storageSecretKey(): string | undefined { return this.configService.get<string>('STORAGE_SECRET_KEY'); }
  get storageBucket(): string { return this.configService.getOrThrow<string>('STORAGE_BUCKET'); }
  get storageRegion(): string { return this.configService.getOrThrow<string>('STORAGE_REGION'); }

  get sentryDsn(): string | undefined { return this.configService.get<string>('SENTRY_DSN'); }
  get logLevel(): string { return this.configService.getOrThrow<string>('LOG_LEVEL'); }

  // Web Push (VAPID) — optional: si no estan configuradas, el push se desactiva silenciosamente
  get vapidPublicKey(): string | undefined { return this.configService.get<string>('VAPID_PUBLIC_KEY'); }
  get vapidPrivateKey(): string | undefined { return this.configService.get<string>('VAPID_PRIVATE_KEY'); }
  get vapidSubject(): string { return this.configService.get<string>('VAPID_SUBJECT') || 'mailto:admin@zentikk.com'; }
  get pushEnabled(): boolean { return !!(this.vapidPublicKey && this.vapidPrivateKey); }
}
