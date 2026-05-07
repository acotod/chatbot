const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const logger = require('../utils/logger');
const crmSync = require('./crmSync');

let prisma;

const SOLICITUD_STATUS = Object.freeze({
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  PENDING_INFO: 'pending_info',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
});

const SOLICITUD_STATUS_VALUES = Object.freeze(Object.values(SOLICITUD_STATUS));
const SOLICITUD_ACTIVE_STATUS_VALUES = Object.freeze([
  SOLICITUD_STATUS.OPEN,
  SOLICITUD_STATUS.IN_PROGRESS,
  SOLICITUD_STATUS.PENDING_INFO,
]);

const SOLICITUD_COMMENT_VISIBILITY = Object.freeze({
  INTERNAL: 'internal',
  CUSTOMER: 'customer',
  BOTH: 'both',
});

const SOLICITUD_COMMENT_VISIBILITY_VALUES = Object.freeze(
  Object.values(SOLICITUD_COMMENT_VISIBILITY)
);

const SOLICITUD_ENTERPRISE_DEFAULT_CONFIG = Object.freeze({
  enterpriseEnabled: true,
  advancedSearchEnabled: true,
  slaEnabled: true,
  warningThresholdMinutes: 60,
  manualEscalationEnabled: true,
  autoEscalationEnabled: false,
  escalationIntervalMinutes: 30,
  assignmentRulesEnabled: true,
  customerPortalEnabled: false,
  webhooksEnabled: false,
});

function normalizeSolicitudStatus(status, fallback = SOLICITUD_STATUS.OPEN) {
  const raw = String(status ?? '').trim().toLowerCase();
  if (!raw) return fallback;

  if (SOLICITUD_STATUS_VALUES.includes(raw)) return raw;

  const aliasMap = {
    pendiente: SOLICITUD_STATUS.OPEN,
    open: SOLICITUD_STATUS.OPEN,
    urgente: SOLICITUD_STATUS.IN_PROGRESS,
    atendida: SOLICITUD_STATUS.COMPLETED,
    cancelada: SOLICITUD_STATUS.REJECTED,
    cancelado: SOLICITUD_STATUS.REJECTED,
    en_progreso: SOLICITUD_STATUS.IN_PROGRESS,
    en_proceso: SOLICITUD_STATUS.IN_PROGRESS,
    pendiente_info: SOLICITUD_STATUS.PENDING_INFO,
    resuelto: SOLICITUD_STATUS.COMPLETED,
    completado: SOLICITUD_STATUS.COMPLETED,
    rechazado: SOLICITUD_STATUS.REJECTED,
  };

  return aliasMap[raw] ?? fallback;
}

function normalizeSolicitudCommentVisibility(value, fallback = SOLICITUD_COMMENT_VISIBILITY.INTERNAL) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (SOLICITUD_COMMENT_VISIBILITY_VALUES.includes(raw)) return raw;
  return fallback;
}

function asHistoryValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (_err) {
      return String(value);
    }
  }
  return String(value);
}

function getPrismaClient() {
  if (!prisma) {
    try {
      prisma = new PrismaClient();
    } catch (err) {
      logger.error('Failed to instantiate PrismaClient', { message: err.message });
      prisma = null;
    }
  }
  return prisma;
}

// ---------------------------------------------------------------------------
// Tenant helpers
// ---------------------------------------------------------------------------

// API keys are stored as SHA-256 hashes. The raw key is only ever returned
// to the caller at creation time and never persisted in plain text.
function _hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

async function findTenantByApiKey(apiKey) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.tenant.findUnique({ where: { apiKey: _hashApiKey(apiKey) } });
}

async function findTenantBySlug(slug) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.tenant.findUnique({ where: { slug } });
}

async function createTenant({ nombre, slug, apiKey, plan }) {
  const client = getPrismaClient();
  if (!client) return null;
  // Store only the hash; raw key is returned to caller from admin route
  return client.tenant.create({ data: { nombre, slug, apiKey: _hashApiKey(apiKey), plan: plan || 'free' } });
}

async function listTenants() {
  const client = getPrismaClient();
  if (!client) return [];
  return client.tenant.findMany({ orderBy: { createdAt: 'asc' } });
}

async function setTenantActive(slug, activo) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.tenant.update({ where: { slug }, data: { activo } });
}

// ---------------------------------------------------------------------------
// User helpers (scoped to tenant)
// ---------------------------------------------------------------------------

async function findOrCreateUser(phone, tenantId) {
  const client = getPrismaClient();
  if (!client) return null;

  let user = await client.user.findFirst({ where: { phone, tenantId } });
  if (!user) {
    user = await client.user.create({ data: { phone, tenantId } });
  }
  return user;
}

// ---------------------------------------------------------------------------
// Event / solicitud helpers (scoped to tenant)
// ---------------------------------------------------------------------------

async function saveEvent(userId, screen, data, tenantId) {
  const client = getPrismaClient();
  if (!client) return null;

  return client.eventoFlujo.create({
    data: { tenantId, userId: userId || null, screen, data },
  });
}

