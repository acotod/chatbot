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
  // solicitudes
  listSolicitudes,
  countSolicitudesByEstado,
  updateSolicitudEstado,
  assignAgenteToSolicitud,
  // metrics
  getMetrics,
};

