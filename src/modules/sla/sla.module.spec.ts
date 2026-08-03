import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../config/config.module';
import { EmailModule } from '../../infrastructure/email/email.module';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { PortalModule } from '../portal/portal.module';
import { PortalService } from '../portal/portal.service';
import { TicketModule } from '../ticket/ticket.module';
import { TicketService } from '../ticket/ticket.service';
import { SlaModule } from './sla.module';
import { SlaResolverService } from './sla-resolver.service';

/**
 * Chequeo del GRAFO DE MÓDULOS del feature #42 (Fase 1).
 *
 * Guarda el ítem "SlaModule registrado, SIN ciclos" del checklist del blueprint:
 * `AuthModule` importa `TicketModule` y `TicketModule` importa `SlaModule`, así que
 * si alguien agrega `AuthModule` a los imports de `SlaModule` se cierra el ciclo
 * `Auth → Ticket → Sla → Auth` y la app NO arranca. `tsc` no lo detecta y ningún
 * spec con Prisma mockeado tampoco: solo `Test.createTestingModule(...).compile()`.
 *
 * `.compile()` NO ejecuta `onModuleInit` → no abre conexiones a Postgres.
 */

// RedisService extiende ioredis y CONECTA en el constructor → stub global para que
// el chequeo de DI no abra sockets.
@Global()
@Module({
  providers: [{ provide: RedisService, useValue: {} }],
  exports: [RedisService],
})
class FakeRedisModule {}

const baseImports = [
  ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
  EventEmitterModule.forRoot(),
  ScheduleModule.forRoot(),
  AppConfigModule,
  FakeRedisModule,
];

describe('DI check', () => {
  it('SlaModule compila', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [...baseImports, SlaModule],
    }).compile();
    expect(moduleRef.get(SlaResolverService)).toBeDefined();
  });

  it('TicketModule + SlaModule compilan juntos', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [...baseImports, TicketModule],
    }).compile();
    expect(moduleRef.get(TicketService)).toBeDefined();
  });

  it('PortalModule + SlaModule compilan juntos', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [...baseImports, EmailModule, StorageModule, PortalModule],
    }).compile();
    expect(moduleRef.get(PortalService)).toBeDefined();
  });
});
