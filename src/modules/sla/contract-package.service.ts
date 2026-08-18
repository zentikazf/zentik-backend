import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, ProjectLifecycleStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';
import { ProjectContractRow, SlaContractService } from './sla-contract.service';
import {
  ApplyContractPackageDto,
  CreateContractPackageDto,
  ProjectContractItemDto,
  UpdateContractPackageDto,
  UpsertContractPackageItemsDto,
} from './dto';

/** Código de error de Prisma para violación de unique constraint. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** Por qué un ítem del paquete NO se pudo aplicar (#58 R4.5). */
export type PackageItemSkipReason = 'POLICY_INACTIVE' | 'TYPE_INACTIVE';

/** Un ítem del paquete que el apply salta y reporta, en vez de fallar entero. */
export interface SkippedPackageItem {
  ticketTypeId: string;
  ticketTypeName: string;
  reason: PackageItemSkipReason;
  /** Frase lista para mostrar: "la política «Crítico 2h» está desactivada". */
  detail: string;
}

/** Una fila del preview: qué trae el paquete y qué tiene hoy el proyecto. */
export interface PackagePreviewRow {
  ticketTypeId: string;
  ticketTypeName: string;
  /** La política que trae el PAQUETE. */
  packagePolicyId: string;
  packagePolicyName: string;
  /** La que tiene HOY el proyecto. `null` = no hay contrato (o está apagado). */
  currentPolicyId: string | null;
  currentPolicyName: string | null;
  /**
   * `true` ⇒ el contrato existe pero está DESACTIVADO: aplicar lo reactiva.
   * Cae en "nuevo", nunca en "ya igual", aunque la política coincida (#58 R4.3).
   */
  reactivates: boolean;
}

/** Las 3 categorías que aprobó el dueño, más los ítems podridos. */
export interface ApplyPackagePreview {
  /** `isActive: false` ⇒ archivado: se puede mirar, NO se puede aplicar. */
  package: { id: string; name: string; itemCount: number; isActive: boolean };
  project: { id: string; name: string };
  /** ✚ se van a crear (incluye reactivar un contrato apagado). */
  toCreate: PackagePreviewRow[];
  /** ✓ ya configurados igual: no se tocan. */
  alreadySame: PackagePreviewRow[];
  /** ⚠ configurados distinto: NO se tocan salvo checkbox explícito. */
  different: PackagePreviewRow[];
  /** Ítems que apuntan a una política desactivada o a un tipo inactivo. */
  skipped: SkippedPackageItem[];
  /** El paquete no tiene ni un ítem: aplicarlo sería un no-op (#58 R3.3). */
  isEmpty: boolean;
}

/** Lo que devuelve aplicar: qué pasó, qué se salteó y la matriz fresca. */
export interface ApplyPackageResult {
  packageId: string;
  packageName: string;
  createdCount: number;
  overwrittenCount: number;
  skippedSameCount: number;
  skippedDifferentCount: number;
  skipped: SkippedPackageItem[];
  /** Se aplicó pero no había nada que escribir. La aplicación se registró igual. */
  isNoop: boolean;
  applicationId: string;
  /** La matriz del proyecto ya actualizada: el front no necesita un GET extra. */
  contracts: Awaited<ReturnType<SlaContractService['getByProject']>>;
}

/** Fila del preview + el dato que solo necesita el escritor. */
interface PlanRow extends PackagePreviewRow {
  /**
   * Las notas del contrato que YA existe. Se reenvían al upsert porque el update
   * de `upsertForProject` persiste la fila completa (`contractNotes ?? null`):
   * omitirlas no es "no las toques", es BORRARLAS.
   */
  currentNotes: string | null;
}

interface ApplyPlan {
  pkg: { id: string; name: string; itemCount: number; isActive: boolean };
  project: { id: string; name: string };
  toCreate: PlanRow[];
  alreadySame: PlanRow[];
  different: PlanRow[];
  skipped: SkippedPackageItem[];
}

