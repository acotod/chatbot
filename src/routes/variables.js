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
  return req.admin?.tenantId ?? req.user?.tenantId ?? req.user?.tenant_id;
}

function requireTenantId(req, res) {
  const tenantId = tid(req);
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId is required in token context' });
    return null;
  }
  return tenantId;
}

const VALID_TYPES = ['string', 'number', 'boolean', 'object', 'array'];
const VALID_SCOPES = ['global', 'flow', 'session'];

// GET /variables
router.get('/', async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
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
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
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
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
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
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
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

// POST /variables/seed-defaults
// Creates all standard chatbot variables for the tenant (skips already-existing ones).
router.post('/seed-defaults', async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    const DEFAULTS = [
      // ── Sesión / Cliente ────────────────────────────────────────────────────
      { nombre: 'cliente_id',           tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'ID interno del cliente' },
      { nombre: 'cliente_nombre',       tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Nombre completo del cliente' },
      { nombre: 'cliente_telefono',     tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Teléfono del cliente' },
      { nombre: 'cliente_cedula',       tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Cédula / documento del cliente' },
      { nombre: 'cliente_saldo',        tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Saldo o estado de cuenta del cliente' },
      { nombre: 'cliente_estatus',      tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Estatus del cliente (activo, suspendido, etc.)' },
      { nombre: 'cliente_plan',         tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Plan o categoría del cliente' },

      // ── Conversaciones ──────────────────────────────────────────────────────
      { nombre: 'conversacion_id',           tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'UUID de la conversación activa' },
      { nombre: 'conversacion_estado',       tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Estado de la conversación (active, completed, abandoned)' },
      { nombre: 'conversacion_canal',        tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Canal de entrada (whatsapp, web, etc.)' },
      { nombre: 'historial_conversaciones',  tipo: 'array',   scope: 'session', valorDefault: [],    descripcion: 'Lista de conversaciones anteriores del usuario' },

      // ── Solicitudes ─────────────────────────────────────────────────────────
      { nombre: 'solicitud_id',             tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'ID de la solicitud creada / consultada' },
      { nombre: 'solicitud_titulo',         tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Título de la solicitud' },
      { nombre: 'solicitud_estado',         tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Estado de la solicitud (pendiente, en_proceso, completada)' },
      { nombre: 'solicitud_prioridad',      tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Prioridad de la solicitud (baja, media, alta)' },
      { nombre: 'solicitudes_activas',      tipo: 'array',   scope: 'session', valorDefault: [],    descripcion: 'Lista de solicitudes activas del usuario en esta sesión' },
      { nombre: 'solicitud_agente_nombre',  tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Nombre del agente asignado a la solicitud' },

      // ── Agenda / Citas ───────────────────────────────────────────────────────
      { nombre: 'agenda_fecha_seleccionada',  tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Fecha seleccionada por el usuario para agendar (YYYY-MM-DD)' },
      { nombre: 'agenda_hora_seleccionada',   tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Hora seleccionada por el usuario para agendar (HH:MM)' },
      { nombre: 'agenda_cita_id',             tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'ID del evento / cita creado o consultado' },
      { nombre: 'agenda_cita_estado',         tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Estado del evento de agenda (pendiente, confirmada, cancelada)' },
      { nombre: 'agenda_motivo',              tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Motivo o tipo de cita seleccionado por el usuario' },
      { nombre: 'agenda_horarios_disponibles',tipo: 'array',   scope: 'session', valorDefault: [],    descripcion: 'Horarios disponibles devueltos por el sistema para la fecha seleccionada' },
      { nombre: 'agenda_citas_usuario',       tipo: 'array',   scope: 'session', valorDefault: [],    descripcion: 'Citas / eventos del usuario obtenidos de la agenda' },
      { nombre: 'agenda_confirmacion',        tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Código o mensaje de confirmación de la cita agendada' },

      // ── Agentes disponibles ─────────────────────────────────────────────────
      { nombre: 'agentes_disponibles',      tipo: 'array',   scope: 'global',  valorDefault: [],    descripcion: 'Lista de agentes/personas disponibles para atención (actualizada en tiempo real)' },
      { nombre: 'agente_asignado_id',       tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'ID del agente asignado a la sesión actual' },
      { nombre: 'agente_asignado_nombre',   tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Nombre del agente asignado a la sesión actual' },
      { nombre: 'agente_asignado_email',    tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Email del agente asignado a la sesión actual' },
      { nombre: 'agente_esta_disponible',   tipo: 'boolean', scope: 'session', valorDefault: false, descripcion: 'Indica si hay un agente humano disponible para tomar la conversación' },

      // ── Horarios de atención ─────────────────────────────────────────────────
      { nombre: 'horario_atencion',          tipo: 'object',  scope: 'global',  valorDefault: {},    descripcion: 'Horario de atención del negocio (lun-vie, sábados, etc.)' },
      { nombre: 'en_horario_atencion',       tipo: 'boolean', scope: 'session', valorDefault: false, descripcion: 'True si la conversación ocurre dentro del horario de atención' },
      { nombre: 'proxima_hora_disponible',   tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Próxima franja horaria de atención disponible' },

      // ── Generales de flujo ───────────────────────────────────────────────────
      { nombre: 'intencion_detectada',  tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Intención principal detectada (pago, soporte, agenda, consulta, etc.)' },
      { nombre: 'opcion_seleccionada',  tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Última opción de menú seleccionada por el usuario' },
      { nombre: 'contador_reintentos',  tipo: 'number',  scope: 'session', valorDefault: 0,     descripcion: 'Número de reintentos del paso actual del flujo' },
      { nombre: 'flujo_completado',     tipo: 'boolean', scope: 'session', valorDefault: false, descripcion: 'True cuando el flujo finalizó satisfactoriamente' },
      { nombre: 'ultimo_error',         tipo: 'string',  scope: 'session', valorDefault: '',    descripcion: 'Último mensaje de error registrado en el flujo' },
    ];

    // Fetch already existing names for this tenant to skip duplicates
    const existing = await prisma.flowVariable.findMany({
      where: { tenantId },
      select: { nombre: true },
    });
    const existingNames = new Set(existing.map(v => v.nombre));

    const toCreate = DEFAULTS.filter(d => !existingNames.has(d.nombre));

    if (toCreate.length === 0) {
      return res.json({ created: 0, skipped: DEFAULTS.length, message: 'All default variables already exist' });
    }

    await prisma.flowVariable.createMany({
      data: toCreate.map(d => ({ ...d, tenantId })),
    });

    res.status(201).json({
      created: toCreate.length,
      skipped: DEFAULTS.length - toCreate.length,
      variables: toCreate.map(d => d.nombre),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
