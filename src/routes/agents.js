'use strict';

const express = require('express');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

function parsePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

// GET /api/agents/available?puestoId=1
// GET /api/agents/available?puesto=Ventas
// Optional: &tenant=<tenant-id|tenant-slug> (validated against resolved tenant)
router.get('/available', async (req, res, next) => {
  try {
    const resolvedTenant = req.tenant;
    if (!resolvedTenant?.id) {
      return res.status(401).json({ error: 'Tenant not resolved' });
    }

    const tenantParamRaw = String(
      req.query?.tenant
      ?? req.query?.tenantId
      ?? req.query?.tenantSlug
      ?? ''
    ).trim();

    if (
      tenantParamRaw
      && tenantParamRaw !== resolvedTenant.id
      && tenantParamRaw.toLowerCase() !== String(resolvedTenant.slug || '').toLowerCase()
    ) {
      return res.status(403).json({ error: 'tenant parameter does not match API key tenant' });
    }

    const puestoId = parsePositiveInt(req.query?.puestoId ?? req.query?.puesto_id);
    const puestoNombre = String(
      req.query?.puesto
      ?? req.query?.puestoNombre
      ?? req.query?.puesto_nombre
      ?? ''
    ).trim();

    const where = {
      tenantId: resolvedTenant.id,
      estado: 'activo',
    };

    if (puestoId) {
      where.puestoId = puestoId;
    } else if (puestoNombre) {
      where.puesto = {
        is: {
          nombre: {
            equals: puestoNombre,
            mode: 'insensitive',
          },
          activo: true,
        },
      };
    }

    const agentes = await prisma.agente.findMany({
      where,
      select: {
        id: true,
        nombre: true,
        email: true,
        whatsapp: true,
        estado: true,
        puestoId: true,
        puesto: { select: { id: true, nombre: true } },
      },
      orderBy: { nombre: 'asc' },
    });

    return res.json({
      tenantId: resolvedTenant.id,
      tenantSlug: resolvedTenant.slug,
      filters: {
        puestoId: puestoId ?? null,
        puesto: puestoNombre || null,
      },
      total: agentes.length,
      agentes,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;