import type { Config } from 'jest';

/**
 * Configuracion Jest del backend (feature #13).
 *
 * - `ts-jest` para correr los specs TypeScript sin build previo.
 * - `testEnvironment: 'node'` (NestJS corre en Node, no en jsdom).
 * - `moduleNameMapper` espeja los path-alias de tsconfig.json (@modules/*, etc.)
 *   para que los imports absolutos resuelvan igual que en build.
 * - `testRegex` matchea unit specs (*.spec.ts) y e2e specs (*.e2e-spec.ts) bajo src/.
 * - `rootDir: src` para alinear con la estructura del proyecto.
 *
 * Nota de seguridad (docs/conventions.md + spec #13): los tests mockean Prisma
 * (jest-mock-extended) y el HTTP de Onnix. NUNCA tocan DATABASE_URL (prod). La
 * integracion real es opt-in via DATABASE_URL_TEST (describe.skip por default).
 */

// Forzar la zona del proceso de test a UTC para replicar el entorno de produccion
// (Railway corre en UTC). Se setea ANTES de forkear los workers (este archivo se
// evalua en el proceso principal de jest), por lo que cada worker arranca su runtime
// con TZ=UTC desde el inicio (cambiarlo en runtime via beforeAll NO reinicializa la
// zona en V8). Critico para feature #17 (sla.util.spec): el convert-in/out de
// calculateBusinessDeadline asume que getHours()/setHours() leen UTC, como en prod.
// El resto de specs (modulo sync, etc.) mockean dependencias y son agnosticos a TZ.
process.env.TZ = process.env.TZ || 'UTC';
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@modules/(.*)$': '<rootDir>/modules/$1',
    '^@common/(.*)$': '<rootDir>/common/$1',
    '^@config/(.*)$': '<rootDir>/config/$1',
    '^@database/(.*)$': '<rootDir>/database/$1',
    '^@infrastructure/(.*)$': '<rootDir>/infrastructure/$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          // Decoradores de NestJS (necesarios para @Injectable / @Controller en specs).
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      },
    ],
  },
  clearMocks: true,
  collectCoverageFrom: ['modules/sync/**/*.ts', '!**/*.spec.ts', '!**/*.e2e-spec.ts'],
};

export default config;
