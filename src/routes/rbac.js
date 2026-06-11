'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient, Prisma } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const { audit } = require('../services/audit');

const prisma = new PrismaClient();
const router = express.Router();

router.use(requireJwt);

// Helper — true when the caller is scoped to a single tenant (not global superAdmin)
function callerTenant(req) {
  return req.admin.superAdmin ? null : (req.admin.tenantId ?? null);
}

function handlePrismaWriteError(err, res) {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;

  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'Resource already exists' });
  }

  if (err.code === 'P2003') {
    return res.status(400).json({ error: 'Invalid relation reference' });
  }

  if (err.code === 'P2023') {
    return res.status(400).json({ error: 'Invalid field format' });
  }

  return false;
}

async function validateRoleAssignmentScope(roleIds, targetTenantId, callerIsTenantAdmin) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return null;

  const roles = await prisma.role.findMany({
    where: { id: { in: roleIds } },
    select: { id: true, tenantId: true },
  });

  if (roles.length !== roleIds.length) {
    return 'One or more roles do not exist';
  }

  if (callerIsTenantAdmin) {
    const invalidTenantRole = roles.find((role) => role.tenantId !== targetTenantId);
    if (invalidTenantRole) {
      return 'Tenant admins can only assign roles from their own tenant';
    }
    return null;
  }

  if (!targetTenantId) {
    const invalidGlobalRole = roles.find((role) => role.tenantId !== null);
    if (invalidGlobalRole) {
      return 'Global users can only have global roles';
    }
    return null;
  }

  const invalidTenantRole = roles.find(
    (role) => role.tenantId !== null && role.tenantId !== targetTenantId,
  );
  if (invalidTenantRole) {
    return 'Cannot assign roles from a different tenant';
  }

  return null;
}

// ── Permisos ──────────────────────────────────────────────────────────────────

// GET /rbac/permisos
// Accessible to both MANAGE_ROLES and MANAGE_USERS so users-only managers can see the list
router.get('/permisos', requirePermiso(['MANAGE_ROLES', 'MANAGE_USERS']), async (_req, res, next) => {
  try {
    const permisos = await prisma.permiso.findMany({ orderBy: { clave: 'asc' } });
    res.json(permisos);
  } catch (err) { next(err); }
});

// ── Roles ─────────────────────────────────────────────────────────────────────

// GET /rbac/roles
router.get('/roles', requirePermiso('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const tenant = callerTenant(req);
    const where = tenant ? { tenantId: tenant } : {};
    const roles = await prisma.role.findMany({
      where,
      include: { permisos: { include: { permiso: true } } },
      orderBy: { nombre: 'asc' },
    });
    res.json(roles);
  } catch (err) { next(err); }
});

// POST /rbac/roles
router.post('/roles', requirePermiso('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const { nombre, tenantId, permisoIds } = req.body;
    if (!nombre) return res.status(400).json({ error: 'nombre is required' });

    const tenant = callerTenant(req);
    // Tenant admins can only create roles for their own tenant
    const effectiveTenantId = tenant ?? tenantId ?? null;
    if (tenant && tenantId && tenantId !== tenant) {
      return res.status(403).json({ error: 'Cannot create roles for a different tenant' });
    }

    const role = await prisma.role.create({
      data: {
        nombre,
        tenantId: effectiveTenantId,
        permisos: permisoIds?.length
          ? { create: permisoIds.map((id) => ({ permisoId: id })) }
          : undefined,
      },
      include: { permisos: { include: { permiso: true } } },
    });
    audit({ adminUserId: req.admin.adminUserId, accion: 'CREATE_ROLE', entidad: 'role', entidadId: role.id, metadata: { nombre } });
    res.status(201).json(role);
  } catch (err) { next(err); }
});

