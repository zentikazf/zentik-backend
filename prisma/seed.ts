import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ── Permissions ──────────────────────────────────────────────────────
  const permissionData = [
    { action: '*', resource: '*', description: 'Full access' },
    { action: 'manage', resource: 'projects', description: 'Manage projects' },
    { action: 'manage', resource: 'tasks', description: 'Manage tasks' },
    { action: 'manage', resource: 'members', description: 'Manage members' },
    { action: 'manage', resource: 'sprints', description: 'Manage sprints' },
    { action: 'manage', resource: 'boards', description: 'Manage boards' },
    { action: 'manage', resource: 'time-entries', description: 'Manage time entries' },
    { action: 'manage', resource: 'chat', description: 'Manage chat' },
    { action: 'read', resource: 'projects', description: 'Read projects' },
    { action: 'read', resource: 'tasks', description: 'Read tasks' },
    { action: 'read', resource: 'members', description: 'Read members' },
    { action: 'read', resource: 'sprints', description: 'Read sprints' },
    { action: 'read', resource: 'boards', description: 'Read boards' },
    { action: 'read', resource: 'billing', description: 'Read billing' },
    { action: 'read', resource: 'audit', description: 'Read audit logs' },
    { action: 'read', resource: 'chat', description: 'Read chat' },
  ];

  const permissions: Record<string, string> = {};
  for (const p of permissionData) {
    const perm = await prisma.permission.upsert({
      where: { action_resource: { action: p.action, resource: p.resource } },
      update: {},
      create: p,
    });
    permissions[`${p.action}:${p.resource}`] = perm.id;
  }

  console.log('Permissions created:', Object.keys(permissions).length);

  // ── Demo Organization ────────────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { slug: 'zentik-demo' },
    update: {},
    create: {
      name: 'Zentik Demo',
      slug: 'zentik-demo',
    },
  });

  console.log('Organization created:', org.id);

  // ── Roles (scoped to organization) ──────────────────────────────────
  const roleDefinitions = [
    { name: 'OWNER', description: 'Full access to all resources', isSystem: true, perms: ['*:*'] },
    {
      name: 'ADMIN',
      description: 'Administrative access',
      isSystem: true,
      perms: [
        'manage:projects', 'manage:tasks', 'manage:members',
        'manage:sprints', 'manage:boards', 'read:billing', 'read:audit',
      ],
    },
    {
      name: 'MANAGER',
      description: 'Project management access',
      isSystem: true,
      perms: [
        'manage:projects', 'manage:tasks', 'manage:sprints',
        'manage:boards', 'read:members',
      ],
    },
    {
      name: 'MEMBER',
      description: 'Standard team member access',
      isSystem: true,
      isDefault: true,
      perms: [
        'read:projects', 'manage:tasks', 'read:sprints',
        'read:boards', 'manage:time-entries', 'manage:chat',
      ],
    },
    {
      name: 'VIEWER',
      description: 'Read-only access',
      isSystem: true,
      perms: ['read:projects', 'read:tasks', 'read:sprints', 'read:boards'],
    },
  ];

  const roles: Record<string, string> = {};
  for (const def of roleDefinitions) {
    const role = await prisma.role.upsert({
      where: { organizationId_name: { organizationId: org.id, name: def.name } },
      update: {},
      create: {
        name: def.name,
        description: def.description,
        isSystem: def.isSystem,
        isDefault: def.isDefault ?? false,
        organizationId: org.id,
      },
    });
    roles[def.name] = role.id;

    // Link permissions via RolePermission
    for (const permKey of def.perms) {
      const permId = permissions[permKey];
      if (permId) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId: permId } },
          update: {},
          create: { roleId: role.id, permissionId: permId },
        });
      }
    }
  }

  console.log('Roles created:', Object.keys(roles));

  // ── Demo User ────────────────────────────────────────────────────────
  const user = await prisma.user.upsert({
    where: { email: 'demo@zentik.app' },
    update: {},
    create: {
      email: 'demo@zentik.app',
      name: 'Demo User',
      emailVerified: true,
    },
  });

  // Better Auth stores password in the Account model
  await prisma.account.upsert({
    where: { id: `${user.id}-credential` },
    update: {},
    create: {
      id: `${user.id}-credential`,
      userId: user.id,
      accountId: user.id,
      providerId: 'credential',
      password: 'Demo1234!', // Better Auth will hash on sign-in flow; for seed this is a placeholder
    },
  });

  console.log('User created:', user.id);

  // ── Add user to organization as OWNER ────────────────────────────────
  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId: org.id,
        userId: user.id,
      },
    },
    update: {},
    create: {
      userId: user.id,
      organizationId: org.id,
      roleId: roles['OWNER'],
    },
  });

  // ── Demo Project ─────────────────────────────────────────────────────
  const project = await prisma.project.upsert({
    where: {
      organizationId_slug: {
        organizationId: org.id,
        slug: 'zentik-platform',
      },
    },
    update: {},
    create: {
      name: 'Zentik Platform',
      description: 'Main development project for the Zentik platform',
      slug: 'zentik-platform',
      status: 'ACTIVE',
      organizationId: org.id,
      createdById: user.id,
    },
  });

  console.log('Project created:', project.id);

  // ── Add user as project member ───────────────────────────────────────
  await prisma.projectMember.upsert({
    where: {
      projectId_userId: {
        projectId: project.id,
        userId: user.id,
      },
    },
    update: {},
    create: {
      userId: user.id,
      projectId: project.id,
    },
  });

  // ── Board with columns ──────────────────────────────────────────────
  // Check if board already exists
  let board = await prisma.board.findFirst({
    where: { projectId: project.id, name: 'Main Board' },
    include: { columns: { orderBy: { position: 'asc' } } },
  });

  if (!board) {
    board = await prisma.board.create({
      data: {
        name: 'Main Board',
        projectId: project.id,
        columns: {
          create: [
            { name: 'Backlog', position: 0, color: '#6B7280' },
            { name: 'To Do', position: 1, color: '#3B82F6' },
            { name: 'In Progress', position: 2, color: '#F59E0B' },
            { name: 'In Review', position: 3, color: '#8B5CF6' },
            { name: 'Done', position: 4, color: '#10B981' },
          ],
        },
      },
      include: { columns: { orderBy: { position: 'asc' } } },
    });
  }

  console.log('Board created with', board.columns.length, 'columns');

  // ── Sample Tasks ────────────────────────────────────────────────────
  const taskData = [
    { title: 'Set up CI/CD pipeline', priority: 'HIGH' as const, status: 'DONE' as const, columnIndex: 4 },
    { title: 'Design database schema', priority: 'HIGH' as const, status: 'DONE' as const, columnIndex: 4 },
    { title: 'Implement authentication module', priority: 'URGENT' as const, status: 'IN_PROGRESS' as const, columnIndex: 2 },
    { title: 'Create REST API endpoints', priority: 'HIGH' as const, status: 'IN_PROGRESS' as const, columnIndex: 2 },
    { title: 'Build Kanban board UI', priority: 'MEDIUM' as const, status: 'IN_REVIEW' as const, columnIndex: 3 },
    { title: 'Add real-time notifications', priority: 'MEDIUM' as const, status: 'TODO' as const, columnIndex: 1 },
    { title: 'Implement time tracking', priority: 'MEDIUM' as const, status: 'TODO' as const, columnIndex: 1 },
    { title: 'Create reporting dashboard', priority: 'LOW' as const, status: 'BACKLOG' as const, columnIndex: 0 },
    { title: 'Add file upload support', priority: 'LOW' as const, status: 'BACKLOG' as const, columnIndex: 0 },
    { title: 'Write API documentation', priority: 'LOW' as const, status: 'BACKLOG' as const, columnIndex: 0 },
  ];

  let position = 1;
  for (const data of taskData) {
    const existing = await prisma.task.findFirst({
      where: { projectId: project.id, title: data.title },
    });
    if (!existing) {
      await prisma.task.create({
        data: {
          title: data.title,
          priority: data.priority,
          status: data.status,
          projectId: project.id,
          createdById: user.id,
          boardColumnId: board.columns[data.columnIndex].id,
          position,
        },
      });
    }
    position++;
  }

  console.log('Created', taskData.length, 'sample tasks');

  // ── Chat channel ────────────────────────────────────────────────────
  const existingChannel = await prisma.channel.findFirst({
    where: { organizationId: org.id, name: 'General' },
  });

  if (!existingChannel) {
    await prisma.channel.create({
      data: {
        name: 'General',
        isPrivate: false,
        projectId: project.id,
        organizationId: org.id,
        createdById: user.id,
      },
    });
  }

  console.log('Chat channel created');

  // ── Subscription ────────────────────────────────────────────────────
  await prisma.subscription.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      plan: 'PRO',
      status: 'ACTIVE',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  console.log('Subscription created');
  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