/**
 * Paquetes de contratos default (feature #58).
 *
 * Un paquete es un grupo con nombre de pares tipo → política, reutilizable.
 *
 * ── Las dos reglas que gobiernan todo ───────────────────────────────────────
 * 1. **Aplicar es COPIA, no vínculo** (decisión 2 del dueño): se crean las filas
 *    de contrato del proyecto y ahí se corta la relación. Editar el paquete no
 *    cambia ningún proyecto; para eso está el re-aplicar, siempre explícito.
 * 2. **El motor de SLA no se entera**: el resolver nunca ve un paquete. Este
 *    service termina llamando a `SlaContractService.upsertForProject`, el mismo
 *    camino de escritura del centro de contratación, sin tocarle una línea.
 */
@Injectable()
export class ContractPackageService {
  private readonly logger = new Logger(ContractPackageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly contracts: SlaContractService,
  ) {}

  // ── CRUD del paquete (#58 R3) ──────────────────────────────────────────────

  /**
   * Listado con lo que necesita la pantalla: cuántos tipos trae, un resumen por
   * rama y **en cuántos proyectos se usó** (distinct `projectId` sobre el log).
   */
  async list(orgId: string, includeInactive = false) {
    const [packages, roots, applications] = await Promise.all([
      this.prisma.contractPackage.findMany({
        where: { organizationId: orgId, ...(includeInactive ? {} : { isActive: true }) },
        include: {
          items: { select: { ticketType: { select: { id: true, name: true, path: true } } } },
        },
        orderBy: { name: 'asc' },
      }),
      // El resumen de ramas se arma con el PRIMER segmento del `path` (que son
      // slugs) resuelto contra las raíces. Es una tabla de decenas de filas.
      this.prisma.ticketType.findMany({
        where: { organizationId: orgId, level: 0 },
        select: { slug: true, name: true },
      }),
      // Un solo groupBy para todos los paquetes: cada fila es un par
      // (paquete, proyecto) distinto, que es exactamente lo que hay que contar.
      this.prisma.contractPackageApplication.groupBy({
        by: ['packageId', 'projectId'],
        where: { package: { organizationId: orgId } },
      }),
    ]);

    const rootNameBySlug = new Map(roots.map((root) => [root.slug, root.name]));
    const usedProjects = new Map<string, number>();
    for (const row of applications) {
      usedProjects.set(row.packageId, (usedProjects.get(row.packageId) ?? 0) + 1);
    }

    return packages.map((pkg) => {
      const byBranch = new Map<string, number>();
      for (const item of pkg.items) {
        const rootSlug = item.ticketType.path.split('/')[0];
        const label = rootNameBySlug.get(rootSlug) ?? item.ticketType.name;
        byBranch.set(label, (byBranch.get(label) ?? 0) + 1);
      }

      return {
        id: pkg.id,
        name: pkg.name,
        notes: pkg.notes,
        isActive: pkg.isActive,
        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
        itemCount: pkg.items.length,
        branches: [...byBranch.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es')),
        usedInProjects: usedProjects.get(pkg.id) ?? 0,
      };
    });
  }

  /**
   * El paquete + **el catálogo COMPLETO de tipos** con su asignación encima
   * (#58 R2.5). Mismo shape que `getByProject`, así el editor de árbol compartido
   * lo consume sin adaptadores y sin un segundo fetch — justo el tercer fetch que
   * #48-T1b eliminó a propósito.
   */
  async getById(orgId: string, packageId: string) {
    const pkg = await this.assertPackage(orgId, packageId);

    const [types, items, projects] = await Promise.all([
      this.prisma.ticketType.findMany({
        where: { organizationId: orgId, isActive: true },
        orderBy: [{ path: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.contractPackageItem.findMany({
        where: { packageId },
        include: { slaPolicy: { select: { id: true, name: true } } },
      }),
      this.prisma.contractPackageApplication.findMany({
        where: { packageId },
        distinct: ['projectId'],
        select: { projectId: true },
      }),
    ]);

    const byTypeId = new Map(items.map((item) => [item.ticketTypeId, item]));
    const rows: ProjectContractRow[] = types.map((type) => {
      const item = byTypeId.get(type.id);
      return {
        ticketTypeId: type.id,
        ticketTypeName: type.name,
        // El "contrato" de un paquete es su ítem. Se llama igual para que la fila
        // sea intercambiable con la del proyecto (mismo editor, mismo tipo).
        contractId: item?.id ?? null,
        slaPolicyId: item?.slaPolicyId ?? null,
        slaPolicyName: item?.slaPolicy.name ?? null,
        // El ítem de paquete no lleva notas (#58 R1.2). Viaja en null para no
        // romper el shape que espera el editor.
        contractNotes: null,
        // En un paquete "está" es tener fila: no hay flag que apagar.
        isActive: !!item,
        parentId: type.parentId,
        path: type.path,
        level: type.level,
        clientVisible: type.clientVisible,
      };
    });

    return {
      package: {
        id: pkg.id,
        name: pkg.name,
        notes: pkg.notes,
        isActive: pkg.isActive,
        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
        itemCount: items.length,
        usedInProjects: projects.length,
      },
      items: rows,
    };
  }

  /**
   * Los proyectos que recibieron este paquete, uno por proyecto y con su última
   * aplicación. Es lo que alimenta el re-aplicar (#58 R6): el dueño pidió
   * **elección explícita caso por caso**, no un batch con una sola confirmación,
   * así que la pantalla necesita la lista con nombre para poder elegir.
   */
  async listApplications(orgId: string, packageId: string) {
    await this.assertPackage(orgId, packageId);

    const rows = await this.prisma.contractPackageApplication.findMany({
      where: { packageId },
      orderBy: { appliedAt: 'desc' },
      include: {
        project: { select: { id: true, name: true, lifecycleStatus: true } },
        appliedBy: { select: { id: true, name: true } },
      },
    });

    // Colapsa por proyecto quedándose con la PRIMERA de cada uno, que por el
    // `orderBy desc` es la más reciente. El log es append-only: un proyecto que
    // recibió el paquete tres veces tiene tres filas y una sola fila de lista.
    const byProject = new Map<string, (typeof rows)[number] & { timesApplied: number }>();
    for (const row of rows) {
      const seen = byProject.get(row.projectId);
      if (seen) {
        seen.timesApplied += 1;
        continue;
      }
      byProject.set(row.projectId, { ...row, timesApplied: 1 });
    }

    return [...byProject.values()].map((row) => ({
      projectId: row.projectId,
      projectName: row.project.name,
      /** Un proyecto archivado no recibe tickets nuevos: la UI lo marca. */
      projectIsActive: row.project.lifecycleStatus === ProjectLifecycleStatus.ACTIVE,
      lastAppliedAt: row.appliedAt,
      lastAppliedByName: row.appliedBy.name,
      timesApplied: row.timesApplied,
    }));
  }

  async create(orgId: string, dto: CreateContractPackageDto, userId: string) {
    const name = this.requireName(dto.name);
    await this.assertNameAvailable(orgId, name);

    const pkg = await this.runUnique(name, () =>
      this.prisma.contractPackage.create({
        data: {
          organizationId: orgId,
          name,
          notes: dto.notes?.trim() || null,
          createdById: userId,
        },
      }),
    );

    this.logger.log(`Paquete de contratos creado: ${pkg.id} (${pkg.name}) org=${orgId}`);
    this.eventEmitter.emit('sla.package.created', {
      ...domainEvent('sla.package.created', 'contract_package', pkg.id, orgId, userId),
      packageId: pkg.id,
      organizationId: orgId,
      userId,
    });
    return pkg;
  }

  async update(orgId: string, packageId: string, dto: UpdateContractPackageDto, userId: string) {
    const existing = await this.assertPackage(orgId, packageId);

    const name = dto.name === undefined ? undefined : this.requireName(dto.name);
    if (name !== undefined && name !== existing.name) {
      await this.assertNameAvailable(orgId, name);
    }

    const pkg = await this.runUnique(name ?? existing.name, () =>
      this.prisma.contractPackage.update({
        where: { id: packageId },
        data: {
          ...(name !== undefined && { name }),
          // String vacío limpia la nota; ausente no la toca.
          ...(dto.notes !== undefined && { notes: dto.notes.trim() || null }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      }),
    );

    this.eventEmitter.emit('sla.package.updated', {
      ...domainEvent('sla.package.updated', 'contract_package', pkg.id, orgId, userId),
      packageId: pkg.id,
      organizationId: orgId,
      userId,
    });
    return pkg;
  }

  /**
   * Upsert de los ítems. ⚠️ `isActive: false` **BORRA** la fila (#58 R3.4): en un
   * paquete "no está" es una fila ausente, no un flag apagado.
   *
   * Es la única diferencia semántica con el PUT de contratos, y existe para que
   * el `buildPayload` del editor compartido sirva casi verbatim.
   */
  async upsertItems(
    orgId: string,
    packageId: string,
    dto: UpsertContractPackageItemsDto,
    userId: string,
  ) {
    await this.assertPackage(orgId, packageId);

    const typeIds = dto.items.map((item) => item.ticketTypeId);
    const duplicated = typeIds.filter((id, idx) => typeIds.indexOf(id) !== idx);
    if (duplicated.length > 0) {
      throw new AppException(
        'El paquete tiene el mismo tipo de solicitud más de una vez',
        'SLA_PACKAGE_DUPLICATE_TYPE',
        422,
        { ticketTypeIds: [...new Set(duplicated)] },
      );
    }

    // Solo las filas que ENTRAN al paquete necesitan política; sacar un tipo es
    // borrar su fila y no tiene por qué saber con qué se atendía.
    const included = dto.items.filter((item) => item.isActive !== false);
    const missingPolicy = included.filter((item) => !item.slaPolicyId);
    if (missingPolicy.length > 0) {
      throw new AppException(
        'Un ítem del paquete necesita su política SLA',
        'SLA_POLICY_REQUIRED',
        422,
        { ticketTypeIds: missingPolicy.map((item) => item.ticketTypeId) },
      );
    }

    const uniqueTypeIds = [...new Set(typeIds)];
    const uniquePolicyIds = [...new Set(included.map((item) => item.slaPolicyId as string))];

    if (uniqueTypeIds.length > 0) {
      const typeCount = await this.prisma.ticketType.count({
        where: { id: { in: uniqueTypeIds }, organizationId: orgId },
      });
      if (typeCount !== uniqueTypeIds.length) {
        throw new AppException(
          'Algún tipo de solicitud no existe en la organización',
          'TICKET_TYPE_NOT_FOUND',
          404,
        );
      }
    }

    if (uniquePolicyIds.length > 0) {
      const policyCount = await this.prisma.slaPolicy.count({
        where: { id: { in: uniquePolicyIds }, organizationId: orgId, isActive: true },
      });
      if (policyCount !== uniquePolicyIds.length) {
        throw new AppException(
          'Alguna política SLA no existe o está desactivada en la organización',
          'SLA_POLICY_NOT_FOUND',
          404,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        if (item.isActive === false) {
          // `deleteMany` y no `delete`: sacar un tipo que no estaba es un no-op,
          // no un error, y así no hace falta la consulta previa.
          await tx.contractPackageItem.deleteMany({
            where: { packageId, ticketTypeId: item.ticketTypeId },
          });
          continue;
        }

        await tx.contractPackageItem.upsert({
          where: { packageId_ticketTypeId: { packageId, ticketTypeId: item.ticketTypeId } },
          create: {
            packageId,
            ticketTypeId: item.ticketTypeId,
            slaPolicyId: item.slaPolicyId as string,
          },
          update: { slaPolicyId: item.slaPolicyId as string },
        });
      }

      this.eventEmitter.emit('sla.package.updated', {
        ...domainEvent('sla.package.updated', 'contract_package', packageId, orgId, userId),
        packageId,
        organizationId: orgId,
        changes: dto.items.length,
        userId,
      });
    });

    this.logger.log(
      `Ítems de paquete actualizados: paquete=${packageId} filas=${dto.items.length} org=${orgId}`,
    );
    return this.getById(orgId, packageId);
  }

  // ── Aplicar (#58 R4) ───────────────────────────────────────────────────────

  /** Dry-run: calcula las 3 categorías y NO escribe nada. */
  async preview(
    orgId: string,
    projectId: string,
    packageId: string,
  ): Promise<ApplyPackagePreview> {
    const plan = await this.buildPlan(orgId, projectId, packageId);
    return {
      package: plan.pkg,
      project: plan.project,
      toCreate: plan.toCreate.map(toPreviewRow),
      alreadySame: plan.alreadySame.map(toPreviewRow),
      different: plan.different.map(toPreviewRow),
      skipped: plan.skipped,
      isEmpty: plan.pkg.itemCount === 0,
    };
  }

  /**
   * Aplica el paquete al proyecto y deja el rastro.
   *
   * ── Qué se escribe ──────────────────────────────────────────────────────────
   * Los "nuevos" (incluidos los contratos apagados, que se REACTIVAN) más los
   * "distintos" que el usuario tildó como "pisar este". Nada más: lo que el
   * paquete no menciona queda EXACTAMENTE como estaba (#58 R4.4) — aplicar nunca
   * apaga un contrato, ni siquiera al re-aplicar un paquete al que le sacaron un
   * ítem.
   *
   * ── Por qué son dos escrituras y no una transacción ─────────────────────────
   * Los contratos van por `upsertForProject`, que abre SU propia `$transaction`.
   * Meter el log adentro exigiría cambiarle la firma para que acepte un `tx`, y
   * ese service es el único escritor de contratos de todo el sistema: no se toca.
   *
   * El orden importa y es deliberado: **primero los contratos, después el log**.
   * Al revés, si la escritura falla el log queda MINTIENDO ("aplicó 9 contratos"
   * sobre una base donde no pasó nada), y ese log es justamente lo que R1.4
   * declara verdad para siempre. En este orden, la única falla posible pierde una
   * fila de rastro sobre datos correctos, y se cura sola: al reintentar, todo cae
   * en "ya igual" y la aplicación se registra igual con 0 cambios (R1.5).
   */
  async apply(
    orgId: string,
    projectId: string,
    dto: ApplyContractPackageDto,
    userId: string,
  ): Promise<ApplyPackageResult> {
    const plan = await this.buildPlan(orgId, projectId, dto.packageId);

    // Un paquete ARCHIVADO no se aplica. El chequeo va acá y no en `buildPlan`
    // porque el preview SÍ tiene que poder mirarlo (para decir por qué no se
    // puede) — pero aplicar es la única acción donde el archivado significa algo.
    //
    // ⛔ No es cosmético: el guard `SLA_POLICY_IN_USE` solo cuenta ítems de
    // paquetes ACTIVOS, así que archivar un paquete DESBLOQUEA dar de baja las
    // políticas que usa. Si además se pudiera aplicar, la cadena
    // "archivar → dar de baja la política → aplicar igual" terminaría en un
    // paquete que se salta sus propios ítems en silencio.
    if (!plan.pkg.isActive) {
      throw new AppException(
        `El paquete "${plan.pkg.name}" está archivado: no se puede aplicar. ` +
          'Reactivalo desde Paquetes si querés volver a usarlo.',
        'SLA_PACKAGE_INACTIVE',
        422,
        { packageId: plan.pkg.id },
      );
    }

    // Un paquete vacío no se aplica en silencio (#58 R3.3): sin ítems no hay
    // nada que copiar y registrar la aplicación solo ensuciaría el "usado en N
    // proyectos" con un paquete que no hizo nada.
    if (plan.pkg.itemCount === 0) {
      throw new AppException(
        `El paquete "${plan.pkg.name}" no tiene ningún tipo de solicitud: no hay nada para aplicar. ` +
          'Agregale al menos un tipo antes de usarlo.',
        'SLA_PACKAGE_EMPTY',
        422,
        { packageId: plan.pkg.id },
      );
    }

    const overwrite = new Set(
      (dto.items ?? []).filter((item) => item.overwrite === true).map((item) => item.ticketTypeId),
    );
    const overwritten = plan.different.filter((row) => overwrite.has(row.ticketTypeId));

    const writeItems: ProjectContractItemDto[] = [...plan.toCreate, ...overwritten].map((row) => ({
      ticketTypeId: row.ticketTypeId,
      slaPolicyId: row.packagePolicyId,
      // Las notas del contrato no se editan desde el paquete: se reenvían para
      // que el upsert (que persiste la fila completa) no las borre.
      ...(row.currentNotes ? { contractNotes: row.currentNotes } : {}),
      isActive: true,
    }));

    const contracts =
      writeItems.length > 0
        ? await this.contracts.upsertForProject(orgId, projectId, { items: writeItems }, userId)
        : await this.contracts.getByProject(orgId, projectId);

    // Se registra SIEMPRE, aunque no se haya escrito nada (#58 R1.5): si no, este
    // proyecto nunca entraría en el "usado en N proyectos" del listado.
    const application = await this.prisma.contractPackageApplication.create({
      data: {
        packageId: plan.pkg.id,
        projectId,
        appliedById: userId,
        createdCount: plan.toCreate.length,
        overwrittenCount: overwritten.length,
        skippedSameCount: plan.alreadySame.length,
        skippedDifferentCount: plan.different.length - overwritten.length,
      },
    });

    this.logger.log(
      `Paquete aplicado: paquete=${plan.pkg.id} proyecto=${projectId} ` +
        `creados=${plan.toCreate.length} pisados=${overwritten.length} ` +
        `omitidos=${plan.skipped.length} org=${orgId}`,
    );

    // Evento propio: el `sla.contract.upserted` del bulk no alcanza para la
    // trazabilidad del re-aplicar — no dice qué paquete fue (#58 R4.6).
    this.eventEmitter.emit('sla.package.applied', {
      ...domainEvent('sla.package.applied', 'contract_package', plan.pkg.id, orgId, userId),
      packageId: plan.pkg.id,
      projectId,
      organizationId: orgId,
      createdCount: plan.toCreate.length,
      overwrittenCount: overwritten.length,
      skippedCount: plan.skipped.length,
      userId,
    });

    return {
      packageId: plan.pkg.id,
      packageName: plan.pkg.name,
      createdCount: plan.toCreate.length,
      overwrittenCount: overwritten.length,
      skippedSameCount: plan.alreadySame.length,
      skippedDifferentCount: plan.different.length - overwritten.length,
      skipped: plan.skipped,
      isNoop: writeItems.length === 0,
      applicationId: application.id,
      contracts,
    };
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  /**
   * El cálculo que comparten el preview y el apply. Que sea UNO solo es lo que
   * garantiza que el usuario apruebe exactamente lo que se va a escribir.
   *
   * Las 3 categorías, sin ambigüedad (#58 R4.3):
   * · **nuevo** — el tipo no tiene contrato **o lo tiene DESACTIVADO**. Un
   *   contrato apagado cuenta como nuevo (reactivar) aunque su política sea la
   *   misma: hoy el cliente no ve ese tipo, así que "ya está igual" sería falso.
   * · **ya igual** — mismo tipo, misma política, contrato activo.
   * · **distinto** — mismo tipo, otra política. No se toca salvo checkbox.
   */
  private async buildPlan(orgId: string, projectId: string, packageId: string): Promise<ApplyPlan> {
    const [pkg, project] = await Promise.all([
      this.prisma.contractPackage.findFirst({
        where: { id: packageId, organizationId: orgId },
        include: {
          items: {
            include: {
              ticketType: { select: { id: true, name: true, isActive: true, path: true } },
              slaPolicy: { select: { id: true, name: true, isActive: true } },
            },
          },
        },
      }),
      this.prisma.project.findFirst({
        where: { id: projectId, organizationId: orgId },
        select: { id: true, name: true },
      }),
    ]);

    if (!pkg) {
      throw new AppException('Paquete de contratos no encontrado', 'SLA_PACKAGE_NOT_FOUND', 404);
    }
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    const contracts = await this.prisma.projectTicketTypeSla.findMany({
      where: { projectId },
      include: { slaPolicy: { select: { id: true, name: true } } },
    });
    const contractByTypeId = new Map(contracts.map((row) => [row.ticketTypeId, row]));

    const plan: ApplyPlan = {
      pkg: {
        id: pkg.id,
        name: pkg.name,
        itemCount: pkg.items.length,
        isActive: pkg.isActive,
      },
      project: { id: project.id, name: project.name },
      toCreate: [],
      alreadySame: [],
      different: [],
      skipped: [],
    };

    // Orden del árbol, igual que el resto de las lecturas de tipos.
    const items = [...pkg.items].sort((a, b) =>
      a.ticketType.path.localeCompare(b.ticketType.path, 'es'),
    );

    for (const item of items) {
      // Paquete podrido (#58 R4.5): se salta y se reporta. Nunca falla entero —
      // que una política dada de baja rompa el paquete completo obligaría a
      // repararlo antes de poder aplicar los otros 11 tipos que están sanos.
      if (!item.ticketType.isActive) {
        plan.skipped.push({
          ticketTypeId: item.ticketTypeId,
          ticketTypeName: item.ticketType.name,
          reason: 'TYPE_INACTIVE',
          detail: `el tipo "${item.ticketType.name}" está desactivado`,
        });
        continue;
      }
      if (!item.slaPolicy.isActive) {
        plan.skipped.push({
          ticketTypeId: item.ticketTypeId,
          ticketTypeName: item.ticketType.name,
          reason: 'POLICY_INACTIVE',
          detail: `la política "${item.slaPolicy.name}" está desactivada`,
        });
        continue;
      }

      const current = contractByTypeId.get(item.ticketTypeId);
      const row: PlanRow = {
        ticketTypeId: item.ticketTypeId,
        ticketTypeName: item.ticketType.name,
        packagePolicyId: item.slaPolicyId,
        packagePolicyName: item.slaPolicy.name,
        currentPolicyId: current?.isActive ? current.slaPolicyId : null,
        currentPolicyName: current?.isActive ? current.slaPolicy.name : null,
        reactivates: !!current && !current.isActive,
        currentNotes: current?.contractNotes ?? null,
      };

      if (!current || !current.isActive) {
        plan.toCreate.push(row);
      } else if (current.slaPolicyId === item.slaPolicyId) {
        plan.alreadySame.push(row);
      } else {
        plan.different.push(row);
      }
    }

    return plan;
  }

  private async assertPackage(orgId: string, packageId: string) {
    const pkg = await this.prisma.contractPackage.findFirst({
      where: { id: packageId, organizationId: orgId },
    });
    if (!pkg) {
      throw new AppException('Paquete de contratos no encontrado', 'SLA_PACKAGE_NOT_FOUND', 404);
    }
    return pkg;
  }

  /**
   * Defensa en profundidad: el DTO ya trimea ANTES de validar, así que un nombre
   * de solo espacios muere en el `@MinLength(2)`. Si el service se llama desde
   * otro path, mejor un 422 que nombra el problema que un paquete guardado con
   * el nombre vacío — que además choca con la unique y devuelve el 409 sin
   * sentido `Ya existe un paquete llamado ""`.
   */
  private requireName(raw: string): string {
    const name = raw.trim();
    if (!name) {
      throw new AppException(
        'El nombre del paquete no puede estar vacío',
        'SLA_PACKAGE_NAME_REQUIRED',
        422,
      );
    }
    return name;
  }

  private async assertNameAvailable(orgId: string, name: string): Promise<void> {
    const duplicate = await this.prisma.contractPackage.findFirst({
      where: { organizationId: orgId, name },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppException(
        `Ya existe un paquete de contratos llamado "${name}" en la organización`,
        'SLA_PACKAGE_DUPLICATE_NAME',
        409,
      );
    }
  }

  /**
   * El pre-chequeo de nombre no es atómico (dos requests concurrentes pasan los
   * dos): la unique de la DB es la que manda. Se traduce el P2002 al MISMO código
   * de error para que el cliente no vea un 500.
   */
  private async runUnique<T>(name: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new AppException(
          `Ya existe un paquete de contratos llamado "${name}" en la organización`,
          'SLA_PACKAGE_DUPLICATE_NAME',
          409,
        );
      }
      throw error;
    }
  }
}

/** El preview no expone `currentNotes`: es dato del escritor, no de la pantalla. */
function toPreviewRow(row: PlanRow): PackagePreviewRow {
  const { currentNotes: _currentNotes, ...preview } = row;
  return preview;
}
