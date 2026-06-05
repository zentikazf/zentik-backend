import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app.config';
import { AuthModule } from '../auth/auth.module';
import { AdminMcpController } from './admin-mcp.controller';
import { AdminMcpChatService } from './admin-mcp.service';
import { McpClientService } from './mcp-client.service';
import { createLlmProvider } from './providers/llm-provider.factory';
import { LLM_PROVIDER_TOKEN } from './providers/llm-provider.interface';

/**
 * Modulo del chat admin-mcp (feature #8).
 *
 * - Importa AuthModule para reusar AuthGuard + RolesGuard (NO duplicarlos).
 * - Importa CacheModule local (no global) con `max=100` y TTL controlado por
 *   `cache.set(key, value, ttlMs)` por entry. Default ttl no se setea aca
 *   porque cada entry decide su TTL (R9).
 * - Registra el LLM provider via factory; bootstrap-fails si LLM_PROVIDER es
 *   desconocido o LLM_API_KEY esta vacia (R7).
 *
 * NO toca el ThrottlerModule global del AppModule — usa @Throttle decorators
 * por endpoint en el controller (Decision 8 de design.md).
 */
@Module({
  imports: [
    AuthModule,
    CacheModule.register({
      max: 100,
    }),
  ],
  controllers: [AdminMcpController],
  providers: [
    AdminMcpChatService,
    McpClientService,
    {
      provide: LLM_PROVIDER_TOKEN,
      useFactory: (config: AppConfigService) => createLlmProvider(config),
      inject: [AppConfigService],
    },
  ],
  exports: [AdminMcpChatService],
})
export class AdminMcpModule {}
