import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #68 F1 — el orden del que salen los permisos de cada request.
 *
 * EL MECANISMO. `auth.guard.ts` toma `user.organizationMembers[0]` y de ese membership saca los
 * `permissions` de TODA la request; si su rol se llama 'Owner', los reemplaza por `['*:*']`. El
 * `include` que trae esas memberships no tenía `orderBy`, así que Postgres las devolvía en orden
 * FISICO — un orden que no es un contrato y que cambia con cualquier `UPDATE` sobre
 * `organization_members`. Resultado: los permisos de un usuario multi-organización dependían del
 * día, y el `:orgId` de la URL no participaba en ningún momento.
 *
 * POR QUE `desc` Y NO `asc`. `auth.service.ts:68-72` le crea a cada registrado una organización
 * personal donde es Owner, y eso pasa EN EL REGISTRO — o sea que esa membership es, por
 * construcción, la más antigua del usuario. Con `asc` ganaría siempre, y el `*:*` de la org
 * personal viajaría en cada request contra la organización real: sería determinísticamente el
 * PEOR caso. `desc` deja arriba la membership más reciente, que es la organización a la que
 * invitaron a la persona.
 *
 * ⚠️ ALCANCE HONESTO DE F1: esto no arregla el bug, lo vuelve predecible y menos dañino. Un
 * usuario invitado a DOS organizaciones reales sigue operando con los permisos de la más nueva en
 * las dos. El fix es resolver la membership contra el `:orgId` de la URL — #68 F2.
 *
 * El diagnóstico F0 contra producción dio CERO usuarios con más de una membership, así que este
 * cambio no le movió los permisos a nadie. Esa fue la ventana para hacerlo.
 */
describe('#68 F1 — orden determinista de las memberships', () => {
  const SRC = join(__dirname, '..', '..', '..');

  const leer = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

  /** Extrae el bloque `organizationMembers: { ... }` de un archivo, con su `orderBy` si lo tiene. */
  const bloqueMemberships = (contenido: string) => {
    const i = contenido.indexOf('organizationMembers: {');
    if (i === -1) return '';
    // Alcanza con una ventana: el `orderBy` va al final del bloque, antes de cerrarlo.
    return contenido.slice(i, i + 3000);
  };

  describe('auth.guard.ts — de acá salen los permisos de cada request', () => {
    const contenido = leer('modules/auth/guards/auth.guard.ts');

    it('el include de organizationMembers tiene orderBy explícito', () => {
      expect(bloqueMemberships(contenido)).toMatch(/orderBy:\s*\[/);
    });

    it('ordena por createdAt DESC — no asc, que dejaría arriba la org personal', () => {
      // El par del test de arriba: sólo "tiene orderBy" pasaría igual con `asc`, que es
      // justamente el orden que convierte el bug en permanente en vez de intermitente.
      expect(bloqueMemberships(contenido)).toMatch(/createdAt:\s*'desc'/);
      expect(bloqueMemberships(contenido)).not.toMatch(/createdAt:\s*'asc'/);
    });

    it('desempata por organizationId: dos memberships del mismo instante no pueden alternar', () => {
      expect(bloqueMemberships(contenido)).toMatch(/organizationId:\s*'asc'/);
    });

    it('deja una señal cuando el usuario tiene más de una membership', () => {
      // Es el único modo de enterarse de que el bug se disparó: la request sigue devolviendo 200.
      expect(contenido).toMatch(/organizationMembers\.length\s*>\s*1/);
      expect(contenido).toContain('logger.warn');
    });

    it('sigue documentando que F1 NO es el arreglo', () => {
      // Si alguien borra esta advertencia, el próximo que lea el archivo va a creer que la
      // tenencia está resuelta. Lo está a medias.
      expect(contenido).toMatch(/F2/);
    });
  });

  describe('auth.service.ts — de acá sale la organización en la que entra el frontend', () => {
    const contenido = leer('modules/auth/auth.service.ts');

    it('usa el MISMO orden que el guard', () => {
      // No mapea `[0]`, pero `org-provider.tsx:46` sí: sin `zentik:orgId` en localStorage, el
      // frontend entra a `organizations[0]`. Con dos memberships y sin orden, la persona podía
      // caer en su organización personal —vacía— y ver la app sin un solo proyecto.
      const bloque = bloqueMemberships(contenido);

      expect(bloque).toMatch(/createdAt:\s*'desc'/);
      expect(bloque).toMatch(/organizationId:\s*'asc'/);
    });

    it('los dos archivos ordenan igual: si divergen, el frontend muestra una org y el backend evalúa otra', () => {
      const delGuard = bloqueMemberships(leer('modules/auth/guards/auth.guard.ts'))
        .match(/orderBy:\s*\[[^\]]*\]/)?.[0]
        ?.replace(/\s+/g, ' ');
      const delService = bloqueMemberships(contenido)
        .match(/orderBy:\s*\[[^\]]*\]/)?.[0]
        ?.replace(/\s+/g, ' ');

      expect(delGuard).toBeDefined();
      expect(delService).toEqual(delGuard);
    });
  });

  describe('file.controller.ts — el take:1 que decidía acceso a archivos', () => {
    const contenido = leer('modules/file/file.controller.ts');

    it('resolveSessionUser ya no toma una organización arbitraria', () => {
      // Tenía `organizationMembers: { select: { organizationId: true }, take: 1 }` sin `where` ni
      // `orderBy`, y de esa fila salía el `organizationId` con el que `serveFileById` decide si
      // servir el archivo o devolver 404.
      expect(contenido).not.toMatch(/organizationMembers:\s*\{[^}]*take:\s*1/s);
      expect(contenido).toContain('organizationIds: session.user.organizationMembers.map');
    });

    it('el control de acceso pregunta por PERTENENCIA, no por igualdad', () => {
      expect(contenido).toContain('!sessionUser.organizationIds.includes(file.organizationId)');
      expect(contenido).not.toContain('file.organizationId !== sessionUser.organizationId');
    });

    it('sigue devolviendo 404 y no 403, para no filtrar existencia', () => {
      const i = contenido.indexOf('sessionUser.organizationIds.includes');
      expect(contenido.slice(i, i + 300)).toContain('NotFoundException');
    });
  });

  describe('lo que NO era un bug y no se tocó', () => {
    it('project.service.ts resuelve la membership contra la org del RECURSO — es el patrón correcto', () => {
      // `project.service.ts:495` y `:508` también hacen `organizationMembers[0]`, pero su include
      // lleva `where: { organizationId: project.organizationId }`. Con el `@@unique([organizationId,
      // userId])` del schema, ese filtro deja a lo sumo UNA fila: el `[0]` ahí no es arbitrario,
      // es el único. Es exactamente lo que F2 va a hacer a nivel de guard, así que sirve de
      // referencia — no de deuda.
      const contenido = leer('modules/project/project.service.ts');
      const i = contenido.indexOf('organizationMembers: {');

      expect(contenido.slice(i, i + 400)).toContain('where: { organizationId: project.organizationId }');
    });
  });
});
