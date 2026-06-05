/**
 * Interface ILLMProvider + tipos compartidos del modulo admin-mcp.
 *
 * Adapter pattern: cualquier provider (OpenRouter, DeepSeek, OpenAI, Qwen,
 * Anthropic nativo en el futuro) implementa esta interface. El service
 * orquestador solo conoce ILLMProvider, no el adapter concreto.
 *
 * Decision 11 (design.md): el adapter inicial es OpenAICompatibleProvider
 * basado en el SDK `openai`. Para agregar uno nuevo: crear archivo en
 * `providers/` y registrarlo en `llm-provider.factory.ts`. Sin tocar el
 * service.
 */

export type ChatRole = 'user' | 'assistant' | 'tool';

/**
 * Mensaje de la conversacion. El service lo serializa y lo manda al provider
 * en formato OpenAI-compatible (tool_calls / tool messages estilo OpenAI).
 *
 * Cuando role='assistant' y el modelo invoca tools, `toolCallsRequested`
 * contiene la lista. Cuando role='tool', `toolUseId`/`toolName`/`toolResult`
 * llevan el resultado de una tool ejecutada.
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  // Solo en role='assistant' cuando el modelo decide invocar tools.
  toolCallsRequested?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  // Solo en role='tool' (resultado).
  toolUseId?: string;
  toolName?: string;
  toolResult?: unknown;
  isError?: boolean;
}

/**
 * Definicion de una tool en formato neutro (JSON Schema crudo). El adapter
 * la traduce al formato propietario del provider.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMChatInput {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  model: string;
  maxTokens: number;
  traceId: string;
  signal?: AbortSignal;
}

export type LLMChatOutput =
  | {
      type: 'text';
      content: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | {
      type: 'tool_use';
      toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
      // Texto opcional que el modelo emitio JUNTO a las tool_use (puede acompanarlo).
      content?: string;
      usage?: { inputTokens: number; outputTokens: number };
    };

export interface ILLMProvider {
  /** Identificador del provider (ej. 'openrouter', 'deepseek'). NO loggear API key. */
  readonly name: string;
  chat(input: LLMChatInput): Promise<LLMChatOutput>;
}

/** Token DI para inyectar la instancia activa del provider en el service. */
export const LLM_PROVIDER_TOKEN = 'LLM_PROVIDER_TOKEN';
