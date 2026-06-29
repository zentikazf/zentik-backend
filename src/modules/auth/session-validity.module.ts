import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { SessionValidityService } from './session-validity.service';

/**
 * SessionValidityModule — modulo autonomo que expone `SessionValidityService`
 * (#19 ALTO-2). Solo importa `PrismaModule` para garantizar CERO dependencia
 * circular: lo importan `ChatModule`, `TicketModule` y `AuthModule` sin que
 * ninguno de ellos vuelva a este. AuthModule lo importa para disponibilidad
 * futura del AuthGuard (revalidacion de sesion en requests REST).
 */
@Module({
  imports: [PrismaModule],
  providers: [SessionValidityService],
  exports: [SessionValidityService],
})
export class SessionValidityModule {}