async function saveSolicitud(userId, data, tenantId) {
  const client = getPrismaClient();
  if (!client) return null;

  let agenteId = null;
  if (data.assign_to != null) {
    const assignRaw = String(data.assign_to);
    const match = assignRaw.match(/(\d+)/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed) && parsed > 0) agenteId = parsed;
    }
  }

  const estado = normalizeSolicitudStatus(data.estado, SOLICITUD_STATUS.OPEN);

  const solicitud = await client.solicitud.create({
    data: {
      tenantId,
      userId: userId || null,
      flowId: data.flow_id != null ? Number(data.flow_id) : null,
      conversationId: data.conversation_id || null,
      origin: data.origin || 'manual',
      titulo: data.title || data.titulo || null,
      prioridad: data.priority || data.prioridad || null,
      flowNodeRef: data.flow_node_ref || null,
      agenteId,
      nombre: data.nombre || null,
      telefonoContacto: data.telefono_contacto || null,
      horario: data.horario || null,
      estado,
      variablesJson: data.variables_json || null,
      attachmentsJson: Array.isArray(data.attachments_json) ? data.attachments_json : [],
      internalComments: Array.isArray(data.internal_comments_json) ? data.internal_comments_json : [],
      completedAt: estado === SOLICITUD_STATUS.COMPLETED ? new Date() : null,
    },
  });

  // CRM auto-sync: recalculate lead score + ultimoContacto after new solicitud
  if (userId) {
    crmSync.touch({ userId, prisma: client, canal: data.origin ?? 'chatbot' }).catch(() => {});
  }

  return solicitud;
}

// ---------------------------------------------------------------------------
// Configuracion helpers (dynamic flow engine)
// ---------------------------------------------------------------------------

async function getConfig(tenantId, clave) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.configuracion.findUnique({ where: { tenantId_clave: { tenantId, clave } } });
}

async function setConfig(tenantId, clave, valor) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.configuracion.upsert({
    where: { tenantId_clave: { tenantId, clave } },
    update: { valor },
    create: { tenantId, clave, valor },
  });
}

async function getSolicitudesEnterpriseConfig(tenantId) {
  const cfg = await getConfig(tenantId, 'solicitudes_enterprise_config');
  const raw = (cfg && cfg.valor && typeof cfg.valor === 'object') ? cfg.valor : {};

  return {
    ...SOLICITUD_ENTERPRISE_DEFAULT_CONFIG,
    ...raw,
    warningThresholdMinutes: Number(raw.warningThresholdMinutes ?? SOLICITUD_ENTERPRISE_DEFAULT_CONFIG.warningThresholdMinutes),
    escalationIntervalMinutes: Number(raw.escalationIntervalMinutes ?? SOLICITUD_ENTERPRISE_DEFAULT_CONFIG.escalationIntervalMinutes),
  };
}

async function setSolicitudesEnterpriseConfig(tenantId, partialConfig = {}) {
  const current = await getSolicitudesEnterpriseConfig(tenantId);
  const next = {
    ...current,
    ...(partialConfig && typeof partialConfig === 'object' ? partialConfig : {}),
  };

  next.warningThresholdMinutes = Math.max(5, Math.min(1440, Number(next.warningThresholdMinutes || 60)));
  next.escalationIntervalMinutes = Math.max(5, Math.min(1440, Number(next.escalationIntervalMinutes || 30)));

  await setConfig(tenantId, 'solicitudes_enterprise_config', next);
  return next;
}

// ---------------------------------------------------------------------------
// Agente helpers (scoped to tenant)
// ---------------------------------------------------------------------------

async function listAgentes(tenantId) {
  const client = getPrismaClient();
  if (!client) return [];
  return client.agente.findMany({
    where: { tenantId },
    include: {
      puesto: { select: { id: true, nombre: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function createAgente({ tenantId, nombre, email, whatsapp = null, puestoId = null, calendarLink = null }) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.agente.create({
    data: {
      tenantId,
      nombre,
      email,
      whatsapp,
      puestoId,
      calendarLink,
    },
    include: {
      puesto: { select: { id: true, nombre: true } },
    },
  });
}

async function updateAgente({ id, tenantId, nombre, email, whatsapp = null, puestoId = null, calendarLink = null }) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.agente.updateMany({
    where: { id, tenantId },
    data: {
      nombre,
      email,
      whatsapp,
      puestoId,
      calendarLink,
    },
  });
}

async function listAgentePuestos(tenantId) {
  const client = getPrismaClient();
  if (!client) return [];
  return client.agentePuesto.findMany({
    where: { tenantId, activo: true },
    orderBy: { nombre: 'asc' },
  });
}

async function createAgentePuesto({ tenantId, nombre }) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.agentePuesto.create({
    data: {
      tenantId,
      nombre,
    },
  });
}

async function updateAgentePuesto({ id, tenantId, nombre }) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.agentePuesto.updateMany({
    where: { id, tenantId },
    data: { nombre },
  });
}

async function deleteAgentePuesto({ id, tenantId }) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.agentePuesto.deleteMany({ where: { id, tenantId } });
}

async function setAgenteEstado(id, tenantId, estado) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.agente.updateMany({ where: { id, tenantId }, data: { estado } });
}

