'use strict';
const fs = require('fs');
const path = require('path');
/**
 * CRM routes — Contacts, Deals, Tasks
 *
 * GET    /crm/contacts                  List contacts (paginated, filterable)
 * GET    /crm/contacts/:id              Single contact with 360 view
 * POST   /crm/contacts                  Create contact
 * PATCH  /crm/contacts/:id              Update contact profile
 * PATCH  /crm/contacts/by-cedula        Update contact profile by cedula
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
const TSE_CONFIG_KEY = 'tse_config';
const TSE_LOOKUP_SUCCESS_TTL_MS = 5 * 60 * 1000;
const TSE_LOOKUP_NOT_FOUND_TTL_MS = 60 * 1000;
const TSE_LOOKUP_ERROR_TTL_MS = 30 * 1000;
const PADRON_RELOAD_TTL_MS = 5 * 60 * 1000;
const _tseLookupCache = new Map();
const _tseLookupInflight = new Map();
let _padronLookupCache = {
  loadedAt: 0,
  expiresAt: 0,
  filePath: null,
  mtimeMs: null,
  rowCount: 0,
  index: new Map(),
};

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
    if (!tenantId && !req.admin.superAdmin) return res.status(400).json({ error: 'tenantSlug required' });

    const page  = req.query.page  ?? 1;
    const limit = req.query.limit ?? 30;
    const skip  = (page - 1) * limit;
    const q     = req.query.q?.trim();

    const where = {
      ...(tenantId ? { tenantId } : {}),
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

router.get('/contacts/:id(\\d+)', [
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
    if (!tenantId && !req.admin.superAdmin) {
      return res.status(400).json({ error: 'tenantSlug required' });
    }

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

router.patch('/contacts/:id(\\d+)', [
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

router.patch('/contacts/by-cedula', [
  body('tenantSlug').optional().isString(),
  body('cedula').optional().isString().trim().notEmpty(),
  body('identificacion').optional().isString().trim().notEmpty(),
], async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const tenantId = await resolveBySlug(req, req.body.tenantSlug);
    if (!tenantId && !req.admin.superAdmin) {
      return res.status(400).json({ error: 'tenantSlug required' });
    }

    const cedula = String(req.body.cedula ?? req.body.identificacion ?? '').trim();
    const normalizedCedula = normalizeCedula(cedula);
    if (!normalizedCedula) {
      return res.status(400).json({ error: 'cedula or identificacion is required' });
    }

    const targetTenantId = resolveTenantId(req, tenantId);
    if (!targetTenantId) {
      return res.status(400).json({ error: 'tenantSlug required to sync with TSE' });
    }

    const tseLookup = await fetchTseProfileByCedula(targetTenantId, cedula);
    if (!tseLookup.ok) {
      if (tseLookup.notFound) {
        return res.status(404).json({ error: 'Cedula not found in TSE', detail: tseLookup.error ?? null });
      }
      return res.status(502).json({ error: 'TSE lookup failed', detail: tseLookup.error ?? 'Unable to fetch data from TSE API' });
    }

    const tseProfile = tseLookup.profile ?? {};
    const lookupSource = String(tseLookup.source || 'tse');
    const resolvedNombre = tseProfile.nombre ?? null;
    const resolvedEmail = tseProfile.email ?? null;
    const resolvedEmpresa = tseProfile.empresa ?? null;
    const resolvedCargo = tseProfile.cargo ?? null;
    const resolvedPhone = tseProfile.phone ?? null;

    const existing = await findContactByCedula(targetTenantId, cedula, normalizedCedula);

    if (!existing) {
      const createData = {
        tenantId: targetTenantId,
        nombre: resolvedNombre ?? `Contacto ${cedula}`,
        email: resolvedEmail,
        empresa: resolvedEmpresa,
        cargo: resolvedCargo,
        etiquetas: [],
        notas: null,
        leadScore: 0,
        phone: resolvedPhone,
        customFields: {
          cedula,
          identificacion: cedula,
          cedulaNormalizada: normalizedCedula,
          identificacionNormalizada: normalizedCedula,
          tseSyncedAt: new Date().toISOString(),
          tseSource: lookupSource,
          tseFallbackReason: tseLookup.fallbackReason ?? null,
          tseData: tseProfile,
        },
        ultimoContacto: new Date(),
      };

      const created = await prisma.user.create({ data: createData });
      audit({
        adminUserId: req.admin.adminUserId,
        tenantId: created.tenantId,
        accion: 'CREATE_CONTACT_BY_CEDULA',
        entidad: 'user',
        entidadId: String(created.id),
      });

      return res.json({
        ok: true,
        found: false,
        created: true,
        tseSynced: lookupSource === 'tse',
        dataSource: lookupSource,
        contactId: created.id,
        tenantId: created.tenantId,
        identificacion: cedula,
        nombre: created.nombre ?? null,
        email: created.email ?? null,
        empresa: created.empresa ?? null,
        cargo: created.cargo ?? null,
        phone: created.phone ?? null,
        updatedAt: created.updatedAt,
        contactoActualizado: created,
      });
    }
    if (!req.admin.superAdmin && existing.tenantId !== req.admin.tenantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const data = {};
    if (resolvedNombre != null) data.nombre = resolvedNombre;
    if (resolvedEmail != null) data.email = resolvedEmail;
    if (resolvedEmpresa != null) data.empresa = resolvedEmpresa;
    if (resolvedCargo != null) data.cargo = resolvedCargo;
    if (resolvedPhone != null) data.phone = resolvedPhone;
    const existingCustomFields = (existing.customFields && typeof existing.customFields === 'object')
      ? existing.customFields
      : {};

    data.customFields = {
      ...existingCustomFields,
      cedula,
      identificacion: cedula,
      cedulaNormalizada: normalizedCedula,
      identificacionNormalizada: normalizedCedula,
      tseSyncedAt: new Date().toISOString(),
      tseSource: lookupSource,
      tseFallbackReason: tseLookup.fallbackReason ?? null,
      tseData: tseProfile,
    };
    data.ultimoContacto = new Date();

    const updated = await prisma.user.update({ where: { id: existing.id }, data });
    audit({ adminUserId: req.admin.adminUserId, tenantId: existing.tenantId, accion: 'UPDATE_CONTACT_BY_CEDULA', entidad: 'user', entidadId: String(existing.id) });
    res.json({
      ok: true,
      found: true,
      created: false,
      tseSynced: lookupSource === 'tse',
      dataSource: lookupSource,
      contactId: updated.id,
      tenantId: updated.tenantId,
      identificacion: cedula,
      nombre: updated.nombre ?? null,
      email: updated.email ?? null,
      empresa: updated.empresa ?? null,
      cargo: updated.cargo ?? null,
      phone: updated.phone ?? null,
      updatedAt: updated.updatedAt,
      contactoActualizado: updated,
    });
  } catch (err) { next(err); }
});

router.delete('/contacts/:id(\\d+)', [param('id').isInt({ min: 1 }).toInt()], async (req, res, next) => {
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

function normalizeCedula(value) {
  return String(value ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function getCedulaCandidates(customFields) {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) return [];

  const keys = ['cedula', 'cedulaNumero', 'identificacion', 'identification', 'documento', 'dni', 'passport'];
  const values = [];

  for (const key of keys) {
    const raw = customFields[key];
    if (raw == null) continue;
    values.push(String(raw));
  }

  return values;
}

async function findContactByCedula(tenantId, cedula, normalizedCedula) {
  const searchValues = [...new Set([String(cedula).trim(), normalizedCedula].filter(Boolean))];
  const jsonKeys = ['cedula', 'cedulaNumero', 'identificacion', 'identification', 'documento', 'dni', 'passport', 'cedulaNormalizada', 'identificacionNormalizada'];
  const or = [];

  for (const key of jsonKeys) {
    for (const value of searchValues) {
      or.push({ customFields: { path: [key], equals: value } });
    }
  }

  if (or.length > 0) {
    const exact = await prisma.user.findFirst({
      where: { tenantId, OR: or },
      orderBy: { updatedAt: 'desc' },
    });
    if (exact) return exact;
  }

  const candidates = await prisma.user.findMany({
    where: { tenantId },
    select: {
      id: true,
      tenantId: true,
      customFields: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 3000,
  });

  for (const candidate of candidates) {
    const values = getCedulaCandidates(candidate.customFields);
    const matched = values.some((value) => {
      const raw = String(value).trim();
      const normalized = normalizeCedula(value);
      return searchValues.includes(raw) || searchValues.includes(normalized);
    });
    if (!matched) continue;

    return prisma.user.findUnique({ where: { id: candidate.id } });
  }

  return null;
}

async function findContactsByCedulaAnyTenant(cedula, normalizedCedula, limit = 2) {
  const searchValues = [...new Set([String(cedula).trim(), normalizedCedula].filter(Boolean))];
  const jsonKeys = ['cedula', 'cedulaNumero', 'identificacion', 'identification', 'documento', 'dni', 'passport', 'cedulaNormalizada', 'identificacionNormalizada'];
  const or = [];

  for (const key of jsonKeys) {
    for (const value of searchValues) {
      or.push({ customFields: { path: [key], equals: value } });
    }
  }

  if (or.length > 0) {
    const exact = await prisma.user.findMany({
      where: { OR: or },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    if (exact.length > 0) return exact;
  }

  const candidates = await prisma.user.findMany({
    select: {
      id: true,
      tenantId: true,
      customFields: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 5000,
  });

  const matches = [];
  for (const candidate of candidates) {
    const values = getCedulaCandidates(candidate.customFields);
    const matched = values.some((value) => {
      const raw = String(value).trim();
      const normalized = normalizeCedula(value);
      return searchValues.includes(raw) || searchValues.includes(normalized);
    });
    if (!matched) continue;

    const full = await prisma.user.findUnique({ where: { id: candidate.id } });
    if (full) matches.push(full);
    if (matches.length >= limit) break;
  }

  return matches;
}

async function fetchTseProfileByCedula(tenantId, cedula) {
  const normalizedCedula = normalizeCedula(cedula);
  const cacheKey = `${tenantId}::${normalizedCedula}`;
  const cached = getCachedTseLookup(cacheKey);
  if (cached) return cached;

  const inflight = _tseLookupInflight.get(cacheKey);
  if (inflight) return inflight;

  const lookupPromise = (async () => {
  const cfg = await loadTseConfig(tenantId);
  if (!cfg.exists) {
    return {
      ok: false,
      error: 'Tenant config "tse_config" is required to sync contacts by cedula',
    };
  }
  if (!cfg.url) {
    return {
      ok: false,
      error: 'TSE config missing (set tenant config key "tse_config" with url/baseUrl+endpoint from the interface)',
    };
  }
  if (!cfg.fieldMap) {
    return {
      ok: false,
      error: 'TSE config missing fieldMap (configure response mapping in tenant tse_config from the interface)',
    };
  }

  const method = String(cfg.method ?? 'GET').toUpperCase();
  const timeoutMs = Number.isFinite(Number(cfg.timeoutMs)) ? Number(cfg.timeoutMs) : 10000;
  const paramName = String(cfg.paramName || 'identificacion');
  const url = buildTseUrl(cfg.url, cedula, method, paramName);

  const headers = {
    Accept: 'application/json',
  };
  if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
    for (const [key, value] of Object.entries(cfg.headers)) {
      if (!key || value == null) continue;
      headers[String(key)] = String(value);
    }
  }
  if (method !== 'GET') headers['Content-Type'] = 'application/json';

  const token = String(cfg.token || '').trim();
  const authType = String(cfg.authType || (token ? 'bearer' : 'none')).toLowerCase();
  if (token) {
    if (authType === 'apikey') {
      headers[cfg.authHeader || 'x-api-key'] = token;
    } else if (authType === 'raw') {
      headers[cfg.authHeader || 'Authorization'] = token;
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const reqOptions = {
      method,
      headers,
      signal: controller.signal,
    };

    if (method !== 'GET') {
      reqOptions.body = JSON.stringify({ [paramName]: cedula });
    }

    const response = await fetch(url, reqOptions);
    const bodyText = await response.text();
    const payload = safeJsonParse(bodyText);

    if (!response.ok) {
      const fallback = await lookupPadronByCedula(cedula);
      if (fallback.ok) {
        const result = {
          ok: true,
          profile: fallback.profile,
          raw: fallback.raw,
          source: 'padron_fallback',
          fallbackReason: extractRemoteError(payload, bodyText, response.status),
        };
        setCachedTseLookup(cacheKey, result, TSE_LOOKUP_SUCCESS_TTL_MS);
        return result;
      }

      const result = {
        ok: false,
        notFound: response.status === 404,
        error: extractRemoteError(payload, bodyText, response.status),
      };
      setCachedTseLookup(cacheKey, result, response.status === 404 ? TSE_LOOKUP_NOT_FOUND_TTL_MS : TSE_LOOKUP_ERROR_TTL_MS);
      return result;
    }

    if (looksLikeNotFound(payload)) {
      const fallback = await lookupPadronByCedula(cedula);
      if (fallback.ok) {
        const result = {
          ok: true,
          profile: fallback.profile,
          raw: fallback.raw,
          source: 'padron_fallback',
          fallbackReason: 'TSE returned not-found response',
        };
        setCachedTseLookup(cacheKey, result, TSE_LOOKUP_SUCCESS_TTL_MS);
        return result;
      }

      const result = {
        ok: false,
        notFound: true,
        error: extractRemoteError(payload, bodyText, response.status),
      };
      setCachedTseLookup(cacheKey, result, TSE_LOOKUP_NOT_FOUND_TTL_MS);
      return result;
    }

    const profile = normalizeTsePayload(payload, cfg.fieldMap);
    const hasUsableProfile = ['nombre', 'email', 'phone', 'empresa', 'cargo']
      .some((key) => {
        const value = profile[key];
        return value != null && String(value).trim() !== '';
      });
    if (!hasUsableProfile) {
      const fallback = await lookupPadronByCedula(cedula);
      if (fallback.ok) {
        const result = {
          ok: true,
          profile: fallback.profile,
          raw: fallback.raw,
          source: 'padron_fallback',
          fallbackReason: 'TSE response without usable contact fields',
        };
        setCachedTseLookup(cacheKey, result, TSE_LOOKUP_SUCCESS_TTL_MS);
        return result;
      }

      const result = {
        ok: false,
        error: 'TSE response did not include usable contact fields (configure tse_config.fieldMap if needed)',
      };
      setCachedTseLookup(cacheKey, result, TSE_LOOKUP_ERROR_TTL_MS);
      return result;
    }

    const result = {
      ok: true,
      profile,
      raw: payload,
      source: 'tse',
    };
    setCachedTseLookup(cacheKey, result, TSE_LOOKUP_SUCCESS_TTL_MS);
    return result;
  } catch (err) {
    const fallback = await lookupPadronByCedula(cedula);
    if (fallback.ok) {
      const result = {
        ok: true,
        profile: fallback.profile,
        raw: fallback.raw,
        source: 'padron_fallback',
        fallbackReason: err?.name === 'AbortError'
          ? `TSE lookup timed out after ${timeoutMs}ms`
          : String(err?.message || err),
      };
      setCachedTseLookup(cacheKey, result, TSE_LOOKUP_SUCCESS_TTL_MS);
      return result;
    }

    const result = {
      ok: false,
      error: err?.name === 'AbortError'
        ? `TSE lookup timed out after ${timeoutMs}ms`
        : String(err?.message || err),
    };
    setCachedTseLookup(cacheKey, result, TSE_LOOKUP_ERROR_TTL_MS);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
  })();

  _tseLookupInflight.set(cacheKey, lookupPromise);
  try {
    return await lookupPromise;
  } finally {
    _tseLookupInflight.delete(cacheKey);
  }
}

async function loadTseConfig(tenantId) {
  const row = await prisma.configuracion.findUnique({
    where: { tenantId_clave: { tenantId, clave: TSE_CONFIG_KEY } },
    select: { valor: true },
  });
  const value = row?.valor && typeof row.valor === 'object' && !Array.isArray(row.valor)
    ? row.valor
    : {};

  const baseUrl = String(value.baseUrl || '').trim();
  const endpoint = String(value.endpoint || '').trim();
  const directUrl = String(value.url || '').trim();

  let url = directUrl;
  if (!url && baseUrl && endpoint) {
    url = `${baseUrl.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
  }

  return {
    exists: !!row,
    url,
    method: value.method || 'GET',
    timeoutMs: value.timeoutMs || 10000,
    paramName: value.identificacionParam || value.paramName || 'identificacion',
    token: value.token || value.apiKey || '',
    authType: value.authType || '',
    authHeader: value.authHeader || value.apiKeyHeader || '',
    headers: value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
      ? value.headers
      : null,
    fieldMap: value.fieldMap && typeof value.fieldMap === 'object' && !Array.isArray(value.fieldMap)
      ? value.fieldMap
      : null,
  };
}

function getCachedTseLookup(cacheKey) {
  const cached = _tseLookupCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    _tseLookupCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function setCachedTseLookup(cacheKey, value, ttlMs) {
  _tseLookupCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + Math.max(1, Number(ttlMs) || TSE_LOOKUP_ERROR_TTL_MS),
  });
}

function buildTseUrl(base, cedula, method, paramName) {
  const templateResolved = String(base)
    .replace(/\{\{\s*identificacion\s*\}\}/gi, encodeURIComponent(cedula))
    .replace(/\{\{\s*cedula\s*\}\}/gi, encodeURIComponent(cedula));

  if (method !== 'GET') return templateResolved;
  if (/\{\{\s*(identificacion|cedula)\s*\}\}/i.test(base)) return templateResolved;

  const url = new URL(templateResolved);
  if (!url.searchParams.has(paramName)) {
    url.searchParams.set(paramName, cedula);
  }
  return url.toString();
}

function safeJsonParse(rawText) {
  if (typeof rawText !== 'string') return rawText;
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function extractRemoteError(payload, bodyText, statusCode) {
  if (payload && typeof payload === 'object') {
    const candidate = payload.error || payload.message || payload.detail || payload.mensaje;
    if (candidate) return String(candidate);
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (typeof bodyText === 'string' && bodyText.trim()) return bodyText.trim();
  return `TSE API request failed with status ${statusCode}`;
}

function looksLikeNotFound(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

  const boolFlags = ['found', 'encontrado', 'exists', 'existe'];
  for (const key of boolFlags) {
    if (payload[key] === false) return true;
  }

  const msg = String(payload.error || payload.message || payload.mensaje || '').toLowerCase();
  if (msg.includes('not found') || msg.includes('no encontrado') || msg.includes('sin resultados')) {
    return true;
  }

  return false;
}

function normalizeTsePayload(payload, fieldMap = null) {
  const source = getPrimaryObject(payload);

  return {
    nombre: pickFromMap(source, fieldMap?.nombre),
    email: pickFromMap(source, fieldMap?.email),
    phone: pickFromMap(source, fieldMap?.phone),
    empresa: pickFromMap(source, fieldMap?.empresa),
    cargo: pickFromMap(source, fieldMap?.cargo),
  };
}

async function lookupPadronByCedula(cedula) {
  const normalizedCedula = normalizeCedula(cedula);
  if (!normalizedCedula) {
    return { ok: false, error: 'Invalid cedula' };
  }

  const indexState = await ensurePadronIndexLoaded();
  if (!indexState.ok) return indexState;

  const profile = indexState.index.get(normalizedCedula);
  if (!profile) {
    return { ok: false, notFound: true, error: 'Cedula not found in padron file' };
  }

  return {
    ok: true,
    profile,
    raw: {
      source: 'padron_file',
      filePath: indexState.filePath,
      rowsIndexed: indexState.rowCount,
    },
  };
}

async function ensurePadronIndexLoaded() {
  const resolvedPath = resolvePadronFilePath();
  if (!resolvedPath) {
    return {
      ok: false,
      error: 'Padron file is not configured (set PADRON_FILE_PATH)',
    };
  }

  let stat;
  try {
    stat = await fs.promises.stat(resolvedPath);
  } catch {
    return {
      ok: false,
      error: `Padron file not found at ${resolvedPath}`,
    };
  }

  const now = Date.now();
  const isFresh = _padronLookupCache.filePath === resolvedPath
    && _padronLookupCache.mtimeMs === stat.mtimeMs
    && _padronLookupCache.expiresAt > now
    && _padronLookupCache.index.size > 0;

  if (isFresh) {
    return {
      ok: true,
      filePath: _padronLookupCache.filePath,
      rowCount: _padronLookupCache.rowCount,
      index: _padronLookupCache.index,
    };
  }

  const raw = await fs.promises.readFile(resolvedPath, 'utf8');
  const index = buildPadronIndex(raw, resolvedPath);

  _padronLookupCache = {
    loadedAt: now,
    expiresAt: now + PADRON_RELOAD_TTL_MS,
    filePath: resolvedPath,
    mtimeMs: stat.mtimeMs,
    rowCount: index.size,
    index,
  };

  return {
    ok: true,
    filePath: _padronLookupCache.filePath,
    rowCount: _padronLookupCache.rowCount,
    index: _padronLookupCache.index,
  };
}

function resolvePadronFilePath() {
  const configuredPath = String(process.env.PADRON_FILE_PATH || '').trim();
  if (!configuredPath) return null;

  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
}

function buildPadronIndex(rawContent, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') return buildPadronJsonIndex(rawContent);
  return buildPadronCsvIndex(rawContent);
}

function buildPadronJsonIndex(rawContent) {
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return new Map();
  }

  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.data)
      ? parsed.data
      : Array.isArray(parsed?.records)
        ? parsed.records
        : [];

  const index = new Map();
  for (const item of records) {
    const normalizedCedula = normalizeCedula(extractPadronCedula(item));
    const nombre = extractPadronNombre(item);
    if (!normalizedCedula || !nombre) continue;

    index.set(normalizedCedula, {
      nombre,
      email: null,
      phone: null,
      empresa: null,
      cargo: null,
      source: 'padron_fallback',
    });
  }

  return index;
}

function buildPadronCsvIndex(rawContent) {
  const lines = String(rawContent || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return new Map();

  const delimiter = detectCsvDelimiter(lines[0]);
  const headerValues = splitCsvLine(lines[0], delimiter);
  const normalizedHeaders = headerValues.map(normalizeHeader);

  const index = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const values = splitCsvLine(lines[i], delimiter);
    if (values.length === 0) continue;

    const row = {};
    for (let j = 0; j < normalizedHeaders.length; j += 1) {
      const key = normalizedHeaders[j];
      if (!key) continue;
      row[key] = (values[j] ?? '').trim();
    }

    const normalizedCedula = normalizeCedula(extractPadronCedula(row));
    const nombre = extractPadronNombre(row);
    if (!normalizedCedula || !nombre) continue;

    index.set(normalizedCedula, {
      nombre,
      email: null,
      phone: null,
      empresa: null,
      cargo: null,
      source: 'padron_fallback',
    });
  }

  return index;
}

function detectCsvDelimiter(headerLine) {
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semicolonCount = (headerLine.match(/;/g) || []).length;
  return semicolonCount > commaCount ? ';' : ',';
}

function splitCsvLine(line, delimiter) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function extractPadronCedula(row) {
  if (!row || typeof row !== 'object') return null;

  const keys = [
    'cedula',
    'identificacion',
    'numeroidentificacion',
    'numerocedula',
    'documento',
    'id',
  ];
  return pickFirst(row, keys);
}

function extractPadronNombre(row) {
  if (!row || typeof row !== 'object') return null;

  const fullName = pickFirst(row, [
    'nombrecompleto',
    'nombre',
    'nombrerazonsocial',
    'razonsocial',
    'fullname',
  ]);
  if (fullName) return fullName;

  const firstName = pickFirst(row, ['nombres', 'primernombre', 'name']);
  const lastName = pickFirst(row, ['apellidos', 'primerapellido', 'lastname']);
  const joined = [firstName, lastName].filter(Boolean).join(' ').trim();
  return joined || null;
}

function getPrimaryObject(payload) {
  if (Array.isArray(payload)) {
    return payload.find((item) => item && typeof item === 'object' && !Array.isArray(item)) || {};
  }
  if (!payload || typeof payload !== 'object') return {};

  const candidates = [
    payload.data,
    payload.result,
    payload.persona,
    payload.person,
    Array.isArray(payload.results) ? payload.results[0] : null,
    Array.isArray(payload.data) ? payload.data[0] : null,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate;
    }
  }

  return payload;
}

function pickFromMap(source, mapping) {
  if (!mapping) return null;
  const paths = Array.isArray(mapping) ? mapping : [mapping];
  return pickFirst(source, paths.map((path) => String(path)));
}

function pickFirst(source, paths) {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (value == null) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    return normalized;
  }
  return null;
}

function getByPath(source, path) {
  if (!source || typeof source !== 'object') return undefined;
  const keys = String(path).split('.');
  let cursor = source;
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

module.exports = router;
