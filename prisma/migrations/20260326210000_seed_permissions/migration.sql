-- Seed permissions table (required for role-permission assignment)
INSERT INTO "permissions" ("id", "action", "resource", "description", "created_at")
VALUES
  ('perm_full_access', '*', '*', 'Full access', NOW()),
  ('perm_manage_projects', 'manage', 'projects', 'Manage projects', NOW()),
  ('perm_manage_tasks', 'manage', 'tasks', 'Manage tasks', NOW()),
  ('perm_manage_members', 'manage', 'members', 'Manage members', NOW()),
  ('perm_manage_sprints', 'manage', 'sprints', 'Manage sprints', NOW()),
  ('perm_manage_boards', 'manage', 'boards', 'Manage boards', NOW()),
  ('perm_manage_time_entries', 'manage', 'time-entries', 'Manage time entries', NOW()),
  ('perm_manage_chat', 'manage', 'chat', 'Manage chat', NOW()),
  ('perm_read_projects', 'read', 'projects', 'Read projects', NOW()),
  ('perm_read_tasks', 'read', 'tasks', 'Read tasks', NOW()),
  ('perm_read_members', 'read', 'members', 'Read members', NOW()),
  ('perm_read_sprints', 'read', 'sprints', 'Read sprints', NOW()),
  ('perm_read_boards', 'read', 'boards', 'Read boards', NOW()),
  ('perm_read_billing', 'read', 'billing', 'Read billing', NOW()),
  ('perm_read_audit', 'read', 'audit', 'Read audit logs', NOW())
ON CONFLICT ("action", "resource") DO NOTHING;

-- Now link permissions to existing roles that were created without them.
-- For each organization's roles, insert role_permissions based on the expected mapping.

-- Owner: *:*
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'Owner' AND p.action = '*' AND p.resource = '*'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Product Owner: manage:projects, manage:tasks, manage:sprints, manage:boards, manage:members, read:members, read:billing, manage:chat
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'Product Owner'
  AND (p.action || ':' || p.resource) IN (
    'manage:projects', 'manage:tasks', 'manage:sprints', 'manage:boards',
    'manage:members', 'read:members', 'read:billing', 'manage:chat'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Project Manager: manage:projects, manage:tasks, manage:sprints, manage:boards, manage:members, manage:time-entries, read:billing, manage:chat, read:audit
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'Project Manager'
  AND (p.action || ':' || p.resource) IN (
    'manage:projects', 'manage:tasks', 'manage:sprints', 'manage:boards',
    'manage:members', 'manage:time-entries', 'read:billing', 'manage:chat', 'read:audit'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Tech Lead: read:projects, manage:tasks, manage:sprints, manage:boards, manage:time-entries, read:members, manage:chat
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'Tech Lead'
  AND (p.action || ':' || p.resource) IN (
    'read:projects', 'manage:tasks', 'manage:sprints', 'manage:boards',
    'manage:time-entries', 'read:members', 'manage:chat'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Developer: read:projects, manage:tasks, read:sprints, read:boards, manage:time-entries, manage:chat
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'Developer'
  AND (p.action || ':' || p.resource) IN (
    'read:projects', 'manage:tasks', 'read:sprints', 'read:boards',
    'manage:time-entries', 'manage:chat'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- QA Engineer: read:projects, manage:tasks, read:sprints, read:boards, manage:time-entries, manage:chat
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'QA Engineer'
  AND (p.action || ':' || p.resource) IN (
    'read:projects', 'manage:tasks', 'read:sprints', 'read:boards',
    'manage:time-entries', 'manage:chat'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Designer: read:projects, manage:tasks, read:boards, manage:time-entries, manage:chat
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'Designer'
  AND (p.action || ':' || p.resource) IN (
    'read:projects', 'manage:tasks', 'read:boards',
    'manage:time-entries', 'manage:chat'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- DevOps: read:projects, read:tasks, read:sprints, manage:time-entries, manage:chat
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'DevOps'
  AND (p.action || ':' || p.resource) IN (
    'read:projects', 'read:tasks', 'read:sprints',
    'manage:time-entries', 'manage:chat'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Soporte: read:projects, read:tasks, manage:time-entries, manage:chat
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'Soporte'
  AND (p.action || ':' || p.resource) IN (
    'read:projects', 'read:tasks', 'manage:time-entries', 'manage:chat'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Cliente: read:projects, read:tasks
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'Cliente'
  AND (p.action || ':' || p.resource) IN ('read:projects', 'read:tasks')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
