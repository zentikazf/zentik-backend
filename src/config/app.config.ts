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

  // Cutover a cookie same-site (migración a subdominios app./api.). Con `true` la
  // cookie de sesión usa prefijo __Host- + SameSite=Lax; con `false` (default)
  // mantiene el comportamiento cross-site actual (plana + None en prod). Se flipea
  // sin deploy. process.env siempre es string → comparamos contra 'true'.
  get cookieSameSiteLax(): boolean {
    return this.configService.get<string>('COOKIE_SAMESITE_LAX') === 'true';
  }

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

  // === Rate-limit / trust proxy (#45) ===
  // Number(...) explícito: validateEnv() valida pero NO inyecta los defaults de
  // Zod de vuelta a process.env, así que la app debe arrancar sin la var (mismo
  // patrón que onnix/botmaker). El default 1 espeja env.validation.ts.
  get trustProxyHops(): number {
    return Number(this.configService.get<string>('TRUST_PROXY_HOPS') ?? 1);
  }
  get debugTrustProxy(): boolean {
    return this.configService.get<string>('DEBUG_TRUST_PROXY') === 'true';
  }
  get dupRequestWarnThreshold(): number {
    return Number(this.configService.get<string>('DUP_REQUEST_WARN_THRESHOLD') ?? 3);
  }
  get dupRequestWindowMs(): number {
    return Number(this.configService.get<string>('DUP_REQUEST_WINDOW_MS') ?? 1000);
  }

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

  // === Sync Onnix (feature #13) ===
  // Feature flag maestro. process.env siempre es string; comparamos contra 'true'.
  // Con flag off los secretos Onnix son opcionales y todos los caminos de sync
  // hacen early-return (no rompe el boot sin credenciales).
  get onnixSyncEnabled(): boolean {
    return this.configService.get<string>('ONNIX_SYNC_ENABLED') === 'true';
  }
  // Whitelist de organizaciones habilitadas para sync Onnix (scoping multi-tenant).
  // CSV de org cuids; vacio = ninguna org sincroniza (el gate de enqueueTx hace
  // no-op). process.env siempre es string; split + trim + filter de vacios.
  get onnixSyncOrgIds(): string[] {
    return (this.configService.get<string>('ONNIX_SYNC_ORG_IDS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Modo simulacro (opt-in, default false). process.env siempre es string;
  // comparamos contra 'true'. Con `true` y ENABLED on, el drenador corre todo el
  // pipeline pero NO hace el POST real a Onnix (loggea el body resuelto). Ortogonal
  // a onnixSyncEnabled: requiere ENABLED=true para que el pipeline corra.
  get onnixSyncDryRun(): boolean {
    return this.configService.get<string>('ONNIX_SYNC_DRY_RUN') === 'true';
  }
  // Secretos / base url: OPTIONAL en el boot. Se validan en runtime (al primer
  // uso) solo si el flag esta on. NUNCA loggeados.
  get onnixBaseUrl(): string | undefined { return this.configService.get<string>('ONNIX_BASE_URL'); }
  get onnixEmail(): string | undefined { return this.configService.get<string>('ONNIX_EMAIL'); }
  get onnixPassword(): string | undefined { return this.configService.get<string>('ONNIX_PASSWORD'); }
  // Tunables con default seguro EN EL GETTER (no getOrThrow): validateEnv() valida
  // process.env pero NO inyecta los defaults de Zod de vuelta a process.env, asi que
  // con el flag off (y sin estas vars en .env) la app debe arrancar igual. Number(...)
  // explicito porque process.env siempre es string. Los defaults espejan env.validation.ts.
  get onnixHttpTimeoutMs(): number {
    return Number(this.configService.get<string>('ONNIX_HTTP_TIMEOUT_MS') ?? 15000);
  }
  get onnixSyncCron(): string {
    return this.configService.get<string>('ONNIX_SYNC_CRON') ?? '0 0 * * * *';
  }
  get onnixSyncBatchSize(): number {
    return Number(this.configService.get<string>('ONNIX_SYNC_BATCH_SIZE') ?? 50);
  }
  get onnixSyncMaxAttempts(): number {
    return Number(this.configService.get<string>('ONNIX_SYNC_MAX_ATTEMPTS') ?? 3);
  }
  get onnixSyncStaleLockMs(): number {
    return Number(this.configService.get<string>('ONNIX_SYNC_STALE_LOCK_MS') ?? 120000);
  }
  get onnixCatalogCacheTtlSec(): number {
    return Number(this.configService.get<string>('ONNIX_CATALOG_CACHE_TTL_SEC') ?? 600);
  }
  get onnixDlqMaxAgeMin(): number {
    return Number(this.configService.get<string>('ONNIX_DLQ_MAX_AGE_MIN') ?? 1440);
  }

  // === Botmaker Billing (feature #23) ===
  // Feature flag maestro (molde Onnix). Con `false` (default) los secretos Botmaker son
  // opcionales y el select de cuentas / import hacen early-return: el boot no falla sin
  // credenciales. process.env siempre es string; comparamos contra 'true'.
  get botmakerBillingEnabled(): boolean {
    return this.configService.get<string>('BOTMAKER_BILLING_ENABLED') === 'true';
  }
  // Secretos / base url: OPTIONAL en el boot. Se validan en runtime (al primer uso) solo si el
  // flag esta on. El access-token NUNCA se loggea.
  get botmakerBaseUrl(): string | undefined { return this.configService.get<string>('BOTMAKER_BASE_URL'); }
  get botmakerAccessToken(): string | undefined { return this.configService.get<string>('BOTMAKER_ACCESS_TOKEN'); }
  // Tunables con default seguro EN EL GETTER (no getOrThrow): validateEnv NO inyecta los defaults
  // de Zod a process.env, asi que con el flag off la app arranca igual. Number(...) explicito.
  get botmakerHttpTimeoutMs(): number {
    return Number(this.configService.get<string>('BOTMAKER_HTTP_TIMEOUT_MS') ?? 15000);
  }
  get botmakerCacheTtlSec(): number {
    return Number(this.configService.get<string>('BOTMAKER_CACHE_TTL_SEC') ?? 1800);
  }
  // Tasa USD→PYG simulada (v1). Fallback manual mientras no haya integración DNIT (fase 2). El
  // preview de generación la muestra editable — nunca se factura con una tasa que el admin no revisó.
  get exchangeRateSimulated(): number | undefined {
    const raw = this.configService.get<string>('EXCHANGE_RATE_SIMULATED');
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  // === Motor de SLA con cascada (feature #42 — Fase 1) ===
  // Con `false` (default, incluye la var ausente) la resolución de SLA al crear un
  // ticket es EXACTAMENTE la de hoy. Con `true` corre la cascada del SlaResolverService.
  // process.env siempre es string → comparamos contra 'true' (molde Onnix/Botmaker).
  // ⚠️ Activarlo sin una política "Estándar" en la org deja tickets SIN SLA: la cascada
  // termina en `NONE` y los deadlines quedan null. Verificar antes con `sla-readiness`.
  get slaCascadeEnabled(): boolean {
    return this.configService.get<string>('SLA_CASCADE_ENABLED') === 'true';
  }
}
