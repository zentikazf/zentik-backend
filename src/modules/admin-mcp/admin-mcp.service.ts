import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Cache } from 'cache-manager';
import { AppConfigService } from '../../config/app.config';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { McpClientService } from './mcp-client.service';
import {
  ILLMProvider,
  LLM_PROVIDER_TOKEN,
  ChatMessage,
  ToolDefinition,
} from './providers/llm-provider.interface';
import { buildSystemPrompt } from './system-prompt';
import { sanitizeToolArgs, summarizeToolArgsForLog } from './lib/sanitize-args';
import { sanitizeChatResponse } from './lib/sanitize-chat-response';
import {
  LlmProviderException,
  MaxIterationsException,
  McpUpstreamException,
} from './errors';

export interface ChatToolCall {
  tool: string;
  args: Record<string, unknown>;
  latencyMs: number;
  ok: boolean;
}

export interface ChatResult {
  reply: string;
  toolCalls: ChatToolCall[];
  traceId: string;
  iterations: number;
}

interface ChatInput {
  user: AuthenticatedUser;
  bearerToken: string;
  /** Historial completo del turno enviado por el frontend. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  traceId: string;
}

/**
 * Orquestador del chat admin-mcp.
 *
 * - cachea tools/list por hash del token (R9).
 * - corre el loop bounded LLM <-> MCP (R8) con max LLM_MAX_ITERATIONS.
 * - registra logs estructurados por fase (R21) sin loggear contenido.
 * - reutiliza el correlationId de la request como traceId (R20) y lo propaga
 *   al MCP y al provider via headers/metadata.
 *
 * Stateless: NO persiste mensajes (R14). Cada turno empieza con el historial
 * que mando el frontend.
 */
@Injectable()
export class AdminMcpChatService {
  private readonly logger = new Logger(AdminMcpChatService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly mcpClient: McpClientService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: ILLMProvider,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async chat(input: ChatInput): Promise<ChatResult> {
    const startTs = Date.now();
    const { user, bearerToken, traceId } = input;
    const tokenHash = this.hashTokenForLog(bearerToken);

    this.logger.log({
      event: 'admin-mcp.chat.start',
      userId: user.id,
      traceId,
      messagesCount: input.messages.length,
      tokenHash,
    });

    try {
      const tools = await this.getToolsList({ bearerToken, traceId });
      // Feature #15 R8 — enriquecer el system prompt con user/org context.
      // El AuthGuard del backend ya pobla `user.organizationIds` (sin
      // take:1); aca lo propagamos al LLM como contexto explicito.
      const systemPrompt = buildSystemPrompt(tools, {
        userId: user.id,
        orgIds: user.organizationIds ?? [],
        clientId: user.clientId ?? null,
      });

      // Historial mutable que se va enriqueciendo con tool_use / tool_result.
      const conversation: ChatMessage[] = input.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const toolCallsSummary: ChatToolCall[] = [];
      const maxIter = this.config.llmMaxIterations;
      let iterations = 0;

      while (iterations < maxIter) {
        iterations += 1;

        const llmStart = Date.now();
        this.logger.log({
          event: 'admin-mcp.llm.call.start',
          traceId,
          userId: user.id,
          model: this.config.llmModel,
          iteration: iterations,
        });

        let llmResp;
        try {
          llmResp = await this.llm.chat({
            system: systemPrompt,
            messages: conversation,
            tools,
            model: this.config.llmModel,
            maxTokens: this.config.llmMaxTokens,
            traceId,
          });
        } catch (err) {
          this.logger.warn({
            event: 'admin-mcp.llm.call.error',
            traceId,
            userId: user.id,
            iteration: iterations,
            latencyMs: Date.now() - llmStart,
          });
          if (err instanceof LlmProviderException) throw err;
          throw new LlmProviderException(this.llm.name);
        }

        this.logger.log({
          event: 'admin-mcp.llm.call.end',
          traceId,
          userId: user.id,
          iteration: iterations,
          latencyMs: Date.now() - llmStart,
          model: this.config.llmModel,
          outputType: llmResp.type,
        });

        if (llmResp.type === 'text') {
          // Respuesta final del LLM. Cerramos.
          this.logger.log({
            event: 'admin-mcp.chat.end',
            traceId,
            userId: user.id,
            totalLatencyMs: Date.now() - startTs,
            iterations,
            toolCallsCount: toolCallsSummary.length,
          });

          // Feature admin-mcp-chat-ux-hardening T4 — sanitizar reply final
          // (CUIDs, nombres de tools, disclaimers scoping) ANTES de retornar.
          // NO se aplica a iteraciones intermedias: el LLM necesita ver los
          // CUIDs internamente para razonar y llamar tools correctamente.
          const reply = llmResp.content || '';
          const { sanitized, filtersApplied } = sanitizeChatResponse(reply);
          if (filtersApplied.length > 0) {
            this.logger.warn({
              event: 'admin-mcp.chat.degraded',
              traceId,
              model: this.config.llmModel,
              filtersCount: filtersApplied.length,
              filterTypes: filtersApplied,
            });
          }

          return {
            reply: sanitized,
            toolCalls: toolCallsSummary,
            traceId,
            iterations,
          };
        }

        // tool_use: agregar el assistant message con tool_calls al historial.
        conversation.push({
          role: 'assistant',
          content: llmResp.content ?? '',
          toolCallsRequested: llmResp.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: tc.args,
          })),
        });

        // Ejecutar cada tool secuencialmente y append tool messages.
        for (const tc of llmResp.toolCalls) {
          const toolStart = Date.now();
          // Feature #15 R34 — NO loggear args crudo (puede contener PII).
          // Solo keys top-level + sus tipos para auditabilidad estructural.
          const argsSummary = summarizeToolArgsForLog(tc.args);
          this.logger.log({
            event: 'admin-mcp.tool.call.start',
            traceId,
            userId: user.id,
            iteration: iterations,
            tool: tc.name,
            argsKeys: argsSummary.argsKeys,
            argsTypes: argsSummary.argsTypes,
          });

          let toolOk = false;
          let toolResultPayload: unknown = null;
          let toolErrorMessage: string | null = null;

          try {
            const callResult = await this.mcpClient.callTool({
              bearerToken,
              traceId,
              name: tc.name,
              args: tc.args,
            });
            if (callResult.ok) {
              toolOk = true;
              toolResultPayload = callResult.content;
            } else {
              toolOk = false;
              toolErrorMessage = callResult.message;
            }
          } catch (err) {
            // Errores de transporte/upstream del MCP: dejamos que se propaguen
            // al cliente como McpUpstreamException via filter (R10).
            this.logger.warn({
              event: 'admin-mcp.tool.call.error',
              traceId,
              userId: user.id,
              iteration: iterations,
              tool: tc.name,
              latencyMs: Date.now() - toolStart,
            });
            if (err instanceof McpUpstreamException) throw err;
            // Fallback: tratar como upstream 502 generico.
            throw new McpUpstreamException(502, 'tool-call-failed');
          }

          const latencyMs = Date.now() - toolStart;
          this.logger.log({
            event: 'admin-mcp.tool.call.end',
            traceId,
            userId: user.id,
            iteration: iterations,
            tool: tc.name,
            // Misma redaccion estructural que el .start (R34).
            argsKeys: argsSummary.argsKeys,
            argsTypes: argsSummary.argsTypes,
            latencyMs,
            ok: toolOk,
          });

          // Feature #15 R33 — sanitizar args antes de serializar al frontend.
          // El frontend muestra el desglose de tool_calls; cualquier email/
          // phone/token/secret que el LLM haya pasado se redacta a
          // "[redacted]" preservando el shape del objeto.
          toolCallsSummary.push({
            tool: tc.name,
            args: sanitizeToolArgs(tc.args),
            latencyMs,
            ok: toolOk,
          });

          conversation.push({
            role: 'tool',
            content: '',
            toolUseId: tc.id,
            toolName: tc.name,
            toolResult: toolOk ? toolResultPayload : toolErrorMessage,
            isError: !toolOk,
          });
        }
      }