// ---------------------------------------------------------------------------
// Solicitud helpers (scoped to tenant)
// ---------------------------------------------------------------------------

async function listSolicitudes(tenantId, { estado, userId, page = 1, limit = 20 } = {}) {
  const client = getPrismaClient();
  if (!client) return [];
  const normalizedEstado = estado ? normalizeSolicitudStatus(estado, '') : '';
  const where = {
    tenantId,
    ...(normalizedEstado ? { estado: normalizedEstado } : {}),
    ...(userId !== undefined ? { userId: Number(userId) } : {}),
  };
  return client.solicitud.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      agente: true,
      user: true,
      slaPolicy: true,
      flow: { select: { id: true, nombre: true } },
      conversation: { select: { id: true, status: true, startedAt: true, endedAt: true } },
    },
  });
}

async function countSolicitudesByEstado(tenantId) {
  const client = getPrismaClient();
  if (!client) return {};
  const groups = await client.solicitud.groupBy({
    by: ['estado'],
    where: { tenantId },
    _count: { id: true },
  });
  const result = {};
  for (const g of groups) result[g.estado ?? 'sin_estado'] = g._count.id;
  return result;
}

async function updateSolicitudEstado(id, tenantId, estado) {
  const client = getPrismaClient();
  if (!client) return null;
  const normalized = normalizeSolicitudStatus(estado, SOLICITUD_STATUS.OPEN);
  const current = await client.solicitud.findFirst({ where: { id, tenantId } });
  const result = await client.solicitud.updateMany({
    where: { id, tenantId },
    data: {
      estado: normalized,
      completedAt: normalized === SOLICITUD_STATUS.COMPLETED ? new Date() : null,
    },
  });

  if (result.count > 0 && current && current.estado !== normalized) {
    await client.solicitudHistory.create({
      data: {
        solicitudId: id,
        field: 'estado',
        oldValue: asHistoryValue(current.estado),
        newValue: asHistoryValue(normalized),
      },
    }).catch(() => {});
  }

  return result;
}

async function assignAgenteToSolicitud(id, tenantId, agenteId) {
  const client = getPrismaClient();
  if (!client) return null;
  const current = await client.solicitud.findFirst({ where: { id, tenantId } });
  const result = await client.solicitud.updateMany({ where: { id, tenantId }, data: { agenteId } });

  if (result.count > 0 && current && Number(current.agenteId ?? 0) !== Number(agenteId ?? 0)) {
    await client.solicitudHistory.create({
      data: {
        solicitudId: id,
        field: 'agenteId',
        oldValue: asHistoryValue(current.agenteId),
        newValue: asHistoryValue(agenteId),
      },
    }).catch(() => {});
  }

  return result;
}

async function getSolicitudById(id, tenantId) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.solicitud.findFirst({
    where: { id, tenantId },
    include: {
      agente: true,
      user: true,
      flow: { select: { id: true, nombre: true } },
      conversation: { select: { id: true, status: true, startedAt: true, endedAt: true } },
    },
  });
}

async function getSolicitudDetalle(id, tenantId) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.solicitud.findFirst({
    where: { id, tenantId },
    include: {
      agente: true,
      user: true,
      slaPolicy: true,
      comments: {
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, email: true, nombre: true } } },
      },
      history: {
        orderBy: { timestamp: 'desc' },
        include: { user: { select: { id: true, email: true, nombre: true } } },
      },
      flow: { select: { id: true, nombre: true } },
      conversation: {
        include: {
          flow: { select: { id: true, nombre: true } },
          events: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, nodeRef: true, eventType: true, payload: true, createdAt: true },
          },
        },
      },
    },
  });
}

async function addSolicitudComment({ solicitudId, tenantId, userId, content, visibility, attachments }) {
  const client = getPrismaClient();
  if (!client) return null;

  const solicitud = await client.solicitud.findFirst({
    where: { id: solicitudId, tenantId },
    select: { id: true },
  });
  if (!solicitud) return null;

  const normalizedVisibility = normalizeSolicitudCommentVisibility(visibility);
  const safeAttachments = Array.isArray(attachments) ? attachments : [];

  const comment = await client.solicitudComment.create({
    data: {
      solicitudId,
      userId: userId ?? null,
      content,
      visibility: normalizedVisibility,
      attachments: safeAttachments,
    },
    include: { user: { select: { id: true, email: true, nombre: true } } },
  });

  await client.solicitudHistory.create({
    data: {
      solicitudId,
      userId: userId ?? null,
      field: 'comment',
      oldValue: null,
      newValue: asHistoryValue({ visibility: normalizedVisibility, commentId: comment.id }),
    },
  }).catch(() => {});

  return comment;
}

async function getSolicitudComments(solicitudId, tenantId) {
  const client = getPrismaClient();
  if (!client) return [];

  const solicitud = await client.solicitud.findFirst({
    where: { id: solicitudId, tenantId },
    select: { id: true },
  });
  if (!solicitud) return [];

  return client.solicitudComment.findMany({
    where: { solicitudId },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, email: true, nombre: true } } },
  });
}

