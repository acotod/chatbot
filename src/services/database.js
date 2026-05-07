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
  return client.solicitud.updateMany({
    where: { id, tenantId },
    data: {
      estado: normalized,
      completedAt: normalized === SOLICITUD_STATUS.COMPLETED ? new Date() : null,
    },
  });
}

async function assignAgenteToSolicitud(id, tenantId, agenteId) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.solicitud.updateMany({ where: { id, tenantId }, data: { agenteId } });
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
  normalizeSolicitudStatus,
  listSolicitudes,
  countSolicitudesByEstado,
  updateSolicitudEstado,
  assignAgenteToSolicitud,
  getSolicitudById,
  getSolicitudDetalle,
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

