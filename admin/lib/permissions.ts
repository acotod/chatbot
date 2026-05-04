export type Permission =
  | 'VIEW_DASHBOARD'
  | 'VIEW_AGENDA'
  | 'CREATE_AGENDA'
  | 'EDIT_AGENDA'
  | 'DELETE_AGENDA'
  | 'VIEW_SOLICITUDES'
  | 'EDIT_SOLICITUDES'
  | 'VIEW_AGENTES'
  | 'EDIT_AGENTES'
  | 'VIEW_CONVERSACIONES'
  | 'VIEW_FLUJOS'
  | 'EDIT_FLUJOS'
  | 'VIEW_AUDITORIA'
  | 'MANAGE_ROLES'
  | 'MANAGE_TENANTS'
  | 'VIEW_METRICS';

export interface AdminUser {
  superAdmin: boolean;
  permissions: Permission[];
}

export function canAccess(user: AdminUser | null, permission: Permission): boolean {
  if (!user) return false;
  if (user.superAdmin) return true;
  return user.permissions.includes(permission);
}