async function getSolicitudHistory(solicitudId, tenantId) {
  const client = getPrismaClient();
  if (!client) return [];

  const solicitud = await client.solicitud.findFirst({
    where: { id: solicitudId, tenantId },
    select: { id: true },
  });
  if (!solicitud) return [];

  return client.solicitudHistory.findMany({
    where: { solicitudId },
    orderBy: { timestamp: 'desc' },
    include: { user: { select: { id: true, email: true, nombre: true } } },
  });
}

async function updateSolicitudFields(id, tenantId, updates = {}, actorUserId = null) {
  const client = getPrismaClient();
  if (!client) return null;

  const current = await client.solicitud.findFirst({ where: { id, tenantId } });
  if (!current) return null;

  const data = {};
  if (updates.estado !== undefined) {
    data.estado = normalizeSolicitudStatus(updates.estado, current.estado ?? SOLICITUD_STATUS.OPEN);
    data.completedAt = data.estado === SOLICITUD_STATUS.COMPLETED ? new Date() : null;
  }
  if (updates.prioridad !== undefined) data.prioridad = updates.prioridad || null;
  if (updates.agenteId !== undefined) data.agenteId = updates.agenteId ? Number(updates.agenteId) : null;
  if (updates.tags !== undefined) data.tags = Array.isArray(updates.tags) ? updates.tags : [];
  if (updates.followUpDate !== undefined) data.followUpDate = updates.followUpDate ? new Date(updates.followUpDate) : null;
  if (updates.resolutionNotes !== undefined) data.resolutionNotes = updates.resolutionNotes || null;
  if (updates.customerNotes !== undefined) data.customerNotes = updates.customerNotes || null;

  const updated = await client.solicitud.update({ where: { id }, data });

  const fieldMap = [
    'estado',
    'prioridad',
    'agenteId',
    'tags',
    'followUpDate',
    'resolutionNotes',
    'customerNotes',
  ];

  for (const field of fieldMap) {
    if (data[field] === undefined) continue;
    if (asHistoryValue(current[field]) === asHistoryValue(updated[field])) continue;
    await client.solicitudHistory.create({
      data: {
        solicitudId: id,
        userId: actorUserId,
        field,
        oldValue: asHistoryValue(current[field]),
        newValue: asHistoryValue(updated[field]),
      },
    }).catch(() => {});
  }

  return updated;
}

async function bulkUpdateSolicitudes({ tenantId, ids = [], updates = {}, actorUserId = null }) {
  const client = getPrismaClient();
  if (!client) return { matched: 0, updated: 0 };

  const normalizedIds = Array.from(new Set((Array.isArray(ids) ? ids : [])
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0)));
  if (!normalizedIds.length) return { matched: 0, updated: 0 };

  const matched = await client.solicitud.findMany({
    where: { tenantId, id: { in: normalizedIds } },
    select: { id: true },
  });

  let updated = 0;
  for (const row of matched) {
    const result = await updateSolicitudFields(row.id, tenantId, updates, actorUserId);
    if (result) updated += 1;
  }

  return { matched: matched.length, updated };
}

function calculateSlaStatus(solicitud, options = {}) {
  const now = options instanceof Date ? options : (options?.now instanceof Date ? options.now : new Date());
  const warningThresholdMinutes = Number(
    options?.warningThresholdMinutes ?? SOLICITUD_ENTERPRISE_DEFAULT_CONFIG.warningThresholdMinutes
  );

  if (!solicitud) {
    return {
      status: 'no_sla',
      isBreached: false,
      minutesRemaining: null,
      nextEscalationAt: null,
    };
  }

  const resolutionMinutes = Number(solicitud?.slaPolicy?.resolutionTimeMinutes ?? 0);
  if (!Number.isFinite(resolutionMinutes) || resolutionMinutes <= 0) {
    return {
      status: 'no_sla',
      isBreached: false,
      minutesRemaining: null,
      nextEscalationAt: null,
    };
  }

  const baseStart = solicitud.slaCreatedAt || solicitud.createdAt;
  const dueAt = new Date(new Date(baseStart).getTime() + (resolutionMinutes * 60 * 1000));
  const remainingMs = dueAt.getTime() - new Date(now).getTime();
  const minutesRemaining = Math.ceil(remainingMs / 60000);
  const isBreached = remainingMs < 0;
  let status = 'on_track';
  if (isBreached) status = 'breached';
  else if (minutesRemaining <= warningThresholdMinutes) status = 'warning';

  return {
    status,
    isBreached,
    minutesRemaining,
    dueAt,
    nextEscalationAt: isBreached ? new Date(now) : dueAt,
  };
}

