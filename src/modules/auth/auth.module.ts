import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuthSocketListener } from './auth-socket.listener';
import { OrganizationModule } from '../organization/organization.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { ChatModule } from '../chat/chat.module';
import { TicketModule } from '../ticket/ticket.module';
import { SessionValidityModule } from './session-validity.module';

@Module({
  // ChatModule + TicketModule: exponen sus gateways para que AuthSocketListener
  // cierre los sockets vivos al logout/revoke (R4). Ninguno importa AuthModule,
  // asi que no hay ciclo en el grafo de modulos.
  // SessionValidityModule (#19 ALTO-2): disponibilidad futura del AuthGuard para
  // revalidar la sesion en requests REST (no usado todavia, importado segun spec).
  imports: [
    OrganizationModule,
    OnboardingModule,
    ChatModule,
    TicketModule,
    SessionValidityModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, RolesGuard, AuthSocketListener],
  exports: [AuthService, AuthGuard, RolesGuard],
})
export class AuthModule {}
