-- Ensure write:chat permission exists
INSERT INTO "permissions" ("id", "action", "resource", "description")
VALUES (gen_random_uuid(), 'write', 'chat', 'Write chat')
ON CONFLICT ("action", "resource") DO NOTHING;

-- Add read:chat and write:chat to all "Cliente" roles that don't have them yet
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."name" = 'Cliente'
  AND p."action" IN ('read', 'write')
  AND p."resource" = 'chat'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  );
