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
