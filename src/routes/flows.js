'use strict';
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');

const router = express.Router();
const prisma = new PrismaClient();
router.use(requireJwt);

function tid(req) {
  return req.user?.tenantId ?? req.user?.tenant_id;
}

router.get('/', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const where = { tenantId };
    const flows = await prisma.flow.findMany({ where, include: { nodes: true, edges: true }, orderBy: { updatedAt: 'desc' } });
    res.json(flows);
  } catch (err) { next(err); }
});

router.get('/export', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const flows = await prisma.flow.findMany({ where: { tenantId }, include: { nodes: true, edges: true } });
    res.json(flows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const flow = await prisma.flow.findFirst({ where: { id, tenantId }, include: { nodes: true, edges: true } });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    res.json(flow);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const nombre = String(req.body?.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'nombre is required' });
    const flow = await prisma.flow.create({ data: { tenantId, nombre }, include: { nodes: true, edges: true } });
    res.status(201).json(flow);
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = await prisma.flow.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: 'Flow not found' });
    const data = {};
    if (req.body?.nombre !== undefined) data.nombre = String(req.body.nombre).trim();
    if (req.body?.activo !== undefined) data.activo = Boolean(req.body.activo);
    if (req.body?.metaJson !== undefined) data.metaJson = req.body.metaJson;
    const updated = await prisma.flow.update({ where: { id }, data, include: { nodes: true, edges: true } });
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const existing = await prisma.flow.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: 'Flow not found' });
    await prisma.flow.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/:id/execute', async (req, res, next) => {
  try {
    const tenantId = tid(req);
    const id = Number(req.params.id);
    const flow = await prisma.flow.findFirst({ where: { id, tenantId } });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    res.json({ success: true, flowId: id });
  } catch (err) { next(err); }
});

module.exports = router;
