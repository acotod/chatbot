const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

let prisma;

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

async function findTenantByApiKey(apiKey) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.tenant.findUnique({ where: { apiKey } });
}

async function findTenantBySlug(slug) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.tenant.findUnique({ where: { slug } });
}

async function createTenant({ nombre, slug, apiKey, plan }) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.tenant.create({ data: { nombre, slug, apiKey, plan: plan || 'free' } });
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

  return client.solicitud.create({
    data: {
      tenantId,
      userId: userId || null,
      nombre: data.nombre || null,
      telefonoContacto: data.telefono_contacto || null,
      horario: data.horario || null,
      estado: 'pendiente',
    },
  });
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
  return client.agente.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
}

async function createAgente({ tenantId, nombre, email }) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.agente.create({ data: { tenantId, nombre, email } });
}

async function setAgenteEstado(id, tenantId, estado) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.agente.updateMany({ where: { id, tenantId }, data: { estado } });
}

// ---------------------------------------------------------------------------
// Solicitud helpers (scoped to tenant)
// ---------------------------------------------------------------------------

async function listSolicitudes(tenantId, { estado, page = 1, limit = 20 } = {}) {
  const client = getPrismaClient();
  if (!client) return [];
  const where = { tenantId, ...(estado ? { estado } : {}) };
  return client.solicitud.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: { agente: true, user: true },
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
  return client.solicitud.updateMany({ where: { id, tenantId }, data: { estado } });
}

async function assignAgenteToSolicitud(id, tenantId, agenteId) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.solicitud.updateMany({ where: { id, tenantId }, data: { agenteId } });
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
async function saveMensaje({ tenantId, userId, waMsgId, direccion, tipo, contenido }) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.mensaje.create({
    data: {
      tenantId,
      userId:    userId ?? null,
      waMsgId:   waMsgId ?? null,
      direccion,
      tipo,
      contenido,
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
    where: { userId, tenantId, estado: { in: ['pendiente', 'urgente'] } },
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
  setAgenteEstado,
  setAgenteLastSeen,
  // solicitudes
  listSolicitudes,
  countSolicitudesByEstado,
  updateSolicitudEstado,
  assignAgenteToSolicitud,
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
  // chatbot context
  getConversationContext,
  setConversationContext,
  clearConversationContext,
};

