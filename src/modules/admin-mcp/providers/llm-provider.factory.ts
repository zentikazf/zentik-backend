import { AppConfigService } from '../../../config/app.config';
import { ILLMProvider } from './llm-provider.interface';
import { OpenAICompatibleProvider } from './openai-compatible.provider';

/**
 * Factory del provider LLM activo.
 *
 * Lee `LLM_PROVIDER` del config y construye el adapter concreto. Hoy todos
 * los providers soportados (`openrouter`, `deepseek`, `openai`, `qwen`) usan
 * la misma implementacion (`OpenAICompatibleProvider`) con distinto `baseURL`.
 *
 * Si el LLM_BASE_URL no se setea explicitamente en env, el factory aplica el
 * default conocido por provider (Decision 11 de design.md).
 *
 * Bootstrap-fail: si el provider es desconocido o la API key esta vacia,
 * lanza Error y el modulo no levanta. Es deliberado (R7).
 */

const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

export function createLlmProvider(config: AppConfigService): ILLMProvider {
  const providerKey = config.llmProvider;

  if (!PROVIDER_DEFAULT_BASE_URLS[providerKey]) {
    throw new Error(
      `LLM_PROVIDER desconocido: "${providerKey}". Valores soportados: ${Object.keys(
        PROVIDER_DEFAULT_BASE_URLS,
      ).join(', ')}.`,
    );
  }

  const apiKey = config.llmApiKey;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('LLM_API_KEY esta vacia o ausente. Configurala en .env antes de bootstrap.');
  }

  const baseURL = config.llmBaseUrl ?? PROVIDER_DEFAULT_BASE_URLS[providerKey];

  return new OpenAICompatibleProvider({
    apiKey,
    baseURL,
    providerName: providerKey,
    timeoutMs: config.llmTimeoutMs,
    defaultModel: config.llmModel,
    defaultMaxTokens: config.llmMaxTokens,
  });
}
