import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * #66 T1.3 — El test que habría atajado `view:tasks` el día que se escribió.
 *
 * EL MECANISMO QUE ESTE ARCHIVO VIGILA: `PermissionsGuard` (permissions.guard.ts:44-53) no
 * valida que el permiso exigido EXISTA. Sólo compara strings contra los que trae el usuario,
 * con un único fallback: `read:X` se satisface con `manage:X`. Por eso un permiso mal tipeado
 * no explota — se comporta como una puerta que sólo abre el comodín `*:*`, o sea Owner. Y como
 * los consumidores del frontend suelen comerse el 403 con `.catch(() => {})`, el síntoma es
 * una pantalla incompleta sin ningún error a la vista. Fue exactamente lo que pasó con
 * `@Permissions('view:tasks')` en `task.controller.ts`.
 *
 * DOS CATEGORÍAS, a propósito:
 *
 *   1. FANTASMA ROTO — el permiso no está en el catálogo Y no se deriva de ninguno que sí esté.
 *      Nadie salvo `*:*` puede pasar. Esto FALLA el test: es siempre un bug.
 *
 *   2. NO CATALOGADO PERO DERIVABLE — un `read:X` ausente del catálogo cuyo `manage:X` sí
 *      existe. La ruta funciona para todo el que tenga `manage:X`, así que no está rota, pero
 *      el catálogo es inconsistente. Se listan como excepciones EXPLÍCITAS abajo: agregar una
 *      nueva obliga a tocar este archivo y a justificarla.
 *
 * El parseo es de texto sobre el fuente, no de metadata en runtime. Es a propósito: importar
 * los 32 controllers arrastraría el árbol de dependencias entero (Prisma, Redis, colas) a un
 * test que sólo necesita leer strings.
 */
describe('Catálogo de permisos — ningún @Permissions apunta a un permiso inexistente (#66)', () => {
  const SRC = join(__dirname, '..', '..');
  const SEED = join(SRC, '..', 'prisma', 'seed.ts');

  /**
   * Excepciones conocidas de la categoría 2 (no catalogado pero derivable).
   *
   * `read:time-entries` — `time-tracking.controller.ts:29`, decorador de CLASE, cubre todo el
   * módulo. No está en `prisma/seed.ts`, pero `manage:time-entries` sí, y el fallback del guard
   * lo satisface. Lo tienen Project Manager, Tech Lead, Developer, QA, Designer, DevOps y
   * Soporte (organization.service.ts:73-80). Queda AFUERA el rol Product Owner, que no tiene
   * `manage:time-entries` — o sea que un PO no entra a time-tracking. Eso es una decisión de
   * negocio (¿debe un PO ver los reportes de tiempo?), no un error de tipeo, y por eso #66 no
   * lo tocó: cambiarlo mueve permisos de roles reales.
   */
  const DERIVABLES_CONOCIDOS = new Set(['read:time-entries']);

  /** Lee el catálogo real: los permisos que el sistema llega a CREAR en la tabla. */
  function catalogo(): Set<string> {
    const encontrados = new Set<string>(['*:*']);
    const patron = /action:\s*'([^']+)'\s*,\s*resource:\s*'([^']+)'/g;

    // 1. `prisma/seed.ts` — el catálogo declarado (permissionData).
    // 2. Los `permission.upsert(...)` de src/: `ensureClienteRole` crea read:chat y write:chat
    //    al vuelo, así que existen en producción sin estar en el seed original.
    const fuentes = [readFileSync(SEED, 'utf8'), ...archivos(SRC, '.ts').map((f) => readFileSync(f, 'utf8'))];

    for (const texto of fuentes) {
      patron.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = patron.exec(texto)) !== null) {
        encontrados.add(`${m[1]}:${m[2]}`);
      }
    }

    return encontrados;
  }

  /** Todos los `@Permissions('x', 'y')` de los controllers, con archivo y línea. */
  function exigidos(): Array<{ permiso: string; donde: string }> {
    const salida: Array<{ permiso: string; donde: string }> = [];

    for (const archivo of archivos(SRC, '.controller.ts')) {
      const lineas = readFileSync(archivo, 'utf8').split('\n');

      lineas.forEach((linea, i) => {
        const decorador = /@Permissions\(([^)]*)\)/.exec(linea);
        if (!decorador) return;

        // Se ignoran las apariciones dentro de un comentario: los bloques de criterio de este
        // repo citan decoradores en prosa (client.controller.ts:66+ es el caso).
        if (/^\s*(\*|\/\/)/.test(linea)) return;

        for (const cita of decorador[1].match(/'[^']+'/g) ?? []) {
          salida.push({
            permiso: cita.slice(1, -1),
            donde: `${relative(SRC, archivo).replace(/\\/g, '/')}:${i + 1}`,
          });
        }
      });
    }

    return salida;
  }

  function archivos(dir: string, sufijo: string): string[] {
    const salida: string[] = [];
    for (const entrada of readdirSync(dir)) {
      if (entrada === 'node_modules' || entrada === 'dist') continue;
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta, sufijo));
      else if (entrada.endsWith(sufijo)) salida.push(ruta);
    }
    return salida;
  }

  const CATALOGO = catalogo();
  const EXIGIDOS = exigidos();

  it('el escaneo encuentra el catálogo y los decoradores (si esto falla, el resto es un falso verde)', () => {
    // Sin estas dos cotas, un cambio de estructura de carpetas dejaría los sets vacíos y
    // TODOS los tests de abajo pasarían sin haber mirado nada.
    expect(CATALOGO.size).toBeGreaterThanOrEqual(18);
    expect(EXIGIDOS.length).toBeGreaterThanOrEqual(80);
    expect(CATALOGO.has('read:tasks')).toBe(true);
    expect(CATALOGO.has('manage:time-entries')).toBe(true);
  });

  it('ningún @Permissions exige un permiso FANTASMA (inexistente y no derivable)', () => {
    const fantasmas = EXIGIDOS.filter(({ permiso }) => {
      if (CATALOGO.has(permiso)) return false;
      if (DERIVABLES_CONOCIDOS.has(permiso)) return false;

      // El fallback del guard: `read:X` lo satisface `manage:X`. Cualquier otra acción
      // (`view:`, `write:`, `list:`…) no tiene derivación y deja la ruta sólo para `*:*`.
      const [accion, recurso] = permiso.split(':');
      return !(accion === 'read' && CATALOGO.has(`manage:${recurso}`));
    });

    expect(fantasmas.map((f) => `${f.permiso} en ${f.donde}`)).toEqual([]);
  });

  it('view:tasks no volvió: era el fantasma de task.controller.ts', () => {
    expect(EXIGIDOS.map((e) => e.permiso)).not.toContain('view:tasks');
  });

  it('las excepciones derivables declaradas siguen siendo derivables', () => {
    // Si alguien borra `manage:time-entries` del seed, `read:time-entries` pasa de
    // "inconsistente pero funcional" a "ruta muerta" — y esto lo caza.
    for (const permiso of DERIVABLES_CONOCIDOS) {
      const [accion, recurso] = permiso.split(':');
      expect([permiso, accion === 'read' && CATALOGO.has(`manage:${recurso}`)]).toEqual([permiso, true]);
    }
  });

  it('toda excepción declarada se usa de verdad (no queda basura en la lista)', () => {
    const usados = new Set(EXIGIDOS.map((e) => e.permiso));
    for (const permiso of DERIVABLES_CONOCIDOS) {
      expect([permiso, usados.has(permiso)]).toEqual([permiso, true]);
    }
  });
});
