-- Migration 0020: CRM permission for admin RBAC

INSERT INTO "permisos" ("clave") VALUES
    ('VIEW_CRM')
ON CONFLICT ("clave") DO NOTHING;
