import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SlaConfigController } from './sla-config.controller';
import { SlaContractService } from './sla-contract.service';
import { SlaPolicyService } from './sla-policy.service';
import { SlaResolverService } from './sla-resolver.service';
import { SlaSeedService } from './sla-seed.service';
import { TicketTypeService } from './ticket-type.service';

/**
 * Motor de SLA con políticas nombradas y cascada (feature #42 — Fase 1).
 *
 * ⛔ REGLA DURA (arch-avoid-circular-deps): `SlaModule` NO importa `TicketModule`
 * ni `PortalModule`. La dependencia es unidireccional: ticket/portal importan
 * `SlaModule` y consumen SOLO `SlaResolverService`. El motor de horas hábiles
 * (`ticket/sla.util.ts`) se usa importando la FUNCIÓN pura, no el módulo — por eso
 * no hay ciclo (su mudanza a este módulo es cleanup de Fase 3).
 *
 * ⚠️ Los guards se registran como PROVIDERS locales en vez de importar `AuthModule`
 * (que es el molde de `AdminMcpModule`): `AuthModule` importa `TicketModule`, y
 * `TicketModule` importa este módulo → importar `AuthModule` acá cerraría el ciclo
 * `Auth → Ticket → Sla → Auth`. `AuthGuard`/`RolesGuard` son stateless y sus
 * dependencias (`PrismaService`, `AppConfigService`, `Reflector`) son globales, así
 * que una segunda instancia en este contexto se comporta idéntico. La alternativa
 * (`forwardRef`) escondería el ciclo en vez de evitarlo.
 */
@Module({
  imports: [PrismaModule],
  controllers: [SlaConfigController],
  providers: [
    AuthGuard,
    RolesGuard,
    SlaPolicyService,
    TicketTypeService,
    SlaContractService,
    SlaResolverService,
    SlaSeedService,
  ],
  exports: [SlaResolverService],
})
export class SlaModule {}
