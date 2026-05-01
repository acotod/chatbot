'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const { audit } = require('../services/audit');

const prisma = new PrismaClient();
const router = express.Router();

router.use(requireJwt);

// ── Permisos ──────────────────────────────────────────────────────────────────

// GET /rbac/permisos
router.get('/permisos', requirePermiso('MANAGE_ROLES'), async (_req, res, next) => {
  try {
    const permisos = await prisma.permiso.findMany({ orderBy: { clave: 'asc' } });
    res.json(permisos);
  } catch (err) { next(err); }
});

// ── Roles ─────────────────────────────────────────────────────────────────────

// GET /rbac/roles
router.get('/roles', requirePermiso('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const where = req.admin.tenantId ? { tenantId: req.admin.tenantId } : {};
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

    const role = await prisma.role.create({
      data: {
        nombre,
        tenantId: tenantId ?? req.admin.tenantId ?? null,
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
    await prisma.role.delete({ where: { id: Number(req.params.id) } });
    audit({ adminUserId: req.admin.adminUserId, accion: 'DELETE_ROLE', entidad: 'role', entidadId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Admin Users ───────────────────────────────────────────────────────────────

// GET /rbac/users
router.get('/users', requirePermiso('MANAGE_ROLES'), async (_req, res, next) => {
  try {
    const users = await prisma.adminUser.findMany({
      select: { id: true, email: true, nombre: true, superAdmin: true, tenantId: true, createdAt: true,
        roles: { include: { role: { select: { id: true, nombre: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users);
  } catch (err) { next(err); }
});

// POST /rbac/users
router.post('/users', requirePermiso('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const { email, password, nombre, tenantId, roleIds, superAdmin } = req.body;
    if (!email || !password || !nombre) {
      return res.status(400).json({ error: 'email, password, nombre are required' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.adminUser.create({
      data: {
        email, passwordHash, nombre,
        tenantId: tenantId ?? null,
        superAdmin: superAdmin ?? false,
        roles: roleIds?.length ? { create: roleIds.map((id) => ({ roleId: id })) } : undefined,
      },
      select: { id: true, email: true, nombre: true, superAdmin: true, tenantId: true, createdAt: true },
    });
    audit({ adminUserId: req.admin.adminUserId, accion: 'CREATE_ADMIN_USER', entidad: 'admin_user', entidadId: user.id, metadata: { email } });
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// DELETE /rbac/users/:id
router.delete('/users/:id', requirePermiso('MANAGE_ROLES'), async (req, res, next) => {
  try {
    await prisma.adminUser.delete({ where: { id: Number(req.params.id) } });
    audit({ adminUserId: req.admin.adminUserId, accion: 'DELETE_ADMIN_USER', entidad: 'admin_user', entidadId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
