-- Create the read:chat permission (was missing from initial seed)
INSERT INTO "permissions" ("id", "action", "resource", "description", "created_at")
VALUES (gen_random_uuid(), 'read', 'chat', 'Read chat', NOW())
ON CONFLICT ("action", "resource") DO NOTHING;

-- Assign read:chat to ALL "Cliente" roles that don't have it yet
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."name" = 'Cliente'
  AND p."action" = 'read'
  AND p."resource" = 'chat'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  );

-- Also ensure write:chat is assigned (in case previous fix only partially ran)
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."name" = 'Cliente'
  AND p."action" = 'write'
  AND p."resource" = 'chat'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  );
