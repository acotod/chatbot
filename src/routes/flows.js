'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const { audit } = require('../services/audit');
const { executeStep } = require('../services/flowEngine');

const prisma = new PrismaClient();
const router = express.Router();

router.use(requireJwt);

// ── CRUD flows ────────────────────────────────────────────────────────────────

// GET /flows?tenantSlug=xxx
router.get('/', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const { tenantSlug } = req.query;
    const where = {};

    if (tenantSlug) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      where.tenantId = tenant.id;
    } else if (!req.admin.superAdmin && req.admin.tenantId) {
      where.tenantId = req.admin.tenantId;
    }

    const flows = await prisma.flow.findMany({
      where,
      include: { nodes: true, edges: true },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(flows);
  } catch (err) { next(err); }
});

// POST /flows
router.post('/', requirePermiso('EDIT_FLUJOS'), async (req, res, next) => {
  try {
    const { tenantId, nombre } = req.body;
    if (!tenantId || !nombre) return res.status(400).json({ error: 'tenantId and nombre are required' });

    const flow = await prisma.flow.create({
      data: { tenantId, nombre },
      include: { nodes: true, edges: true },
    });
    audit({ adminUserId: req.admin.adminUserId, tenantId, accion: 'CREATE_FLOW', entidad: 'flow', entidadId: flow.id, metadata: { nombre } });
    res.status(201).json(flow);
  } catch (err) { next(err); }
});

// GET /flows/:id
router.get('/:id', requirePermiso('VIEW_FLUJOS'), async (req, res, next) => {
  try {
    const flow = await prisma.flow.findUnique({
      where: { id: Number(req.params.id) },
      include: { nodes: true, edges: true },
    });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    res.json(flow);
  } catch (err) { next(err); }
});

// PUT /flows/:id — full replace (nodes + edges)
router.put('/:id', requirePermiso('EDIT_FLUJOS'), async (req, res, next) => {
  try {
    const flowId = Number(req.params.id);
    const { nombre, activo, nodes, edges } = req.body;

    const existing = await prisma.flow.findUnique({ where: { id: flowId } });
    if (!existing) return res.status(404).json({ error: 'Flow not found' });

    // Transactionally replace nodes + edges
    const flow = await prisma.$transaction(async (tx) => {
      await tx.flowEdge.deleteMany({ where: { flowId } });
      await tx.flowNode.deleteMany({ where: { flowId } });

      const updated = await tx.flow.update({
        where: { id: flowId },
        data: {
          nombre: nombre ?? existing.nombre,
          activo: activo ?? existing.activo,
          version: { increment: 1 },
          nodes: nodes?.length
            ? { create: nodes.map(({ type, content, posX = 0, posY = 0 }) => ({ type, content, posX, posY })) }
            : undefined,
        },
        include: { nodes: true },
      });

      // Re-create edges using new node IDs mapped by index
      if (edges?.length && nodes?.length) {
        const nodeIdMap = {}; // old_index → new DB id
        updated.nodes.forEach((n, i) => { nodeIdMap[i] = n.id; });

        await tx.flowEdge.createMany({
          data: edges.map(({ sourceIndex, targetIndex, condition }) => ({
            flowId,
            sourceNodeId: nodeIdMap[sourceIndex],
            targetNodeId: nodeIdMap[targetIndex],
            condition: condition ?? null,
          })),
        });
      }

      return tx.flow.findUnique({
        where: { id: flowId },
        include: { nodes: true, edges: true },
      });
    });

    audit({
      adminUserId: req.admin.adminUserId,
      tenantId: existing.tenantId,
      accion: 'UPDATE_FLOW',
      entidad: 'flow',
      entidadId: flowId,
      metadata: { nombre, version: flow.version },
    });
    res.json(flow);
  } catch (err) { next(err); }
});

// DELETE /flows/:id
router.delete('/:id', requirePermiso('EDIT_FLUJOS'), async (req, res, next) => {
  try {
    const flow = await prisma.flow.delete({ where: { id: Number(req.params.id) } });
    audit({ adminUserId: req.admin.adminUserId, tenantId: flow.tenantId, accion: 'DELETE_FLOW', entidad: 'flow', entidadId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Flow engine step ──────────────────────────────────────────────────────────

// POST /flows/execute
router.post('/execute', async (req, res, next) => {
  try {
    const { tenantId, currentNodeId, input } = req.body;
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
    const result = await executeStep({ tenantId, currentNodeId: currentNodeId ?? null, input: input ?? null });
    if (!result) return res.status(404).json({ error: 'No next node found' });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
