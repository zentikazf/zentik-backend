import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  API_URL: z.string().url().default('http://localhost:3001'),
  WEB_URL: z.string().default('http://localhost:3002'),
  API_PREFIX: z.string().default('/api/v1'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Zentikk <noreply@zentikk.com>'),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  STORAGE_BUCKET: z.string().default('zentik-files'),
  STORAGE_REGION: z.string().default('us-east-1'),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('debug'),

  // Prisma $transaction tunables. Default seguro para dev con BD remota (Railway):
  // 15s para tx que hacen 6-10 queries secuenciales con latencia ~300ms. En prod
  // (Railway<->Railway, latencia ~5ms) podes bajar via env vars sin recompilar.
  PRISMA_TX_TIMEOUT_MS: z.coerce.number().default(15000),
  PRISMA_TX_MAX_WAIT_MS: z.coerce.number().default(10000),

  // === Admin MCP Chat (feature #8) ===
  // URL completa del MCP HTTP (incluye /mcp suffix). Ejemplo:
  //   https://zentikazf-mcp-production.up.railway.app/mcp
  MCP_BASE_URL: z.string().url(),
  // Timeout por call HTTP al MCP (ms).
  MCP_HTTP_TIMEOUT_MS: z.coerce.number().default(15000),
  // TTL del cache de tools/list (segundos).
  MCP_TOOLS_CACHE_TTL_SEC: z.coerce.number().default(300),

  // LLM provider: openrouter | deepseek | openai | qwen (todos via SDK openai).
  LLM_PROVIDER: z.enum(['openrouter', 'deepseek', 'openai', 'qwen']).default('openrouter'),
  // Override explicito del baseURL del provider (opcional; el factory aplica defaults).
  LLM_BASE_URL: z.string().url().optional(),
  // API key del provider LLM. SECRETA - nunca commitear.
  LLM_API_KEY: z.string().min(1),
  // Modelo a usar (formato vendor/modelo en OpenRouter, ej. anthropic/claude-sonnet-4-5).
  LLM_MODEL: z.string().default('anthropic/claude-sonnet-4-5'),
  // Max output tokens por turno del LLM.
  LLM_MAX_TOKENS: z.coerce.number().default(4096),
  // Max iteraciones del loop tool_use <-> tool_result por turno.
  LLM_MAX_ITERATIONS: z.coerce.number().default(6),
  // Timeout total por call al LLM (ms).
  LLM_TIMEOUT_MS: z.coerce.number().default(30000),

  // Rate limits del endpoint /admin/mcp/chat por usuario.
  ADMIN_MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().default(30),
  ADMIN_MCP_RATE_LIMIT_PER_DAY: z.coerce.number().default(200),

  // === Sync Onnix (feature #13) ===
  // Feature flag maestro. Con `false` (default) la app arranca SIN las credenciales
  // Onnix y todos los caminos de sync hacen early-return (no cron, no @OnEvent, no
  // drain). Por eso BASE_URL/EMAIL/PASSWORD son `.optional()`: NO pueden romper el
  // boot en dev/CI sin Onnix. La presencia de secretos se valida en runtime al
  // primer uso SOLO cuando el flag esta on (ver OnnixClientService).
  ONNIX_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ONNIX_BASE_URL: z.string().url().optional(),
  ONNIX_EMAIL: z.string().optional(),
  ONNIX_PASSWORD: z.string().optional(),
  // Modo simulacro (opt-in, default false). Con `true` el drenador corre TODO el
  // pipeline (gate org, claim, mapeo, ordering, build del body) pero NO hace el
  // POST real a Onnix: loggea el body resuelto (solo ids de mapeo + slug + traceId)
  // y marca la fila terminal-no-loop. Permite validar el pipeline en produccion sin
  // escribir en Onnix (que no tiene endpoint de borrado). Ortogonal a ENABLED:
  // requiere ENABLED=true para que el pipeline corra.
  ONNIX_SYNC_DRY_RUN: z.string().optional(),
  // Scoping multi-tenant: CSV de org cuids habilitadas para sync Onnix. Opcional;
  // si esta vacia/ausente, el outbox no captura tickets de ninguna organizacion.
  ONNIX_SYNC_ORG_IDS: z.string().optional(),
  // Timeout por call HTTP a Onnix (ms) — molde de MCP_HTTP_TIMEOUT_MS.
  ONNIX_HTTP_TIMEOUT_MS: z.coerce.number().default(15000),
  // Expresion del @Cron del drenador. Default: cada hora en punto (R34).
  // El boton manual cubre lo inmediato. Formato: 6 campos (con segundos).
  ONNIX_SYNC_CRON: z.string().default('0 0 * * * *'),
  // Cap de filas drenadas por ciclo (batch size).
  ONNIX_SYNC_BATCH_SIZE: z.coerce.number().default(50),
  // Cap de reintentos antes de marcar la fila failed (R32).
  ONNIX_SYNC_MAX_ATTEMPTS: z.coerce.number().default(3),
  // Reclamacion de filas in_flight colgadas (ms): un lock mas viejo que esto
  // vuelve a ser elegible (cubre crash entre claim y markSynced).
  ONNIX_SYNC_STALE_LOCK_MS: z.coerce.number().default(120000),
  // TTL del cache de catalogos Onnix (segundos) — R20.
  ONNIX_CATALOG_CACHE_TTL_SEC: z.coerce.number().default(600),
  // Umbral de alerta DLQ por edad del mensaje failed mas viejo (minutos) — R44.
  ONNIX_DLQ_MAX_AGE_MIN: z.coerce.number().default(1440),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten());
    process.exit(1);
  }
  return result.data;
}
