import { Controller, Get, INestApplication, Injectable, CanActivate, ExecutionContext, Param, UseGuards } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

/**
 * #68 F1b — LA PREMISA DEL FIX, verificada de verdad y no asumida.
 *
 * El arreglo real del membership primario consiste en resolver los permisos contra el `:orgId`
 * de la URL, dentro de `AuthGuard`. Todo eso se apoya en una sola cosa: que `request.params` esté
 * poblado CUANDO CORRE EL GUARD. Si no lo estuviera, el guard leería `undefined` y caería siempre
 * al fallback — o sea que el fix no arreglaría nada y nadie se enteraría, porque no falla: elige
 * mal en silencio.
 *
 * No hay precedente en el repo: `grep params src/**\/*.guard.ts` no devuelve nada. Y es
 * exactamente el tipo de suposición que conviene no hacer, porque la respuesta depende de DONDE
 * se registra el guard: los globales (APP_GUARD) corren en un punto del pipeline distinto que los
 * de controller. Este archivo levanta un Nest real con las dos variantes y mide.
 *
 * Si alguna vez `AuthGuard` pasa a registrarse como APP_GUARD, este archivo dice si el fix sigue
 * en pie.
 */
describe('#68 — request.params dentro de un guard', () => {
  const visto: Record<string, unknown> = {};

  @Injectable()
  class GuardDeControlador implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      visto.controlador = context.switchToHttp().getRequest().params;
      return true;
    }
  }

  @Injectable()
  class GuardGlobal implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      visto.global = context.switchToHttp().getRequest().params;
      return true;
    }
  }

  @Controller()
  class ControladorDePrueba {
    @Get('organizations/:orgId/clients/:clientId')
    @UseGuards(GuardDeControlador)
    handler(@Param('orgId') orgId: string) {
      return { orgId };
    }
  }

  let app: INestApplication;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [ControladorDePrueba],
      providers: [{ provide: APP_GUARD, useClass: GuardGlobal }],
    }).compile();

    app = modulo.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/organizations/org-42/clients/cli-7').expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('un guard de CONTROLLER ve los params de la ruta — es la premisa del fix', () => {
    expect(visto.controlador).toEqual({ orgId: 'org-42', clientId: 'cli-7' });
  });

  it('un guard GLOBAL (APP_GUARD) TAMBIEN los ve', () => {
    // Se escribió esperando `{}` —la suposición razonable es que un guard global corre antes del
    // enrutamiento— y midiendo dio los params completos. Nest resuelve la ruta ANTES de correr
    // los guards, sean globales o de controller.
    //
    // Se deja el caso porque la conclusión importa: `AuthGuard` hoy se registra por controller,
    // pero si algún día se mueve a APP_GUARD, la resolución por `:orgId` sigue funcionando. Un
    // riesgo menos, verificado en vez de asumido.
    expect(visto.global).toEqual({ orgId: 'org-42', clientId: 'cli-7' });
  });
});