async function searchSolicitudes(tenantId, {
  q,
  estado,
  agenteId,
  prioridad,
  channelSource,
  tags,
  from,
  to,
  page = 1,
  limit = 20,
  slaStatus,
  warningThresholdMinutes,
} = {}) {
  const client = getPrismaClient();
  if (!client) return { data: [], total: 0, page, limit };

  const normalizedEstado = estado ? normalizeSolicitudStatus(estado, '') : '';
  const normalizedQ = String(q ?? '').trim();
  const normalizedTags = Array.isArray(tags)
    ? tags.filter((t) => String(t || '').trim())
    : String(tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);

  const where = {
    tenantId,
    ...(normalizedEstado ? { estado: normalizedEstado } : {}),
    ...(agenteId != null ? { agenteId: Number(agenteId) } : {}),
    ...(prioridad ? { prioridad: String(prioridad) } : {}),
    ...(channelSource ? { channelSource: String(channelSource) } : {}),
    ...(from || to ? {
      createdAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      },
    } : {}),
    ...(normalizedQ ? {
      OR: [
        { nombre: { contains: normalizedQ, mode: 'insensitive' } },
        { telefonoContacto: { contains: normalizedQ, mode: 'insensitive' } },
        { titulo: { contains: normalizedQ, mode: 'insensitive' } },
      ],
    } : {}),
  };

  const rows = await client.solicitud.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      agente: true,
      user: true,
      slaPolicy: true,
      flow: { select: { id: true, nombre: true } },
      conversation: { select: { id: true, status: true, startedAt: true, endedAt: true } },
    },
  });

  const filtered = rows.filter((row) => {
    if (normalizedTags.length) {
      const rowTags = Array.isArray(row.tags) ? row.tags.map((v) => String(v)) : [];
      const hasAnyTag = normalizedTags.some((tag) => rowTags.includes(tag));
      if (!hasAnyTag) return false;
    }

    if (slaStatus) {
      const s = calculateSlaStatus(row, { warningThresholdMinutes }).status;
      if (String(slaStatus) !== s) return false;
    }

    return true;
  });

  const start = (Number(page) - 1) * Number(limit);
  const data = filtered.slice(start, start + Number(limit));

  return {
    data,
    total: filtered.length,
    page: Number(page),
    limit: Number(limit),
  };
}

async function getSolicitudesStats(tenantId, options = {}) {
  const client = getPrismaClient();
  if (!client) return {};

  const [total, byEstado, allActive] = await Promise.all([
    client.solicitud.count({ where: { tenantId } }),
    client.solicitud.groupBy({
      by: ['estado'],
      where: { tenantId },
      _count: { id: true },
    }),
    client.solicitud.findMany({
      where: {
        tenantId,
        estado: { in: SOLICITUD_ACTIVE_STATUS_VALUES },
      },
      include: { slaPolicy: true },
    }),
  ]);

  let slaOnTrack = 0;
  let slaWarning = 0;
  let slaBreached = 0;
  for (const row of allActive) {
    const status = calculateSlaStatus(row, options).status;
    if (status === 'breached') slaBreached += 1;
    else if (status === 'warning') slaWarning += 1;
    else if (status === 'on_track') slaOnTrack += 1;
  }

  const estado = {};
  for (const item of byEstado) estado[item.estado ?? 'sin_estado'] = item._count.id;

  return {
    total,
    estado,
    sla: {
      onTrack: slaOnTrack,
      warning: slaWarning,
      breached: slaBreached,
    },
  };
}

async function escalateSolicitud({ id, tenantId, actorUserId = null, reason = null }) {
  const client = getPrismaClient();
  if (!client) return null;

  const current = await client.solicitud.findFirst({ where: { id, tenantId } });
  if (!current) return null;

  const escalationLevel = Number(current.escalationLevel ?? 0) + 1;
  const updated = await client.solicitud.update({
    where: { id },
    data: {
      escalatedAt: new Date(),
      escalationLevel,
      estado: current.estado === SOLICITUD_STATUS.OPEN ? SOLICITUD_STATUS.IN_PROGRESS : current.estado,
    },
  });

  await client.solicitudHistory.create({
    data: {
      solicitudId: id,
      userId: actorUserId,
      field: 'escalation',
      oldValue: asHistoryValue({ level: current.escalationLevel ?? 0 }),
      newValue: asHistoryValue({ level: escalationLevel, reason }),
    },
  }).catch(() => {});

  return updated;
}

async function listSlaPolicies(tenantId) {
  const client = getPrismaClient();
  if (!client) return [];
  return client.slaPolicy.findMany({
    where: { tenantId },
    orderBy: [{ active: 'desc' }, { nombre: 'asc' }],
  });
}

async function createSlaPolicy(tenantId, payload = {}) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.slaPolicy.create({
    data: {
      tenantId,
      nombre: String(payload.nombre || '').trim(),
      descripcion: payload.descripcion ? String(payload.descripcion) : null,
      responseTimeMinutes: Number(payload.responseTimeMinutes ?? 60),
      resolutionTimeMinutes: Number(payload.resolutionTimeMinutes ?? 1440),
      escalationRules: Array.isArray(payload.escalationRules) ? payload.escalationRules : [],
      active: payload.active !== false,
    },
  });
}

