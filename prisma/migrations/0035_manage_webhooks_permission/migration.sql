-- Add MANAGE_WEBHOOKS permission so Webhooks module can be assigned via Roles.
INSERT INTO "permisos" ("clave") VALUES ('MANAGE_WEBHOOKS')
ON CONFLICT ("clave") DO NOTHING;