      // Loop alcanzo el cap sin respuesta final: NO es error tecnico, devolvemos
      // mensaje funcional (Decision 5). Loggear y traducir a ChatResult.
      this.logger.warn({
        event: 'admin-mcp.loop.maxIterations',
        traceId,
        userId: user.id,
        iterations,
      });
      throw new MaxIterationsException(iterations);
    } catch (err) {
      if (err instanceof MaxIterationsException) {
        // Devolver respuesta funcional en lugar de error HTTP.
        return {
          reply: err.message,
          toolCalls: [],
          traceId,
          iterations: err.iterations,
        };
      }
      // Re-throw para que el GlobalExceptionFilter mapee.
      throw err;
    }
  }

  /**
   * Cache de tools/list con TTL 5 min (MCP_TOOLS_CACHE_TTL_SEC).
   * Clave: hash sha256(token).slice(0,16). Aisla por usuario (R9).
   */
  private async getToolsList(opts: {
    bearerToken: string;
    traceId: string;
  }): Promise<ToolDefinition[]> {
    const key = `mcp:tools:list:${this.hashTokenForLog(opts.bearerToken)}`;
    const ttlMs = this.config.mcpToolsCacheTtlSec * 1000;

    const cached = await this.cache.get<ToolDefinition[]>(key);
    if (cached) {
      this.logger.log({
        event: 'admin-mcp.tools.list.end',
        traceId: opts.traceId,
        cacheHit: true,
        latencyMs: 0,
        toolsCount: cached.length,
      });
      return cached;
    }

    const start = Date.now();
    this.logger.log({
      event: 'admin-mcp.tools.list.start',
      traceId: opts.traceId,
      cacheHit: false,
    });

    let tools: ToolDefinition[];
    try {
      tools = await this.mcpClient.listTools(opts);
    } catch (err) {
      this.logger.warn({
        event: 'admin-mcp.tools.list.error',
        traceId: opts.traceId,
        latencyMs: Date.now() - start,
      });
      throw err;
    }

    this.logger.log({
      event: 'admin-mcp.tools.list.end',
      traceId: opts.traceId,
      cacheHit: false,
      latencyMs: Date.now() - start,
      toolsCount: tools.length,
    });

    await this.cache.set(key, tools, ttlMs);
    return tools;
  }

  /**
   * Hash truncado del token para logs. NUNCA loggeamos el token completo.
   */
  private hashTokenForLog(token: string): string {
    if (!token) return 'no-token';
    return createHash('sha256').update(token).digest('hex').slice(0, 16);
  }
}
