-- Restringimos read:audit únicamente al rol Owner.
-- El Owner ya tiene *:* (acceso total) así que no necesita la regla explícita;
-- simplemente removemos read:audit de cualquier rol que no sea Owner.

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id"
  AND rp."permission_id" = p."id"
  AND p."action" = 'read'
  AND p."resource" = 'audit'
  AND r."name" <> 'Owner';
