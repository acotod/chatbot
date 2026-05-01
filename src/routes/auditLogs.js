'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');

const prisma = new PrismaClient();
const router = express.Router();

router.use(requireJwt);

/**
 * GET /audit?page=1&limit=50&accion=LOGIN&tenantId=xxx
 */
router.get('/', requirePermiso('VIEW_AUDITORIA'), async (req, res, next) => {
  try {
    const page  = Math.max(1, Number(req.query.page)  || 1);
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const where = {};
    if (req.query.accion)   where.accion   = req.query.accion;
    if (req.query.entidad)  where.entidad  = req.query.entidad;
    if (req.query.tenantId) where.tenantId = req.query.tenantId;

    // Non-super-admins see only their tenant
    if (!req.admin.superAdmin && req.admin.tenantId) {
      where.tenantId = req.admin.tenantId;
    }

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        include: { adminUser: { select: { email: true, nombre: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    res.json({ total, page, limit, data: logs });
  } catch (err) { next(err); }
});

module.exports = router;