async function updateSlaPolicy(tenantId, id, payload = {}) {
  const client = getPrismaClient();
  if (!client) return null;

  const current = await client.slaPolicy.findFirst({ where: { id, tenantId } });
  if (!current) return null;

  return client.slaPolicy.update({
    where: { id },
    data: {
      ...(payload.nombre !== undefined ? { nombre: String(payload.nombre || '').trim() } : {}),
      ...(payload.descripcion !== undefined ? { descripcion: payload.descripcion ? String(payload.descripcion) : null } : {}),
      ...(payload.responseTimeMinutes !== undefined ? { responseTimeMinutes: Number(payload.responseTimeMinutes) } : {}),
      ...(payload.resolutionTimeMinutes !== undefined ? { resolutionTimeMinutes: Number(payload.resolutionTimeMinutes) } : {}),
      ...(payload.escalationRules !== undefined ? { escalationRules: Array.isArray(payload.escalationRules) ? payload.escalationRules : [] } : {}),
      ...(payload.active !== undefined ? { active: Boolean(payload.active) } : {}),
    },
  });
}

async function listSolicitudAssignmentRules(tenantId) {
  const client = getPrismaClient();
  if (!client) return [];
  return client.solicitudAssignmentRule.findMany({
    where: { tenantId },
    include: { targetAgente: { select: { id: true, nombre: true, email: true } } },
    orderBy: [{ enabled: 'desc' }, { id: 'asc' }],
  });
}

async function createSolicitudAssignmentRule(tenantId, payload = {}) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.solicitudAssignmentRule.create({
    data: {
      tenantId,
      criterios: payload.criterios && typeof payload.criterios === 'object' ? payload.criterios : {},
      targetAgenteId: payload.targetAgenteId ? Number(payload.targetAgenteId) : null,
      roundRobin: Boolean(payload.roundRobin),
      enabled: payload.enabled !== false,
    },
    include: { targetAgente: { select: { id: true, nombre: true, email: true } } },
  });
}

async function updateSolicitudAssignmentRule(tenantId, id, payload = {}) {
  const client = getPrismaClient();
  if (!client) return null;
  const current = await client.solicitudAssignmentRule.findFirst({ where: { id, tenantId } });
  if (!current) return null;

  return client.solicitudAssignmentRule.update({
    where: { id },
    data: {
      ...(payload.criterios !== undefined ? { criterios: payload.criterios && typeof payload.criterios === 'object' ? payload.criterios : {} } : {}),
      ...(payload.targetAgenteId !== undefined ? { targetAgenteId: payload.targetAgenteId ? Number(payload.targetAgenteId) : null } : {}),
      ...(payload.roundRobin !== undefined ? { roundRobin: Boolean(payload.roundRobin) } : {}),
      ...(payload.enabled !== undefined ? { enabled: Boolean(payload.enabled) } : {}),
    },
    include: { targetAgente: { select: { id: true, nombre: true, email: true } } },
  });
}

async function listSolicitudesByConversationId(tenantId, conversationId) {
  const client = getPrismaClient();
  if (!client || !conversationId) return [];
  return client.solicitud.findMany({
    where: { tenantId, conversationId },
    orderBy: { createdAt: 'desc' },
    include: { agente: true },
  });
}

async function createOrReuseFlowTask({
  tenantId,
  userId,
  flowId,
  conversationId,
  flowNodeRef,
  sessionKey,
  title,
  assignTo,
  priority,
  variables,
  requestedStatus,
}) {
  const client = getPrismaClient();
  if (!client) return null;

  const whereOpen = {
    tenantId,
    flowNodeRef: flowNodeRef ?? null,
    estado: { in: SOLICITUD_ACTIVE_STATUS_VALUES },
  };
  if (conversationId) whereOpen.conversationId = conversationId;
  if (userId != null) whereOpen.userId = userId;

  const existing = await client.solicitud.findFirst({
    where: whereOpen,
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return { solicitud: existing, created: false };

  let agenteId = null;
  if (assignTo != null) {
    const match = String(assignTo).match(/(\d+)/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed) && parsed > 0) agenteId = parsed;
    }
  }

  const estado = normalizeSolicitudStatus(requestedStatus, SOLICITUD_STATUS.OPEN);
  const created = await client.solicitud.create({
    data: {
      tenantId,
      userId: userId ?? null,
      flowId: flowId ?? null,
      conversationId: conversationId ?? null,
      flowNodeRef: flowNodeRef ?? null,
      origin: 'bot',
      titulo: title || 'Tarea del flujo',
      prioridad: priority || 'normal',
      estado,
      agenteId,
      telefonoContacto: sessionKey || null,
      variablesJson: variables || {},
      attachmentsJson: [],
      internalComments: [],
    },
  });

  return { solicitud: created, created: true };
}

