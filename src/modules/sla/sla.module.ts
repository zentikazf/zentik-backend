import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CriticalityConfigService } from './criticality-config.service';
import { SlaConfigController } from './sla-config.controller';
import { SlaContractService } from './sla-contract.service';
import { SlaPolicyService } from './sla-policy.service';
import { SlaResolverService } from './sla-resolver.service';
import { SlaSeedService } from './sla-seed.service';
import { TicketTypeAvailabilityService } from './ticket-type-availability.service';
import { TicketTypeService } from './ticket-type.service';

/**
 * Motor de SLA con políticas nombradas y cascada (feature #42 — Fase 1).
 *
 * ⛔ REGLA DURA (arch-avoid-circular-deps): `SlaModule` NO importa `TicketModule`
 * ni `PortalModule`. La dependencia es unidireccional: ticket/portal importan
 * `SlaModule` y consumen SOLO `SlaResolverService`.
 *
 * 🧹 Cleanup de Fase 3 (decisión 2C, diferida desde Fase 1): el motor de horas
 * hábiles `sla.util.ts` YA VIVE ACÁ — se mudó desde `ticket/` y los 6 consumidores
 * apuntan a `sla/sla.util`. Es un util PURO (funciones sin estado, no un provider),
 * así que mudarlo no crea ninguna dependencia entre módulos.
 *
 * ⚠️ EXCEPCIÓN DELIBERADA: `sla-cron.service.ts` **NO se mudó** y sigue en
 * `TicketModule`. Depende de `TicketEventsService` para persistir los `TicketEvent`
 * de breach; traerlo acá obligaría a `SlaModule` a importar algo de `ticket`, y como
 * `TicketModule` ya importa `SlaModule`, cerraría el ciclo `Sla → Ticket → Sla`.
 * Mover el cron solo tendría valor cosmético y el costo sería un ciclo real o un
 * `forwardRef` que lo esconde. Se evaluó explícitamente y se decidió dejarlo.
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
    CriticalityConfigService,
    TicketTypeAvailabilityService,
  ],
  // Fase 2: `portal` consume la config de criticidad y la disponibilidad de tipos
  // para validar server-side lo que manda el cliente. Sigue siendo unidireccional.
  exports: [SlaResolverService, CriticalityConfigService, TicketTypeAvailabilityService],
})
export class SlaModule {}
