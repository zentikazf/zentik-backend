import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app.config';
import { ToolDefinition } from './providers/llm-provider.interface';
import { McpUpstreamException } from './errors';

/**
 * Cliente HTTP para el MCP de Zentik (`zentik-mcp`).
 *
 * Wire format: JSON-RPC 2.0 sobre HTTP, transporte MCP "streamable HTTP".
 * El MCP usa StreamableHTTPServerTransport y, segun el Accept, responde
 * application/json o text/event-stream. Pedimos JSON puro para single-shot
 * tool calls (no SSE en v1).
 *
 * Seguridad/observabilidad:
 * - Propaga el session token del usuario como `Authorization: Bearer ...`
 *   sin transformar (Decision 2 de design.md).
 * - Propaga `X-Trace-Id` con el correlationId del backend (R20).
 * - Timeout duro por call (MCP_HTTP_TIMEOUT_MS) via AbortController.
 * - NUNCA loggea contenido del response ni del request — solo metadata.
 * - Mapea no-2xx a McpUpstreamException con status original (R10).
 */

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface ListToolsResult {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

interface CallToolResult {
  content: Array<{ type: string; text?: string; data?: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

@Injectable()
export class McpClientService {
  private readonly logger = new Logger(McpClientService.name);
  private requestSeq = 0;

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  /**
   * Lista las tools del MCP. Hace JSON-RPC `tools/list`.
   * Antes de poder hablar con el MCP hay que `initialize` segun el protocolo,
   * pero el transport stateless del MCP acepta cada request como independiente
   * para tools/list y tools/call cuando NO hay session id — el MCP server lo
   * documenta como aceptado.
   */
  async listTools(opts: { bearerToken: string; traceId: string }): Promise<ToolDefinition[]> {
    const result = await this.rpcCall<ListToolsResult>(
      'tools/list',
      {},
      opts.bearerToken,
      opts.traceId,
    );

    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
    }));
  }

  /**
   * Invoca una tool. Devuelve `{ ok: true, content }` con el texto/payload
   * concatenado, o `{ ok: false, isError, message }` si el MCP marca isError.
   * Errores de transporte (no-2xx, timeout) suben como McpUpstreamException.
   */
  async callTool(opts: {
    bearerToken: string;
    traceId: string;
    name: string;
    args: Record<string, unknown>;
  }): Promise<
    | { ok: true; content: unknown }
    | { ok: false; isError: true; message: string }
  > {
    const result = await this.rpcCall<CallToolResult>(
      'tools/call',
      {
        name: opts.name,
        arguments: opts.args,
      },
      opts.bearerToken,
      opts.traceId,
    );

    const text = this.extractTextContent(result);

    if (result.isError) {
      return { ok: false, isError: true, message: text || 'Tool returned error' };
    }

    return {
      ok: true,
      content: result.structuredContent ?? text ?? result.content,
    };
  }

  private extractTextContent(result: CallToolResult): string {
    if (!result?.content || !Array.isArray(result.content)) return '';
    return result.content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
  }

  /**
   * Wrapper de un round-trip JSON-RPC al MCP.
   * - Timeout via AbortController.
   * - Maneja respuestas SSE devueltas por StreamableHTTPServerTransport:
   *   parsea el bloque `data: {...}` cuando el content-type es text/event-stream.
   */
  private async rpcCall<T>(
    method: string,
    params: Record<string, unknown>,
    bearerToken: string,
    traceId: string,
  ): Promise<T> {
    if (!bearerToken) {
      // Sin token, no hay caso: el MCP responde 401 y el cliente leakearia ruido.
      throw new McpUpstreamException(401, 'missing-bearer');
    }

    this.requestSeq = (this.requestSeq + 1) % Number.MAX_SAFE_INTEGER;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: this.requestSeq,
      method,
      params,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.mcpHttpTimeoutMs);

    let response: Response;
    try {
      response = await fetch(this.config.mcpBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${bearerToken}`,
          'X-Trace-Id': traceId,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort =
        (err as { name?: string } | null)?.name === 'AbortError';
      this.logger.warn(
        `MCP transport error method=${method} traceId=${traceId} abort=${isAbort}`,
      );
      // Network/timeout/abort: tratar como upstream 502/504.
      throw new McpUpstreamException(isAbort ? 504 : 502, isAbort ? 'timeout' : 'network');
    }
    clearTimeout(timer);

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      this.logger.warn(
        `MCP upstream non-2xx method=${method} traceId=${traceId} status=${response.status}`,
      );
      throw new McpUpstreamException(
        response.status,
        undefined,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const rawText = await response.text();

    let parsed: JsonRpcResponse<T>;
    if (contentType.includes('text/event-stream')) {
      // SSE: extraer la ultima linea `data: {...}`.
      const dataPayload = this.extractSseLastData(rawText);
      if (!dataPayload) {
        throw new McpUpstreamException(502, 'sse-no-data');
      }
      try {
        parsed = JSON.parse(dataPayload) as JsonRpcResponse<T>;
      } catch {
        throw new McpUpstreamException(502, 'sse-malformed');
      }
    } else {
      try {
        parsed = JSON.parse(rawText) as JsonRpcResponse<T>;
      } catch {
        throw new McpUpstreamException(502, 'json-malformed');
      }
    }

    if (parsed.error) {
      // Mapeo JSON-RPC error -> upstream. Codigos JSON-RPC negativos se tratan
      // como 502 al cliente; el error.message NUNCA viaja al frontend (queda en logs).
      this.logger.warn(
        `MCP rpc error method=${method} traceId=${traceId} code=${parsed.error.code}`,
      );
      throw new McpUpstreamException(502, `rpc:${parsed.error.code}`);
    }

    if (parsed.result === undefined) {
      throw new McpUpstreamException(502, 'rpc-empty-result');
    }
    return parsed.result;
  }

  private extractSseLastData(raw: string): string | null {
    const lines = raw.split(/\r?\n/);
    let lastData: string | null = null;
    for (const line of lines) {
      if (line.startsWith('data:')) {
        lastData = line.slice(5).trim();
      }
    }
    return lastData;
  }
}
