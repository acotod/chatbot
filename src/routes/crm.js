'use strict';
/**
 * CRM routes — Contacts, Deals, Tasks
 *
 * GET    /crm/contacts                  List contacts (paginated, filterable)
 * GET    /crm/contacts/:id              Single contact with 360 view
 * POST   /crm/contacts                  Create contact
 * PATCH  /crm/contacts/:id              Update contact profile
 * DELETE /crm/contacts/:id              Delete contact
 *
 * GET    /crm/deals                     List deals
 * POST   /crm/deals                     Create deal
 * PATCH  /crm/deals/:id                 Update deal
 * DELETE /crm/deals/:id                 Delete deal
 *
 * GET    /crm/tasks                     List tasks
 * POST   /crm/tasks                     Create task
 * PATCH  /crm/tasks/:id                 Update task (including complete)
 * DELETE /crm/tasks/:id                 Delete task
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const requireJwt = require('../middleware/requireJwt');
const requirePermiso = require('../middleware/requirePermiso');
const { audit } = require('../services/audit');

const prisma = new PrismaClient();
const router = express.Router();

router.use(requireJwt);
router.use(requirePermiso('VIEW_CRM'));

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array() });
    return false;
  }
  return true;
}

function resolveTenantId(req, explicit) {
  if (explicit) return explicit;
  return req.admin.tenantId ?? null;
}

// ── CONTACTS ─────────────────────────────────────────────────────────────────

router.get('/contacts', [
  query('tenantSlug').optional().isString(),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('q').optional().isString(),
  query('etiqueta').optional().isString(),
  query('canalOrigen').optional().isString(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const tenantId = await resolveBySlug(req, req.query.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug required' });

    const page  = req.query.page  ?? 1;
    const limit = req.query.limit ?? 30;
    const skip  = (page - 1) * limit;
    const q     = req.query.q?.trim();

    const where = {
      tenantId,
      ...(q ? {
        OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { phone:  { contains: q } },
          { email:  { contains: q, mode: 'insensitive' } },
          { empresa:{ contains: q, mode: 'insensitive' } },
        ],
      } : {}),
      ...(req.query.etiqueta ? { etiquetas: { has: req.query.etiqueta } } : {}),
      ...(req.query.canalOrigen ? { canalOrigen: req.query.canalOrigen } : {}),
    };

    const [contacts, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        orderBy: [{ ultimoContacto: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
        select: {
          id: true, phone: true, nombre: true, email: true, empresa: true,
          cargo: true, canalOrigen: true, etiquetas: true, leadScore: true,
          ultimoContacto: true, createdAt: true,
          _count: { select: { solicitudes: true, deals: true, tasks: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ data: contacts, total, page, limit });
  } catch (err) { next(err); }
});

router.get('/contacts/:id', [
  param('id').isInt({ min: 1 }).toInt(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const tenantId = await resolveBySlug(req, req.query.tenantSlug);
    const contact = await prisma.user.findFirst({
      where: { id: req.params.id, ...(tenantId ? { tenantId } : {}) },
      include: {
        solicitudes: {
          orderBy: { createdAt: 'desc' }, take: 10,
          include: { agente: { select: { id: true, nombre: true } } },
        },
        deals: {
          orderBy: { createdAt: 'desc' },
          include: { agente: { select: { id: true, nombre: true } } },
        },
        tasks: {
          orderBy: { createdAt: 'desc' }, take: 20,
          include: { agente: { select: { id: true, nombre: true } } },
        },
        mensajes: { orderBy: { createdAt: 'desc' }, take: 5,
          select: { id: true, tipo: true, contenido: true, createdAt: true } },
      },
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    // Tenant scope guard
    if (!req.admin.superAdmin && contact.tenantId !== req.admin.tenantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(contact);
  } catch (err) { next(err); }
});

router.post('/contacts', [
  body('tenantSlug').optional().isString(),
  body('phone').optional().isString(),
  body('nombre').optional().isString().isLength({ max: 120 }),
  body('email').optional().isEmail(),
  body('empresa').optional().isString().isLength({ max: 120 }),
  body('cargo').optional().isString().isLength({ max: 100 }),
  body('canalOrigen').optional().isString(),
  body('etiquetas').optional().isArray(),
  body('notas').optional().isString(),
  body('leadScore').optional().isInt({ min: 0, max: 100 }),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const tenantId = await resolveBySlug(req, req.body.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug required' });

    const { phone, nombre, email, empresa, cargo, canalOrigen, etiquetas, notas, leadScore, customFields } = req.body;
    const contact = await prisma.user.create({
      data: {
        tenantId,
        phone: phone ?? null,
        nombre: nombre ?? null,
        email: email ?? null,
        empresa: empresa ?? null,
        cargo: cargo ?? null,
        canalOrigen: canalOrigen ?? 'manual',
        etiquetas: etiquetas ?? [],
        notas: notas ?? null,
        leadScore: leadScore ?? 0,
        customFields: customFields ?? {},
        ultimoContacto: new Date(),
      },
    });

    audit({ adminUserId: req.admin.adminUserId, tenantId, accion: 'CREATE_CONTACT', entidad: 'user', entidadId: String(contact.id) });
    res.status(201).json(contact);
  } catch (err) { next(err); }
});

router.patch('/contacts/:id', [
  param('id').isInt({ min: 1 }).toInt(),
  body('nombre').optional().isString().isLength({ max: 120 }),
  body('email').optional().isEmail(),
  body('empresa').optional().isString().isLength({ max: 120 }),
  body('cargo').optional().isString().isLength({ max: 100 }),
  body('etiquetas').optional().isArray(),
  body('notas').optional().isString(),
  body('leadScore').optional().isInt({ min: 0, max: 100 }),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    if (!req.admin.superAdmin && existing.tenantId !== req.admin.tenantId) return res.status(403).json({ error: 'Forbidden' });

    const allowedFields = ['nombre','email','empresa','cargo','canalOrigen','etiquetas','notas','leadScore','customFields','phone'];
    const data = {};
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) data[f] = req.body[f];
    }

    const updated = await prisma.user.update({ where: { id: req.params.id }, data });
    audit({ adminUserId: req.admin.adminUserId, tenantId: existing.tenantId, accion: 'UPDATE_CONTACT', entidad: 'user', entidadId: String(req.params.id) });
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete('/contacts/:id', [param('id').isInt({ min: 1 }).toInt()], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    if (!req.admin.superAdmin && existing.tenantId !== req.admin.tenantId) return res.status(403).json({ error: 'Forbidden' });

    await prisma.user.delete({ where: { id: req.params.id } });
    audit({ adminUserId: req.admin.adminUserId, tenantId: existing.tenantId, accion: 'DELETE_CONTACT', entidad: 'user', entidadId: String(req.params.id) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── DEALS ─────────────────────────────────────────────────────────────────────

const DEAL_STAGES = ['nuevo', 'contactado', 'calificado', 'propuesta', 'negociacion', 'ganado', 'perdido'];

router.get('/deals', [
  query('tenantSlug').optional().isString(),
  query('etapa').optional().isString(),
  query('agenteId').optional().isInt({ min: 1 }).toInt(),
  query('userId').optional().isInt({ min: 1 }).toInt(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const tenantId = await resolveBySlug(req, req.query.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug required' });

    const where = {
      tenantId,
      ...(req.query.etapa ? { etapa: req.query.etapa } : {}),
      ...(req.query.agenteId ? { agenteId: req.query.agenteId } : {}),
      ...(req.query.userId ? { userId: req.query.userId } : {}),
    };

    const deals = await prisma.deal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, nombre: true, phone: true, empresa: true } },
        agente: { select: { id: true, nombre: true } },
        _count: { select: { tasks: true } },
      },
    });

    // Pipeline summary by stage
    const summary = DEAL_STAGES.map(etapa => ({
      etapa,
      count: deals.filter(d => d.etapa === etapa).length,
      valor: deals.filter(d => d.etapa === etapa).reduce((s, d) => s + Number(d.valor ?? 0), 0),
    }));

    res.json({ data: deals, summary });
  } catch (err) { next(err); }
});

router.post('/deals', [
  body('tenantSlug').optional().isString(),
  body('titulo').notEmpty().isString().isLength({ max: 200 }),
  body('etapa').optional().isIn(DEAL_STAGES),
  body('valor').optional().isDecimal(),
  body('userId').optional().isInt({ min: 1 }),
  body('agenteId').optional().isInt({ min: 1 }),
  body('probabilidad').optional().isInt({ min: 0, max: 100 }),
  body('notas').optional().isString(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const tenantId = await resolveBySlug(req, req.body.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug required' });

    const { titulo, etapa, valor, moneda, userId, agenteId, probabilidad, cierreEsperado, notas, customFields } = req.body;
    const deal = await prisma.deal.create({
      data: {
        tenantId,
        titulo,
        etapa: etapa ?? 'nuevo',
        valor: valor ? parseFloat(valor) : null,
        moneda: moneda ?? 'ARS',
        userId: userId ?? null,
        agenteId: agenteId ?? null,
        probabilidad: probabilidad ?? 0,
        cierreEsperado: cierreEsperado ? new Date(cierreEsperado) : null,
        notas: notas ?? null,
        customFields: customFields ?? {},
      },
      include: {
        user: { select: { id: true, nombre: true, phone: true } },
        agente: { select: { id: true, nombre: true } },
      },
    });

    audit({ adminUserId: req.admin.adminUserId, tenantId, accion: 'CREATE_DEAL', entidad: 'deal', entidadId: String(deal.id) });
    res.status(201).json(deal);
  } catch (err) { next(err); }
});

router.patch('/deals/:id', [
  param('id').isInt({ min: 1 }).toInt(),
  body('etapa').optional().isIn(DEAL_STAGES),
  body('valor').optional(),
  body('probabilidad').optional().isInt({ min: 0, max: 100 }),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const existing = await prisma.deal.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Deal not found' });
    if (!req.admin.superAdmin && existing.tenantId !== req.admin.tenantId) return res.status(403).json({ error: 'Forbidden' });

    const allowedFields = ['titulo','etapa','valor','moneda','userId','agenteId','probabilidad','cierreEsperado','notas','perdidoRazon','customFields'];
    const data = {};
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) data[f] = req.body[f];
    }
    if (data.etapa === 'ganado' && !existing.cerradoEn) data.cerradoEn = new Date();
    if (data.etapa === 'perdido' && !existing.cerradoEn) data.cerradoEn = new Date();
    if (data.cierreEsperado) data.cierreEsperado = new Date(data.cierreEsperado);
    if (data.valor) data.valor = parseFloat(data.valor);

    const updated = await prisma.deal.update({
      where: { id: req.params.id },
      data,
      include: {
        user: { select: { id: true, nombre: true, phone: true } },
        agente: { select: { id: true, nombre: true } },
      },
    });

    audit({ adminUserId: req.admin.adminUserId, tenantId: existing.tenantId, accion: 'UPDATE_DEAL', entidad: 'deal', entidadId: String(req.params.id) });
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete('/deals/:id', [param('id').isInt({ min: 1 }).toInt()], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const existing = await prisma.deal.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Deal not found' });
    if (!req.admin.superAdmin && existing.tenantId !== req.admin.tenantId) return res.status(403).json({ error: 'Forbidden' });

    await prisma.deal.delete({ where: { id: req.params.id } });
    audit({ adminUserId: req.admin.adminUserId, tenantId: existing.tenantId, accion: 'DELETE_DEAL', entidad: 'deal', entidadId: String(req.params.id) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── TASKS ─────────────────────────────────────────────────────────────────────

router.get('/tasks', [
  query('tenantSlug').optional().isString(),
  query('estado').optional().isString(),
  query('agenteId').optional().isInt({ min: 1 }).toInt(),
  query('userId').optional().isInt({ min: 1 }).toInt(),
  query('dealId').optional().isInt({ min: 1 }).toInt(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const tenantId = await resolveBySlug(req, req.query.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug required' });

    const where = {
      tenantId,
      ...(req.query.estado ? { estado: req.query.estado } : {}),
      ...(req.query.agenteId ? { agenteId: req.query.agenteId } : {}),
      ...(req.query.userId ? { userId: req.query.userId } : {}),
      ...(req.query.dealId ? { dealId: req.query.dealId } : {}),
    };

    const tasks = await prisma.crmTask.findMany({
      where,
      orderBy: [{ venceEn: 'asc' }, { createdAt: 'desc' }],
      include: {
        user: { select: { id: true, nombre: true, phone: true } },
        agente: { select: { id: true, nombre: true } },
        deal: { select: { id: true, titulo: true, etapa: true } },
      },
    });
    res.json({ data: tasks });
  } catch (err) { next(err); }
});

router.post('/tasks', [
  body('tenantSlug').optional().isString(),
  body('titulo').notEmpty().isString().isLength({ max: 200 }),
  body('tipo').optional().isString(),
  body('userId').optional().isInt({ min: 1 }),
  body('dealId').optional().isInt({ min: 1 }),
  body('agenteId').optional().isInt({ min: 1 }),
  body('venceEn').optional().isISO8601(),
  body('descripcion').optional().isString(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const tenantId = await resolveBySlug(req, req.body.tenantSlug);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug required' });

    const { titulo, tipo, userId, dealId, agenteId, venceEn, descripcion } = req.body;
    const task = await prisma.crmTask.create({
      data: {
        tenantId,
        titulo,
        tipo: tipo ?? 'seguimiento',
        userId: userId ?? null,
        dealId: dealId ?? null,
        agenteId: agenteId ?? null,
        venceEn: venceEn ? new Date(venceEn) : null,
        descripcion: descripcion ?? null,
      },
      include: {
        user: { select: { id: true, nombre: true, phone: true } },
        agente: { select: { id: true, nombre: true } },
        deal: { select: { id: true, titulo: true } },
      },
    });

    audit({ adminUserId: req.admin.adminUserId, tenantId, accion: 'CREATE_TASK', entidad: 'crm_task', entidadId: String(task.id) });
    res.status(201).json(task);
  } catch (err) { next(err); }
});

router.patch('/tasks/:id', [
  param('id').isInt({ min: 1 }).toInt(),
  body('estado').optional().isString(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const existing = await prisma.crmTask.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (!req.admin.superAdmin && existing.tenantId !== req.admin.tenantId) return res.status(403).json({ error: 'Forbidden' });

    const allowedFields = ['titulo','tipo','estado','userId','dealId','agenteId','venceEn','descripcion'];
    const data = {};
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) data[f] = req.body[f];
    }
    if (data.estado === 'completada' && !existing.completadoEn) data.completadoEn = new Date();
    if (data.venceEn) data.venceEn = new Date(data.venceEn);

    const updated = await prisma.crmTask.update({
      where: { id: req.params.id },
      data,
      include: {
        user: { select: { id: true, nombre: true, phone: true } },
        agente: { select: { id: true, nombre: true } },
        deal: { select: { id: true, titulo: true } },
      },
    });

    audit({ adminUserId: req.admin.adminUserId, tenantId: existing.tenantId, accion: 'UPDATE_TASK', entidad: 'crm_task', entidadId: String(req.params.id) });
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete('/tasks/:id', [param('id').isInt({ min: 1 }).toInt()], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const existing = await prisma.crmTask.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (!req.admin.superAdmin && existing.tenantId !== req.admin.tenantId) return res.status(403).json({ error: 'Forbidden' });

    await prisma.crmTask.delete({ where: { id: req.params.id } });
    audit({ adminUserId: req.admin.adminUserId, tenantId: existing.tenantId, accion: 'DELETE_TASK', entidad: 'crm_task', entidadId: String(req.params.id) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveBySlug(req, slug) {
  if (req.admin.superAdmin) {
    if (slug) {
      const t = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
      return t?.id ?? null;
    }
    return req.admin.tenantId ?? null;
  }
  return req.admin.tenantId ?? null;
}

module.exports = router;
