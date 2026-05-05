'use strict';
/**
 * Variables Manager API
 *
 * GET    /variables            — list variables (query: ?flowId=, ?scope=)
 * POST   /variables            — create variable
 * PUT    /variables/:id        — update variable
 * DELETE /variables/:id        — delete variable
 *
 * All routes require JWT. tenantId from req.user.
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');

const router = express.Router();
const prisma = new PrismaClient();

router.use(requireJwt);

function tid(req) {
  return req.user?.tenantId ?? req.user?.tenant_id;
}

const VALID_TYPES = ['string', 'number', 'boolean', 'object', 'array'];
const VALID_SCOPES = ['global', 'flow', 'session'];

// GET /variables
router.get('/', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const { flowId, scope } = req.query;
    const where = { tenantId };
    if (flowId !== undefined) {
      where.flowId = flowId === 'null' || flowId === '' ? null : Number(flowId);
    }
    if (scope) where.scope = scope;

    const variables = await prisma.flowVariable.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { nombre: 'asc' }],
      include: {
        flow: { select: { id: true, nombre: true } },
      },
    });
    res.json(variables);
  } catch (err) {
    next(err);
  }
});

// POST /variables
router.post('/', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const { flowId, nombre, tipo = 'string', valorDefault, descripcion, scope = 'flow' } = req.body;

    if (!nombre || nombre.trim() === '')
      return res.status(400).json({ error: 'nombre is required' });
    if (!VALID_TYPES.includes(tipo))
      return res.status(400).json({ error: `tipo must be one of: ${VALID_TYPES.join(', ')}` });
    if (!VALID_SCOPES.includes(scope))
      return res.status(400).json({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}` });

    // Validate flowId exists if provided
    if (flowId) {
      const flow = await prisma.flow.findFirst({ where: { id: Number(flowId), tenantId } });
      if (!flow) return res.status(400).json({ error: 'flowId does not exist for this tenant' });
    }

    const variable = await prisma.flowVariable.create({
      data: {
        tenantId,
        flowId: flowId ? Number(flowId) : null,
        nombre: nombre.trim(),
        tipo,
        valorDefault: valorDefault !== undefined ? valorDefault : null,
        descripcion: descripcion?.trim() || null,
        scope,
      },
      include: { flow: { select: { id: true, nombre: true } } },
    });
    res.status(201).json(variable);
  } catch (err) {
    next(err);
  }
});

// PUT /variables/:id
router.put('/:id', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const existing = await prisma.flowVariable.findFirst({
      where: { id: Number(req.params.id), tenantId },
    });
    if (!existing) return res.status(404).json({ error: 'Variable not found' });

    const { nombre, tipo, valorDefault, descripcion, scope } = req.body;
    const patch = {};
    if (nombre !== undefined) patch.nombre = nombre.trim();
    if (tipo !== undefined) {
      if (!VALID_TYPES.includes(tipo))
        return res.status(400).json({ error: `tipo must be one of: ${VALID_TYPES.join(', ')}` });
      patch.tipo = tipo;
    }
    if (valorDefault !== undefined) patch.valorDefault = valorDefault;
    if (descripcion !== undefined) patch.descripcion = descripcion?.trim() || null;
    if (scope !== undefined) {
      if (!VALID_SCOPES.includes(scope))
        return res.status(400).json({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}` });
      patch.scope = scope;
    }

    const updated = await prisma.flowVariable.update({
      where: { id: Number(req.params.id) },
      data: patch,
      include: { flow: { select: { id: true, nombre: true } } },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /variables/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const existing = await prisma.flowVariable.findFirst({
      where: { id: Number(req.params.id), tenantId },
    });
    if (!existing) return res.status(404).json({ error: 'Variable not found' });
    await prisma.flowVariable.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
