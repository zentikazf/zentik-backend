import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  ChatMessage,
  ILLMProvider,
  LLMChatInput,
  LLMChatOutput,
} from './llm-provider.interface';
import { LlmProviderException } from '../errors';

/**
 * Adapter unico OpenAI-compatible. Sirve para OpenRouter, DeepSeek directo,
 * OpenAI y Qwen via DashScope. Cambiar de provider = cambiar `baseURL` +
 * `model` (sin nuevo codigo).
 *
 * Decision 11 (design.md): preferimos esto sobre `@anthropic-ai/sdk` porque
 * OpenRouter expone Claude (y otros) via wire format de OpenAI, asi que un
 * solo adapter cubre los 4 providers soportados.
 *
 * Seguridad:
 * - NUNCA loggea `apiKey` ni el contenido raw de los mensajes.
 * - Mapeo defensivo de errores a LlmProviderException (mensaje generico al cliente).
 */

interface OpenAICompatibleProviderOpts {
  apiKey: string;
  baseURL: string;
  /** Identificador del provider para logs/factory (ej. 'openrouter'). */
  providerName: string;
  /** Timeout total por call al provider (ms). */
  timeoutMs: number;
  /** Modelo por default si LLMChatInput.model viene vacio. */
  defaultModel: string;
  /** Max tokens por default. */
  defaultMaxTokens: number;
}

export class OpenAICompatibleProvider implements ILLMProvider {
  public readonly name: string;
  private readonly logger = new Logger(OpenAICompatibleProvider.name);
  private readonly client: OpenAI;
  private readonly opts: OpenAICompatibleProviderOpts;

  constructor(opts: OpenAICompatibleProviderOpts) {
    this.opts = opts;
    this.name = opts.providerName;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      maxRetries: 0, // controlamos retries arriba (en el loop del service)
    });
  }

  async chat(input: LLMChatInput): Promise<LLMChatOutput> {
    const messages = this.buildMessages(input);
    const tools = this.buildTools(input);
    const model = input.model || this.opts.defaultModel;
    const maxTokens = input.maxTokens || this.opts.defaultMaxTokens;

    try {
      const completion = await this.client.chat.completions.create(
        {
          model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? 'auto' : undefined,
          max_tokens: maxTokens,
          // No streaming en v1 (Decision 4).
          stream: false,
        },
        {
          signal: input.signal,
          // Propagar traceId para correlacion en logs del provider que lo soporten.
          headers: { 'X-Trace-Id': input.traceId },
        },
      );

      const choice = completion.choices[0];
      if (!choice || !choice.message) {
        throw new LlmProviderException(this.name, 'Respuesta sin choices');
      }

      const message = choice.message;
      const toolCalls = message.tool_calls ?? [];
      const usage = completion.usage
        ? {
            inputTokens: completion.usage.prompt_tokens ?? 0,
            outputTokens: completion.usage.completion_tokens ?? 0,
          }
        : undefined;

      if (toolCalls.length > 0) {
        // El modelo decidio invocar tools.
        const parsed = toolCalls
          .filter((tc) => tc.type === 'function')
          .map((tc) => {
            let args: Record<string, unknown> = {};
            const rawArgs = tc.function.arguments ?? '';
            try {
              args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
            } catch {
              // Si el modelo devuelve args malformados, lo dejamos como {} y dejamos
              // que el MCP rechace con isError — recupera el loop por si mismo.
              args = {};
            }
            return { id: tc.id, name: tc.function.name, args };
          });

        return {
          type: 'tool_use',
          toolCalls: parsed,
          content: message.content ?? undefined,
          usage,
        };
      }

      // Respuesta de texto pura.
      return {
        type: 'text',
        content: message.content ?? '',
        usage,
      };
    } catch (error) {
      // No re-lanzar LlmProviderException internamente si ya viene.
      if (error instanceof LlmProviderException) throw error;

      // NUNCA exponer mensaje original. Loggear hash-friendly y lanzar generico.
      const isAbort =
        (error as { name?: string } | null)?.name === 'AbortError' ||
        (error as { name?: string } | null)?.name === 'TimeoutError';
      this.logger.warn(
        `LLM provider error: provider=${this.name} abort=${isAbort} message=${this.safeErrorTag(error)}`,
      );
      throw new LlmProviderException(this.name, this.safeErrorTag(error));
    }
  }

  /**
   * Traduce nuestros ChatMessage[] al formato OpenAI Chat Completions.
   * - system viene como primer mensaje siempre.
   * - role=tool se mapea a { role: 'tool', tool_call_id, content }.
   * - role=assistant con toolCallsRequested se mapea a assistant + tool_calls.
   */
  private buildMessages(input: LLMChatInput): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.system },
    ];

    for (const msg of input.messages) {
      if (msg.role === 'user') {
        out.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCallsRequested && msg.toolCallsRequested.length > 0) {
          out.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCallsRequested.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args ?? {}),
              },
            })),
          });
        } else {
          out.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool') {
        out.push({
          role: 'tool',
          tool_call_id: msg.toolUseId ?? '',
          content: this.serializeToolResult(msg),
        });
      }
    }

    return out;
  }

  private buildTools(input: LLMChatInput): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return input.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
  }

  private serializeToolResult(msg: ChatMessage): string {
    const payload = msg.isError
      ? { error: typeof msg.toolResult === 'string' ? msg.toolResult : msg.toolResult ?? 'error' }
      : { result: msg.toolResult ?? null };
    try {
      return JSON.stringify(payload);
    } catch {
      // Defensive: si hay un ciclo o algo raro, devolvemos string vacio.
      return JSON.stringify({ error: 'tool_result_serialization_failed' });
    }
  }

  /** Devuelve solo el nombre/codigo del error (sin payload) para log. */
  private safeErrorTag(error: unknown): string {
    if (!error) return 'unknown';
    if (error instanceof Error) return error.name ?? 'Error';
    return 'unknown';
  }
}
