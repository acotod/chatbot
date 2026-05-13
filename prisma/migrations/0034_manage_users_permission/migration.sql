-- Add MANAGE_USERS permission
-- Users with this permission can create/edit/delete admin users but cannot manage roles.
INSERT INTO "permisos" ("clave") VALUES ('MANAGE_USERS')
ON CONFLICT ("clave") DO NOTHING;