async function findTaskForWait({ tenantId, conversationId, userId, flowNodeRef, taskId }) {
  const client = getPrismaClient();
  if (!client) return null;

  if (taskId != null) {
    return client.solicitud.findFirst({
      where: { id: Number(taskId), tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  const where = { tenantId };
  if (conversationId) where.conversationId = conversationId;
  if (userId != null) where.userId = userId;
  if (flowNodeRef) where.flowNodeRef = flowNodeRef;

  return client.solicitud.findFirst({
    where,
    orderBy: { createdAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------

async function getMetrics(tenantId) {
  const client = getPrismaClient();
  if (!client) return {};
  const [solicitudesPorEstado, totalUsers, totalEventos, urgencias] = await Promise.all([
    countSolicitudesByEstado(tenantId),
    client.user.count({ where: { tenantId } }),
    client.eventoFlujo.count({ where: { tenantId } }),
    client.eventoFlujo.count({ where: { tenantId, screen: 'URGENCIA' } }),
  ]);
  return { solicitudesPorEstado, totalUsers, totalEventos, urgencias };
}

// ---------------------------------------------------------------------------
// WhatsApp Business helpers
// ---------------------------------------------------------------------------

/**
 * Find a tenant whose wa_credentials config contains the given phoneNumberId.
 * This performs a JSON contains query.
 */
async function findTenantByWaPhoneNumberId(phoneNumberId) {
  const client = getPrismaClient();
  if (!client) return null;
  const config = await client.configuracion.findFirst({
    where: {
      clave: 'wa_credentials',
      valor: { path: ['phoneNumberId'], equals: phoneNumberId },
    },
    include: { tenant: true },
  });
  return config?.tenant ?? null;
}

/**
 * Persist a WhatsApp message (inbound or outbound).
 */
async function saveMensaje({ tenantId, userId, waMsgId, direccion, tipo, contenido, conversationId }) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.mensaje.create({
    data: {
      tenantId,
      userId:         userId ?? null,
      waMsgId:        waMsgId ?? null,
      direccion,
      tipo,
      contenido,
      conversationId: conversationId ?? null,
    },
  });
}

/**
 * List messages for a tenant/user conversation (latest-first).
 */
async function listMensajes(tenantId, userId, { page = 1, limit = 50 } = {}) {
  const client = getPrismaClient();
  if (!client) return [];
  return client.mensaje.findMany({
    where:    { tenantId, userId: userId ? Number(userId) : undefined },
    orderBy:  { createdAt: 'desc' },
    skip:     (page - 1) * limit,
    take:     limit,
    include:  { user: true },
  });
}

/**
 * List the most recent conversation thread (one row per unique user/phone).
 */
async function listConversaciones(tenantId, { limit = 30 } = {}) {
  const client = getPrismaClient();
  if (!client) return [];
  // Use raw groupBy to get the latest message per user
  return client.mensaje.findMany({
    where:    { tenantId },
    distinct: ['userId'],
    orderBy:  { createdAt: 'desc' },
    take:     limit,
    include:  { user: true },
  });
}

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

/**
 * Find a persisted WhatsApp message by its Meta message ID.
 * Used to skip duplicate incoming webhook events.
 */
async function findMensajeByWaMsgId(waMsgId) {
  const client = getPrismaClient();
  if (!client || !waMsgId) return null;
  return client.mensaje.findUnique({ where: { waMsgId } });
}

// ---------------------------------------------------------------------------
// Conversation context helpers (chatbot state per user/tenant)
// ---------------------------------------------------------------------------

async function getConversationContext(tenantId, userId) {
  const client = getPrismaClient();
  if (!client) return null;
  try {
    return await client.conversationContext.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
  } catch (err) {
    logger.warn('getConversationContext failed', { message: err.message });
    return null;
  }
}

async function setConversationContext(tenantId, userId, { currentNodeId }) {
  const client = getPrismaClient();
  if (!client) return null;
  try {
    return await client.conversationContext.upsert({
      where:  { tenantId_userId: { tenantId, userId } },
      update: { currentNodeId: currentNodeId ?? null, updatedAt: new Date() },
      create: { tenantId, userId, currentNodeId: currentNodeId ?? null },
    });
  } catch (err) {
    logger.warn('setConversationContext failed', { message: err.message });
    return null;
  }
}

async function clearConversationContext(tenantId, userId) {
  const client = getPrismaClient();
  if (!client) return;
  try {
    await client.conversationContext.deleteMany({ where: { tenantId, userId } });
  } catch (err) {
    logger.warn('clearConversationContext failed', { message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Agent presence helpers
// ---------------------------------------------------------------------------

async function setAgenteLastSeen(id, tenantId) {
  const client = getPrismaClient();
  if (!client) return null;
  try {
    await client.agente.updateMany({
      where: { id, tenantId },
      data:  { lastSeenAt: new Date() },
    });
  } catch (err) {
    logger.warn('setAgenteLastSeen failed', { message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Solicitud helpers — find open request for a user
// ---------------------------------------------------------------------------

async function findOpenSolicitudForUser(userId, tenantId) {
  const client = getPrismaClient();
  if (!client || !userId) return null;
  return client.solicitud.findFirst({
    where: { userId, tenantId, estado: { in: SOLICITUD_ACTIVE_STATUS_VALUES } },
    orderBy: { createdAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Meta Flows — tenant resolution by flow_token
// ---------------------------------------------------------------------------

async function findTenantByFlowToken(flowToken) {
  const client = getPrismaClient();
  if (!client) return null;
  const config = await client.configuracion.findFirst({
    where: {
      clave: 'flow_token',
      valor: { path: ['token'], equals: flowToken },
    },
    include: { tenant: true },
  });
  return config?.tenant ?? null;
}

// ---------------------------------------------------------------------------
// Unified Event Gateway helpers
// ---------------------------------------------------------------------------

async function findEventLogByIdempotencyKey(tenantId, idempotencyKey) {
  const client = getPrismaClient();
  if (!client || !tenantId || !idempotencyKey) return null;
  return client.eventLog.findUnique({
    where: {
      tenantId_idempotencyKey: { tenantId, idempotencyKey },
    },
  });
}

async function saveEventLog({
  tenantId,
  eventId,
  eventVersion = '1.0',
  channel,
  source,
  eventType,
  direction = 'inbound',
  idempotencyKey,
  occurredAt,
  payload,
  metadata,
  rawEvent,
  status = 'ingested',
}) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.eventLog.create({
    data: {
      tenantId,
      eventId,
      eventVersion,
      channel,
      source,
      eventType,
      direction,
      idempotencyKey,
      occurredAt,
      payload,
      metadata: metadata ?? undefined,
      rawEvent: rawEvent ?? undefined,
      status,
    },
  });
}

async function markEventLogStatus(id, status, { lastError, processedAt, incrementAttempts } = {}) {
  const client = getPrismaClient();
  if (!client || !id || !status) return null;

  const data = {
    status,
    ...(lastError !== undefined ? { lastError } : {}),
    ...(processedAt !== undefined ? { processedAt } : {}),
    ...(incrementAttempts ? { attempts: { increment: 1 } } : {}),
  };

  return client.eventLog.update({ where: { id }, data });
}

async function saveDeadLetter({
  tenantId,
  eventLogId,
  reason,
  error,
  payload,
  status = 'pending',
}) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.deadLetterQueue.create({
    data: {
      tenantId,
      eventLogId: eventLogId ?? null,
      reason,
      error: error ?? undefined,
      payload: payload ?? undefined,
      status,
    },
  });
}

async function getEventSchema(name, version = '1.0') {
  const client = getPrismaClient();
  if (!client || !name) return null;
  return client.eventSchema.findUnique({ where: { name_version: { name, version } } });
}

async function upsertEventSchema({ name, version = '1.0', schema, activo = true }) {
  const client = getPrismaClient();
  if (!client || !name || !schema) return null;
  return client.eventSchema.upsert({
    where: { name_version: { name, version } },
    create: { name, version, schema, activo },
    update: { schema, activo },
  });
}

module.exports = {
  getPrismaClient,
  // tenant
  findTenantByApiKey,
  findTenantBySlug,
  createTenant,
  listTenants,
  setTenantActive,
  // user
  findOrCreateUser,
  // events
  saveEvent,
  saveSolicitud,
  // config
  getConfig,
  setConfig,
  getSolicitudesEnterpriseConfig,
  setSolicitudesEnterpriseConfig,
  // agentes
  listAgentes,
  createAgente,
  updateAgente,
  listAgentePuestos,
  createAgentePuesto,
  updateAgentePuesto,
  deleteAgentePuesto,
  setAgenteEstado,
  setAgenteLastSeen,
  // solicitudes
  SOLICITUD_STATUS,
  SOLICITUD_STATUS_VALUES,
  SOLICITUD_COMMENT_VISIBILITY,
  SOLICITUD_COMMENT_VISIBILITY_VALUES,
  normalizeSolicitudStatus,
  normalizeSolicitudCommentVisibility,
  listSolicitudes,
  searchSolicitudes,
  getSolicitudesStats,
  SOLICITUD_ENTERPRISE_DEFAULT_CONFIG,
  countSolicitudesByEstado,
  updateSolicitudEstado,
  escalateSolicitud,
  assignAgenteToSolicitud,
  getSolicitudById,
  getSolicitudDetalle,
  addSolicitudComment,
  getSolicitudComments,
  getSolicitudHistory,
  updateSolicitudFields,
  bulkUpdateSolicitudes,
  calculateSlaStatus,
  listSlaPolicies,
  createSlaPolicy,
  updateSlaPolicy,
  listSolicitudAssignmentRules,
  createSolicitudAssignmentRule,
  updateSolicitudAssignmentRule,
  listSolicitudesByConversationId,
  createOrReuseFlowTask,
  findTaskForWait,
  findOpenSolicitudForUser,
  // metrics
  getMetrics,
  // whatsapp
  findTenantByWaPhoneNumberId,
  findTenantByFlowToken,
  findMensajeByWaMsgId,
  saveMensaje,
  listMensajes,
  listConversaciones,
  // ueg
  findEventLogByIdempotencyKey,
  saveEventLog,
  markEventLogStatus,
  saveDeadLetter,
  getEventSchema,
  upsertEventSchema,
  // chatbot context
  getConversationContext,
  setConversationContext,
  clearConversationContext,
};