// PATCH /rbac/roles/:id
router.patch('/roles/:id', requirePermiso('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const roleId = Number(req.params.id);
    const { nombre, permisoIds } = req.body;

    const tenant = callerTenant(req);
    if (tenant) {
      const existing = await prisma.role.findUnique({ where: { id: roleId }, select: { tenantId: true } });
      if (!existing) return res.status(404).json({ error: 'Role not found' });
      if (existing.tenantId !== tenant) return res.status(403).json({ error: 'Cannot modify roles from a different tenant' });
    }

    await prisma.rolePermiso.deleteMany({ where: { roleId } });

    const role = await prisma.role.update({
      where: { id: roleId },
      data: {
        nombre: nombre ?? undefined,
        permisos: permisoIds?.length
          ? { create: permisoIds.map((id) => ({ permisoId: id })) }
          : undefined,
      },
      include: { permisos: { include: { permiso: true } } },
    });
    audit({ adminUserId: req.admin.adminUserId, accion: 'UPDATE_ROLE', entidad: 'role', entidadId: roleId });
    res.json(role);
  } catch (err) { next(err); }
});

// DELETE /rbac/roles/:id
router.delete('/roles/:id', requirePermiso('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const roleId = Number(req.params.id);
    const tenant = callerTenant(req);
    if (tenant) {
      const existing = await prisma.role.findUnique({ where: { id: roleId }, select: { tenantId: true } });
      if (!existing) return res.status(404).json({ error: 'Role not found' });
      if (existing.tenantId !== tenant) return res.status(403).json({ error: 'Cannot delete roles from a different tenant' });
    }
    await prisma.role.delete({ where: { id: roleId } });
    audit({ adminUserId: req.admin.adminUserId, accion: 'DELETE_ROLE', entidad: 'role', entidadId: roleId });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Admin Users ───────────────────────────────────────────────────────────────

// GET /rbac/users
router.get('/users', requirePermiso(['MANAGE_ROLES', 'MANAGE_USERS']), async (req, res, next) => {
  try {
    const tenant = callerTenant(req);
    // Tenant admins cannot see superAdmin users
    const where = tenant ? { tenantId: tenant, superAdmin: false } : {};
    const users = await prisma.adminUser.findMany({
      where,
      select: { id: true, email: true, nombre: true, superAdmin: true, tenantId: true, createdAt: true,
        roles: { include: { role: { select: { id: true, nombre: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users);
  } catch (err) { next(err); }
});

// POST /rbac/users
router.post('/users', requirePermiso(['MANAGE_ROLES', 'MANAGE_USERS']), async (req, res, next) => {
  try {
    const { email, password, nombre, tenantId, roleIds, superAdmin } = req.body;
    if (!email || !password || !nombre) {
      return res.status(400).json({ error: 'email, password, nombre are required' });
    }

    const tenant = callerTenant(req);
    // MANAGE_USERS callers (without MANAGE_ROLES and not superAdmin) cannot assign roles
    const canManageRoles = req.admin?.superAdmin || (req.admin?.permissions ?? []).includes('MANAGE_ROLES');
    const effectiveRoleIds = canManageRoles ? roleIds : undefined;

    if (tenant) {
      // Tenant admins can only create users in their own tenant and cannot elevate to superAdmin
      if (tenantId && tenantId !== tenant) {
        return res.status(403).json({ error: 'Cannot create users for a different tenant' });
      }
      if (superAdmin) {
        return res.status(403).json({ error: 'Cannot create superAdmin users' });
      }
    }

    const effectiveTenantId = tenant ?? tenantId ?? null;
    const roleScopeError = await validateRoleAssignmentScope(effectiveRoleIds, effectiveTenantId, Boolean(tenant));
    if (roleScopeError) {
      return res.status(400).json({ error: roleScopeError });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.adminUser.create({
      data: {
        email, passwordHash, nombre,
        tenantId: effectiveTenantId,
        superAdmin: tenant ? false : (superAdmin ?? false),
        roles: effectiveRoleIds?.length ? { create: effectiveRoleIds.map((id) => ({ roleId: id })) } : undefined,
      },
      select: { id: true, email: true, nombre: true, superAdmin: true, tenantId: true, createdAt: true,
        roles: { include: { role: { select: { id: true, nombre: true } } } } },
    });
    audit({ adminUserId: req.admin.adminUserId, accion: 'CREATE_ADMIN_USER', entidad: 'admin_user', entidadId: user.id, metadata: { email } });
    res.status(201).json(user);
  } catch (err) {
    if (handlePrismaWriteError(err, res)) return;
    next(err);
  }
});

// PATCH /rbac/users/:id
router.patch('/users/:id', requirePermiso(['MANAGE_ROLES', 'MANAGE_USERS']), async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { nombre, email, password, tenantId, roleIds } = req.body;
    // MANAGE_USERS callers (without MANAGE_ROLES and not superAdmin) cannot change role assignments
    const canManageRoles = req.admin?.superAdmin || (req.admin?.permissions ?? []).includes('MANAGE_ROLES');

    const existing = await prisma.adminUser.findUnique({ where: { id: userId }, select: { superAdmin: true, tenantId: true } });
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const tenant = callerTenant(req);
    if (tenant) {
      // Tenant admins cannot modify superAdmin users
      if (existing.superAdmin) return res.status(403).json({ error: 'Cannot modify superAdmin users' });
      // Tenant admins can only edit users from their own tenant
      if (existing.tenantId !== tenant) return res.status(403).json({ error: 'Cannot modify users from a different tenant' });
      // Cannot move a user out of the tenant
      if (tenantId !== undefined && tenantId !== tenant) {
        return res.status(403).json({ error: 'Cannot reassign users to a different tenant' });
      }
    }

    const effectiveTenantId = tenant
      ? tenant
      : (tenantId !== undefined ? (tenantId ?? null) : existing.tenantId);

    // Only allow role assignment changes if caller has MANAGE_ROLES (or superAdmin)
    const effectiveRoleIds = canManageRoles ? roleIds : undefined;
    const roleScopeError2 = await validateRoleAssignmentScope(effectiveRoleIds, effectiveTenantId, Boolean(tenant));
    if (roleScopeError2) {
      return res.status(400).json({ error: roleScopeError2 });
    }

    const data = {};
    if (nombre) data.nombre = nombre;
    if (email) data.email = email;
    if (password) data.passwordHash = await bcrypt.hash(password, 12);
    // Only superAdmin callers can change tenantId
    if (tenantId !== undefined && !tenant) data.tenantId = tenantId ?? null;

    if (effectiveRoleIds !== undefined) {
      await prisma.adminUserRole.deleteMany({ where: { adminUserId: userId } });
      data.roles = effectiveRoleIds?.length
        ? { create: effectiveRoleIds.map((id) => ({ roleId: id })) }
        : undefined;
    }

    const user = await prisma.adminUser.update({
      where: { id: userId },
      data,
      select: { id: true, email: true, nombre: true, superAdmin: true, tenantId: true, createdAt: true,
        roles: { include: { role: { select: { id: true, nombre: true } } } } },
    });
    audit({ adminUserId: req.admin.adminUserId, accion: 'UPDATE_ADMIN_USER', entidad: 'admin_user', entidadId: userId });
    res.json(user);
  } catch (err) {
    if (handlePrismaWriteError(err, res)) return;
    next(err);
  }
});

// DELETE /rbac/users/:id
router.delete('/users/:id', requirePermiso(['MANAGE_ROLES', 'MANAGE_USERS']), async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const tenant = callerTenant(req);
    if (tenant) {
      const existing = await prisma.adminUser.findUnique({ where: { id: userId }, select: { tenantId: true, superAdmin: true } });
      if (!existing) return res.status(404).json({ error: 'User not found' });
      if (existing.superAdmin) return res.status(403).json({ error: 'Cannot delete superAdmin users' });
      if (existing.tenantId !== tenant) return res.status(403).json({ error: 'Cannot delete users from a different tenant' });
    }
    await prisma.adminUser.delete({ where: { id: userId } });
    audit({ adminUserId: req.admin.adminUserId, accion: 'DELETE_ADMIN_USER', entidad: 'admin_user', entidadId: userId });
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      return res.status(409).json({ error: 'Cannot delete user with related records' });
    }
    if (handlePrismaWriteError(err, res)) return;
    next(err);
  }
});

module.exports = router;
