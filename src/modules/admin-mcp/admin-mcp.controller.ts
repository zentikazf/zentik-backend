import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AppConfigService } from '../../config/app.config';
import { CurrentUser } from '../../common/decorators';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/interfaces/request.interface';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminMcpChatService } from './admin-mcp.service';
import { ChatInputDto } from './dto/chat-input.dto';
import { ChatOutputDto } from './dto/chat-output.dto';

const SESSION_COOKIE_PRIMARY = 'zentik.session_token';
const SESSION_COOKIE_LEGACY_1 = 'better-auth.session_token';
const SESSION_COOKIE_LEGACY_2 = '__Secure-better-auth.session_token';

/**
 * Controller del chat admin-mcp.
 *
 * - Endpoint: POST /api/v1/admin/mcp/chat (prefix global aplicado en main.ts).
 * - Guards: AuthGuard (R2) + RolesGuard restringido a Owner / Project Manager / Developer (R3).
 * - Validacion: ValidationPipe global + ChatInputDto (R4, R13).
 * - Rate limit: 30/min y 200/dia (R12), namespaceado por IP por default
 *   (anomalia documentada: ver design Decision 8 — IP-tracker para v1).
 *
 * Decision 1 (design.md): NO requerimos header custom. Reutilizamos el session
 * token de la cookie/header Authorization. El controller lo extrae con la misma
 * logica que AuthController::extractSessionToken y lo pasa al service para
 * propagarlo al MCP como Bearer.
 */
@ApiTags('Admin MCP')
@ApiBearerAuth()
@Controller('admin/mcp')
@UseGuards(AuthGuard, RolesGuard)
@Roles('Owner', 'Project Manager', 'Developer')
export class AdminMcpController {
  constructor(
    private readonly chatService: AdminMcpChatService,
    private readonly config: AppConfigService,
  ) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    // Limites dinamicos: TTL hard-coded (ms) pero el `limit` viene de env.
    // @nestjs/throttler v6 acepta un objeto con multiples namespaces.
    short: {
      ttl: 60_000,
      limit: Number(process.env.ADMIN_MCP_RATE_LIMIT_PER_MINUTE ?? 30),
    },
    long: {
      ttl: 86_400_000,
      limit: Number(process.env.ADMIN_MCP_RATE_LIMIT_PER_DAY ?? 200),
    },
  })
  @ApiOperation({
    summary: 'Chat con el asistente Zentik MCP',
    description:
      'Procesa un turno conversacional. El backend orquesta el loop LLM <-> MCP y devuelve la respuesta final batch JSON.',
  })
  @ApiResponse({ status: 200, description: 'Respuesta del asistente', type: ChatOutputDto })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado' })
  @ApiResponse({ status: 422, description: 'Datos de entrada invalidos' })
  @ApiResponse({ status: 429, description: 'Limite de consultas alcanzado' })
  @ApiResponse({ status: 502, description: 'MCP o LLM no disponible' })
  async chat(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChatInputDto,
  ): Promise<ChatOutputDto> {
    const bearerToken = this.extractSessionToken(req);
    const traceId = this.extractTraceId(req);

    const result = await this.chatService.chat({
      user,
      bearerToken,
      messages: dto.messages,
      traceId,
    });

    return {
      reply: result.reply,
      toolCalls: result.toolCalls,
      traceId: result.traceId,
      iterations: result.iterations,
    };
  }

  /**
   * Extrae el session token del request. Misma logica que
   * AuthController::extractSessionToken para reuse coherente:
   * 1. Authorization: Bearer ...
   * 2. cookie zentik.session_token (preferida)
   * 3. cookies better-auth legacy.
   *
   * NO se centraliza en auth.utils porque la implementacion ya es identica
   * y mover el helper exigiria importar de auth dentro de admin-mcp.module.
   * Documentado como anomalia.
   */
  private extractSessionToken(req: AuthenticatedRequest): string {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};
    return (
      cookies[SESSION_COOKIE_PRIMARY] ||
      cookies[SESSION_COOKIE_LEGACY_1] ||
      cookies[SESSION_COOKIE_LEGACY_2] ||
      ''
    );
  }

  /**
   * Reusa el correlationId del CorrelationIdMiddleware como traceId end-to-end.
   * Si por alguna razon el middleware no lo seteo, fallback al header crudo.
   */
  private extractTraceId(req: AuthenticatedRequest): string {
    const fromReq = (req as unknown as { correlationId?: string }).correlationId;
    if (fromReq) return fromReq;
    const header = req.headers['x-correlation-id'];
    if (typeof header === 'string') return header;
    if (Array.isArray(header) && header.length > 0) return header[0];
    return 'no-trace';
  }
}
