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

  get prismaTxTimeoutMs(): number {
    // Cast explicito a number — env vars en process.env siempre son string,
    // y el generico <number> del ConfigService es solo hint de TS, no convierte
    // en runtime. Sin Number(...), Prisma $transaction recibe string y el query
    // engine en Rust falla con "invalid type: string, expected u64".
    return Number(this.configService.getOrThrow<number>('PRISMA_TX_TIMEOUT_MS'));
  }
  get prismaTxMaxWaitMs(): number {
    return Number(this.configService.getOrThrow<number>('PRISMA_TX_MAX_WAIT_MS'));
  }

  // Web Push (VAPID) — optional: si no estan configuradas, el push se desactiva silenciosamente
  get vapidPublicKey(): string | undefined { return this.configService.get<string>('VAPID_PUBLIC_KEY'); }
  get vapidPrivateKey(): string | undefined { return this.configService.get<string>('VAPID_PRIVATE_KEY'); }
  get vapidSubject(): string { return this.configService.get<string>('VAPID_SUBJECT') || 'mailto:admin@zentikk.com'; }
  get pushEnabled(): boolean { return !!(this.vapidPublicKey && this.vapidPrivateKey); }

  // === Admin MCP Chat (feature #8) ===
  // Wrapper Number(...)/casting explicito porque ConfigService.getOrThrow<number>
  // devuelve string en runtime — el generico es solo TS hint.
  get mcpBaseUrl(): string { return this.configService.getOrThrow<string>('MCP_BASE_URL'); }
  get mcpHttpTimeoutMs(): number { return Number(this.configService.getOrThrow<number>('MCP_HTTP_TIMEOUT_MS')); }
  get mcpToolsCacheTtlSec(): number { return Number(this.configService.getOrThrow<number>('MCP_TOOLS_CACHE_TTL_SEC')); }

  get llmProvider(): 'openrouter' | 'deepseek' | 'openai' | 'qwen' {
    return this.configService.getOrThrow<'openrouter' | 'deepseek' | 'openai' | 'qwen'>('LLM_PROVIDER');
  }
  get llmBaseUrl(): string | undefined { return this.configService.get<string>('LLM_BASE_URL'); }
  get llmApiKey(): string { return this.configService.getOrThrow<string>('LLM_API_KEY'); }
  get llmModel(): string { return this.configService.getOrThrow<string>('LLM_MODEL'); }
  get llmMaxTokens(): number { return Number(this.configService.getOrThrow<number>('LLM_MAX_TOKENS')); }
  get llmMaxIterations(): number { return Number(this.configService.getOrThrow<number>('LLM_MAX_ITERATIONS')); }
  get llmTimeoutMs(): number { return Number(this.configService.getOrThrow<number>('LLM_TIMEOUT_MS')); }

  get adminMcpRateLimitPerMinute(): number {
    return Number(this.configService.getOrThrow<number>('ADMIN_MCP_RATE_LIMIT_PER_MINUTE'));
  }
  get adminMcpRateLimitPerDay(): number {
    return Number(this.configService.getOrThrow<number>('ADMIN_MCP_RATE_LIMIT_PER_DAY'));
  }
}
