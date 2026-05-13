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

const CONFIG_SECRET_SENTINEL = '__configured__';
const WA_TOKEN_SENTINEL = CONFIG_SECRET_SENTINEL;
const WA_TOKEN_ENC_PREFIX = 'enc$1';
let warnedMissingConfigEncryptionKey = false;

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

function normalizeOptionalText(value, maxLen = null) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (Number.isInteger(maxLen) && maxLen > 0) {
    return text.slice(0, maxLen);
  }
  return text;
}

function normalizeOptionalDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function extractMensajeSearchText(contenido) {
  if (contenido == null) return '';
  if (typeof contenido === 'string') return contenido;
  if (typeof contenido === 'number' || typeof contenido === 'boolean') return String(contenido);
  if (typeof contenido === 'object') {
    const candidateKeys = ['text', 'body', 'message', 'caption'];
    for (const key of candidateKeys) {
      const value = contenido[key];
      if (typeof value === 'string' && value.trim()) return value;
    }

    try {
      return JSON.stringify(contenido);
    } catch (_err) {
      return '';
    }
  }

  return '';
}

function normalizeMensajeDateFilter(value, bound = 'start') {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  // Accept YYYY-MM-DD by expanding to day boundaries.
  const expanded = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}${bound === 'end' ? 'T23:59:59.999' : 'T00:00:00.000'}`
    : raw;

  const parsed = new Date(expanded);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeMensajeStatus(value, fallback = 'pending') {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;

  const allowed = new Set(['pending', 'sent', 'delivered', 'read', 'failed']);
  if (allowed.has(raw)) return raw;

  const aliasMap = {
    accepted: 'sent',
    success: 'sent',
    submitted: 'sent',
    queued: 'pending',
    warning: 'failed',
    error: 'failed',
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

function _getConfigEncryptionKey() {
  const configuredKey = process.env.CONFIG_ENCRYPTION_KEY || process.env.WA_TOKEN_ENCRYPTION_KEY;
  const fallbackKey = process.env.JWT_SECRET;
  const secret = configuredKey || fallbackKey || 'dev-secret';

  if (!configuredKey && !fallbackKey && !warnedMissingConfigEncryptionKey) {
    warnedMissingConfigEncryptionKey = true;
    logger.warn('CONFIG_ENCRYPTION_KEY is not set; using dev fallback for config secret encryption');
  }

  return crypto.createHash('sha256').update(String(secret)).digest();
}

function _encryptSecret(plainText) {
  const text = String(plainText ?? '').trim();
  if (!text) return '';

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _getConfigEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${WA_TOKEN_ENC_PREFIX}:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function _decryptSecret(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!raw.startsWith(`${WA_TOKEN_ENC_PREFIX}:`)) return raw;

  const parts = raw.split(':');
  if (parts.length !== 4) {
    logger.warn('Invalid encrypted config secret format');
    return '';
  }

  try {
    const [, ivB64, authTagB64, encryptedB64] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      _getConfigEncryptionKey(),
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedB64, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8').trim();
  } catch (err) {
    logger.error('Failed to decrypt config secret', { message: err.message });
    return '';
  }
}

async function _normalizeWaCredentialsForStorage(tenantId, valor) {
  const incoming = (valor && typeof valor === 'object') ? { ...valor } : {};
  const existing = await getConfig(tenantId, 'wa_credentials');
  const existingToken = String(existing?.valor?.accessToken ?? '').trim();
  const incomingToken = typeof incoming.accessToken === 'string' ? incoming.accessToken.trim() : '';

  incoming.phoneNumberId = String(incoming.phoneNumberId ?? '').trim();

  if (incomingToken && incomingToken !== WA_TOKEN_SENTINEL) {
    incoming.accessToken = _encryptSecret(incomingToken);
  } else if ((incomingToken === WA_TOKEN_SENTINEL || incomingToken === '') && existingToken) {
    incoming.accessToken = existingToken;
  } else if (!incomingToken) {
    delete incoming.accessToken;
  }

  return incoming;
}

async function _normalizeEmailSettingsForStorage(tenantId, valor) {
  const incoming = (valor && typeof valor === 'object') ? { ...valor } : {};
  const existing = await getConfig(tenantId, 'email_settings');
  const existingPassword = String(existing?.valor?.smtpPass ?? '').trim();
  const incomingPassword = typeof incoming.smtpPass === 'string' ? incoming.smtpPass.trim() : '';

  incoming.smtpUrl = String(incoming.smtpUrl ?? '').trim();
  incoming.smtpHost = String(incoming.smtpHost ?? '').trim();
  incoming.smtpPort = String(incoming.smtpPort ?? '').trim();
  incoming.smtpUser = String(incoming.smtpUser ?? '').trim();
  incoming.emailFrom = String(incoming.emailFrom ?? '').trim();
  incoming.adminBaseUrl = String(incoming.adminBaseUrl ?? '').trim();

  if (incoming.smtpSecure === undefined || incoming.smtpSecure === null || incoming.smtpSecure === '') {
    delete incoming.smtpSecure;
  } else {
    const rawSmtpSecure = String(incoming.smtpSecure).trim().toLowerCase();
    if (rawSmtpSecure === 'true' || rawSmtpSecure === '1' || rawSmtpSecure === 'yes' || rawSmtpSecure === 'on') {
      incoming.smtpSecure = true;
    } else if (rawSmtpSecure === 'false' || rawSmtpSecure === '0' || rawSmtpSecure === 'no' || rawSmtpSecure === 'off') {
      incoming.smtpSecure = false;
    } else {
      incoming.smtpSecure = Boolean(incoming.smtpSecure);
    }
  }

  if (incomingPassword && incomingPassword !== CONFIG_SECRET_SENTINEL) {
    incoming.smtpPass = _encryptSecret(incomingPassword);
  } else if ((incomingPassword === CONFIG_SECRET_SENTINEL || incomingPassword === '') && existingPassword) {
    incoming.smtpPass = existingPassword;
  } else if (!incomingPassword) {
    delete incoming.smtpPass;
  }

  return incoming;
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
  const dueAt = normalizeOptionalDate(data.due_at ?? data.dueAt);
  const categoria = normalizeOptionalText(data.categoria ?? data.category, 80);
  const subcategoria = normalizeOptionalText(data.subcategoria ?? data.subcategory, 120);

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
      categoria,
      subcategoria,
      variablesJson: data.variables_json || null,
      attachmentsJson: Array.isArray(data.attachments_json) ? data.attachments_json : [],
      internalComments: Array.isArray(data.internal_comments_json) ? data.internal_comments_json : [],
      dueAt,
      firstResponseAt: estado !== SOLICITUD_STATUS.OPEN ? new Date() : null,
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

  let persistedValor = valor;
  if (clave === 'wa_credentials') {
    persistedValor = await _normalizeWaCredentialsForStorage(tenantId, valor);
  } else if (clave === 'email_settings') {
    persistedValor = await _normalizeEmailSettingsForStorage(tenantId, valor);
  }

  return client.configuracion.upsert({
    where: { tenantId_clave: { tenantId, clave } },
    update: { valor: persistedValor },
    create: { tenantId, clave, valor: persistedValor },
  });
}

async function getWaCredentials(tenantId) {
  const config = await getConfig(tenantId, 'wa_credentials');
  const phoneNumberId = String(config?.valor?.phoneNumberId ?? '').trim();
  const accessToken = _decryptSecret(config?.valor?.accessToken);

  return {
    phoneNumberId,
    accessToken,
  };
}

async function getEmailSettings(tenantId) {
  const config = await getConfig(tenantId, 'email_settings');
  const raw = (config && config.valor && typeof config.valor === 'object') ? config.valor : {};

  return {
    smtpUrl: String(raw.smtpUrl ?? '').trim(),
    smtpHost: String(raw.smtpHost ?? '').trim(),
    smtpPort: String(raw.smtpPort ?? '').trim(),
    smtpSecure: Boolean(raw.smtpSecure),
    smtpUser: String(raw.smtpUser ?? '').trim(),
    smtpPass: _decryptSecret(raw.smtpPass),
    emailFrom: String(raw.emailFrom ?? '').trim(),
    adminBaseUrl: String(raw.adminBaseUrl ?? '').trim(),
  };
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

const AGENTE_PUBLIC_SELECT = {
  id: true,
  tenantId: true,
  nombre: true,
  email: true,
  whatsapp: true,
  puestoId: true,
  calendarLink: true,
  estado: true,
  lastSeenAt: true,
  createdAt: true,
  puesto: { select: { id: true, nombre: true } },
};

function serializeAgente(agente) {
  if (!agente) return null;
  return {
    ...agente,
    passwordConfigured: Boolean(agente.passwordHash),
  };
}

async function listAgentes(tenantId) {
  const client = getPrismaClient();
  if (!client) return [];
  const agentes = await client.agente.findMany({
    where: { tenantId },
    select: {
      ...AGENTE_PUBLIC_SELECT,
      passwordHash: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  return agentes.map(serializeAgente);
}

async function createAgente({ tenantId, nombre, email, whatsapp = null, puestoId = null, calendarLink = null, passwordHash = null }) {
  const client = getPrismaClient();
  if (!client) return null;
  const agente = await client.agente.create({
    data: {
      tenantId,
      nombre,
      email,
      passwordHash,
      whatsapp,
      puestoId,
      calendarLink,
    },
    select: {
      ...AGENTE_PUBLIC_SELECT,
      passwordHash: true,
    },
  });
  return serializeAgente(agente);
}

async function updateAgente({ id, tenantId, nombre, email, whatsapp = null, puestoId = null, calendarLink = null, passwordHash }) {
  const client = getPrismaClient();
  if (!client) return null;
  const data = {
    nombre,
    email,
    whatsapp,
    puestoId,
    calendarLink,
  };

  if (passwordHash !== undefined) {
    data.passwordHash = passwordHash;
  }

  await client.agente.updateMany({
    where: { id, tenantId },
    data,
  });

  const agente = await client.agente.findFirst({
    where: { id, tenantId },
    select: {
      ...AGENTE_PUBLIC_SELECT,
      passwordHash: true,
    },
  });

  return serializeAgente(agente);
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

async function listSolicitudes(tenantId, { estado, userId, categoria, page = 1, limit = 20 } = {}) {
  const client = getPrismaClient();
  if (!client) return [];
  const normalizedEstado = estado ? normalizeSolicitudStatus(estado, '') : '';
  const normalizedCategoria = normalizeOptionalText(categoria, 80);
  const where = {
    tenantId,
    ...(normalizedEstado ? { estado: normalizedEstado } : {}),
    ...(normalizedCategoria ? { categoria: normalizedCategoria } : {}),
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

  if (result.count > 0 && current?.conversationId) {
    await client.conversation.updateMany({
      where: { id: current.conversationId, tenantId },
      data: {
        assignedAgenteId: agenteId ?? null,
        assignedAt: agenteId ? new Date() : null,
      },
    }).catch(() => {});
  }

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

  const actorType = String(updates.__actorType || 'admin');
  const actorAgenteId = updates.__actorAgenteId !== undefined ? Number(updates.__actorAgenteId) : null;
  const shouldMarkFirstResponse = updates.__markFirstResponseAt !== false;

  delete updates.__actorType;
  delete updates.__actorAgenteId;
  delete updates.__markFirstResponseAt;

  const data = {};
  if (updates.estado !== undefined) {
    data.estado = normalizeSolicitudStatus(updates.estado, current.estado ?? SOLICITUD_STATUS.OPEN);
    data.completedAt = data.estado === SOLICITUD_STATUS.COMPLETED ? new Date() : null;
  }
  if (updates.prioridad !== undefined) data.prioridad = normalizeOptionalText(updates.prioridad, 20);
  if (updates.agenteId !== undefined) data.agenteId = updates.agenteId ? Number(updates.agenteId) : null;
  if (updates.tags !== undefined) data.tags = Array.isArray(updates.tags) ? updates.tags : [];
  if (updates.followUpDate !== undefined) data.followUpDate = normalizeOptionalDate(updates.followUpDate);
  if (updates.dueAt !== undefined) data.dueAt = normalizeOptionalDate(updates.dueAt);
  if (updates.categoria !== undefined) data.categoria = normalizeOptionalText(updates.categoria, 80);
  if (updates.subcategoria !== undefined) data.subcategoria = normalizeOptionalText(updates.subcategoria, 120);
  if (updates.resolutionNotes !== undefined) data.resolutionNotes = normalizeOptionalText(updates.resolutionNotes);
  if (updates.customerNotes !== undefined) data.customerNotes = normalizeOptionalText(updates.customerNotes);

  if (shouldMarkFirstResponse && current.firstResponseAt == null) {
    const nextEstado = data.estado ?? current.estado;
    if ([SOLICITUD_STATUS.IN_PROGRESS, SOLICITUD_STATUS.PENDING_INFO, SOLICITUD_STATUS.COMPLETED].includes(nextEstado)) {
      data.firstResponseAt = new Date();
    }
  }

  const updated = await client.solicitud.update({ where: { id }, data });

  const fieldMap = [
    'estado',
    'prioridad',
    'agenteId',
    'tags',
    'followUpDate',
    'dueAt',
    'categoria',
    'subcategoria',
    'firstResponseAt',
    'resolutionNotes',
    'customerNotes',
  ];

  for (const field of fieldMap) {
    if (data[field] === undefined) continue;
    if (asHistoryValue(current[field]) === asHistoryValue(updated[field])) continue;
    await client.solicitudHistory.create({
      data: {
        solicitudId: id,
        userId: actorType === 'admin' ? actorUserId : null,
        field,
        oldValue: asHistoryValue(current[field]),
        newValue: asHistoryValue(updated[field]),
      },
    }).catch(() => {});

    if (actorType === 'agente' && Number.isInteger(actorAgenteId) && actorAgenteId > 0) {
      await client.solicitudHistory.create({
        data: {
          solicitudId: id,
          userId: null,
          field: `agent:${field}`,
          oldValue: asHistoryValue(current[field]),
          newValue: asHistoryValue({ value: updated[field], agenteId: actorAgenteId }),
        },
      }).catch(() => {});
    }
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
  categoria,
  subcategoria,
  channelSource,
  tags,
  from,
  to,
  dueFrom,
  dueTo,
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
    ...(categoria ? { categoria: String(categoria) } : {}),
    ...(subcategoria ? { subcategoria: String(subcategoria) } : {}),
    ...(channelSource ? { channelSource: String(channelSource) } : {}),
    ...(from || to ? {
      createdAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      },
    } : {}),
    ...(dueFrom || dueTo ? {
      dueAt: {
        ...(dueFrom ? { gte: new Date(dueFrom) } : {}),
        ...(dueTo ? { lte: new Date(dueTo) } : {}),
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

function normalizeDateStart(value, fallback) {
  if (!value) return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
}

function normalizeDateEndExclusive(value, fallback) {
  if (!value) return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const startOfDay = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isNaN(startOfDay.getTime())) {
      return new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
}

function parseReportGroupBy(groupBy) {
  const raw = String(groupBy || 'day').toLowerCase();
  if (raw === 'week') return 'week';
  if (raw === 'month') return 'month';
  return 'day';
}

async function getSolicitudesReport(tenantId, { from, to, groupBy = 'day' } = {}) {
  const client = getPrismaClient();
  if (!client) {
    return {
      summary: { total: 0, open: 0, inProgress: 0, pendingInfo: 0, completed: 0, rejected: 0, avgResolutionMinutes: null },
      byStatus: [],
      byPriority: [],
      byAgent: [],
      series: [],
      range: { from: null, to: null, groupBy: 'day' },
    };
  }

  const now = new Date();
  const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDate = normalizeDateStart(from, defaultStart);
  const toExclusiveDate = normalizeDateEndExclusive(to, now);
  const bucket = parseReportGroupBy(groupBy);

  const [summaryRows, byStatusRows, byPriorityRows, byAgentRows, seriesRows] = await Promise.all([
    client.$queryRawUnsafe(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE estado = 'open')::int AS open,
        COUNT(*) FILTER (WHERE estado = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE estado = 'pending_info')::int AS pending_info,
        COUNT(*) FILTER (WHERE estado = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE estado = 'rejected')::int AS rejected,
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60) FILTER (WHERE completed_at IS NOT NULL), 2)::float AS avg_resolution_minutes
      FROM solicitudes
      WHERE tenant_id = $1::uuid
        AND created_at >= $2
        AND created_at < $3
      `,
      tenantId,
      fromDate,
      toExclusiveDate
    ),
    client.$queryRawUnsafe(
      `
      SELECT
        COALESCE(estado, 'sin_estado') AS estado,
        COUNT(*)::int AS total
      FROM solicitudes
      WHERE tenant_id = $1::uuid
        AND created_at >= $2
        AND created_at < $3
      GROUP BY COALESCE(estado, 'sin_estado')
      ORDER BY total DESC
      `,
      tenantId,
      fromDate,
      toExclusiveDate
    ),
    client.$queryRawUnsafe(
      `
      SELECT
        COALESCE(prioridad, 'sin_prioridad') AS prioridad,
        COUNT(*)::int AS total
      FROM solicitudes
      WHERE tenant_id = $1::uuid
        AND created_at >= $2
        AND created_at < $3
      GROUP BY COALESCE(prioridad, 'sin_prioridad')
      ORDER BY total DESC
      `,
      tenantId,
      fromDate,
      toExclusiveDate
    ),
    client.$queryRawUnsafe(
      `
      SELECT
        s.agente_id AS agente_id,
        COALESCE(a.nombre, 'Sin asignar') AS agente_nombre,
        COUNT(*)::int AS total
      FROM solicitudes s
      LEFT JOIN agentes a
        ON a.id = s.agente_id
       AND a.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1::uuid
        AND s.created_at >= $2
        AND s.created_at < $3
      GROUP BY s.agente_id, COALESCE(a.nombre, 'Sin asignar')
      ORDER BY total DESC
      LIMIT 10
      `,
      tenantId,
      fromDate,
      toExclusiveDate
    ),
    client.$queryRawUnsafe(
      `
      SELECT
        DATE_TRUNC('${bucket}', created_at) AS bucket,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE estado = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE estado = 'rejected')::int AS rejected
      FROM solicitudes
      WHERE tenant_id = $1::uuid
        AND created_at >= $2
        AND created_at < $3
      GROUP BY DATE_TRUNC('${bucket}', created_at)
      ORDER BY bucket ASC
      `,
      tenantId,
      fromDate,
      toExclusiveDate
    ),
  ]);

  const summary = summaryRows?.[0] || {};

  return {
    summary: {
      total: Number(summary.total || 0),
      open: Number(summary.open || 0),
      inProgress: Number(summary.in_progress || 0),
      pendingInfo: Number(summary.pending_info || 0),
      completed: Number(summary.completed || 0),
      rejected: Number(summary.rejected || 0),
      avgResolutionMinutes: summary.avg_resolution_minutes != null ? Number(summary.avg_resolution_minutes) : null,
    },
    byStatus: (byStatusRows || []).map((row) => ({
      estado: String(row.estado),
      total: Number(row.total || 0),
    })),
    byPriority: (byPriorityRows || []).map((row) => ({
      prioridad: String(row.prioridad),
      total: Number(row.total || 0),
    })),
    byAgent: (byAgentRows || []).map((row) => ({
      agenteId: row.agente_id != null ? Number(row.agente_id) : null,
      agenteNombre: String(row.agente_nombre || 'Sin asignar'),
      total: Number(row.total || 0),
    })),
    series: (seriesRows || []).map((row) => ({
      bucket: row.bucket instanceof Date ? row.bucket.toISOString() : String(row.bucket),
      total: Number(row.total || 0),
      completed: Number(row.completed || 0),
      rejected: Number(row.rejected || 0),
    })),
    range: {
      from: fromDate.toISOString(),
      to: toExclusiveDate.toISOString(),
      groupBy: bucket,
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

async function listWebhookConfigs(tenantId, { event } = {}) {
  const client = getPrismaClient();
  if (!client) return [];
  return client.webhookConfig.findMany({
    where: {
      tenantId,
      ...(event ? { event: String(event) } : {}),
    },
    orderBy: [{ active: 'desc' }, { id: 'asc' }],
  });
}

async function createWebhookConfig(tenantId, payload = {}) {
  const client = getPrismaClient();
  if (!client) return null;

  const event = String(payload.event || '').trim().toLowerCase();
  const url = String(payload.url || '').trim();
  if (!event || !url) return null;

  return client.webhookConfig.create({
    data: {
      tenantId,
      event,
      url,
      active: payload.active !== false,
    },
  });
}

async function updateWebhookConfig(tenantId, id, payload = {}) {
  const client = getPrismaClient();
  if (!client) return null;

  const current = await client.webhookConfig.findFirst({ where: { id, tenantId } });
  if (!current) return null;

  return client.webhookConfig.update({
    where: { id },
    data: {
      ...(payload.event !== undefined ? { event: String(payload.event || '').trim().toLowerCase() } : {}),
      ...(payload.url !== undefined ? { url: String(payload.url || '').trim() } : {}),
      ...(payload.active !== undefined ? { active: Boolean(payload.active) } : {}),
    },
  });
}

async function deleteWebhookConfig(tenantId, id) {
  const client = getPrismaClient();
  if (!client) return null;
  const current = await client.webhookConfig.findFirst({ where: { id, tenantId } });
  if (!current) return null;
  await client.webhookConfig.delete({ where: { id } });
  return current;
}

async function markWebhookDeliveryResult(tenantId, webhookId, { ok }) {
  const client = getPrismaClient();
  if (!client || !webhookId) return null;

  const data = ok
    ? { lastTriggeredAt: new Date(), failureCount: 0 }
    : { lastTriggeredAt: new Date(), failureCount: { increment: 1 } };

  return client.webhookConfig.updateMany({
    where: { tenantId, id: Number(webhookId) },
    data,
  });
}

async function listSolicitudWebhookDeliveries(tenantId, { event, status, limit = 50 } = {}) {
  const client = getPrismaClient();
  if (!client) return [];

  const normalizedLimit = Math.max(1, Math.min(200, Number(limit || 50)));
  const where = {
    tenantId,
    accion: {
      in: ['SOLICITUD_WEBHOOK_DELIVERED', 'SOLICITUD_WEBHOOK_FAILED'],
    },
    ...(status === 'ok' ? { accion: 'SOLICITUD_WEBHOOK_DELIVERED' } : {}),
    ...(status === 'failed' ? { accion: 'SOLICITUD_WEBHOOK_FAILED' } : {}),
    ...(event ? {
      metadata: {
        path: ['event'],
        equals: String(event),
      },
    } : {}),
  };

  return client.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: normalizedLimit,
    select: {
      id: true,
      accion: true,
      entidad: true,
      entidadId: true,
      metadata: true,
      createdAt: true,
      adminUser: { select: { id: true, nombre: true, email: true } },
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
async function saveMensaje({
  tenantId,
  userId,
  agenteId,
  waMsgId,
  direccion,
  tipo,
  contenido,
  conversationId,
  status,
  errorReason,
  replyToMensajeId,
}) {
  const client = getPrismaClient();
  if (!client) return null;
  const fallbackStatus = String(direccion ?? '').trim().toLowerCase() === 'entrada' ? 'read' : 'sent';
  return client.mensaje.create({
    data: {
      tenantId,
      userId:         userId ?? null,
      agenteId:       agenteId ?? null,
      waMsgId:        waMsgId ?? null,
      status:         normalizeMensajeStatus(status, fallbackStatus),
      errorReason:    normalizeOptionalText(errorReason),
      replyToMensajeId: Number.isInteger(Number(replyToMensajeId)) && Number(replyToMensajeId) > 0
        ? Number(replyToMensajeId)
        : null,
      direccion,
      tipo,
      contenido,
      conversationId: conversationId ?? null,
    },
  });
}

async function getSolicitudMessagingContext(solicitudId, tenantId) {
  const client = getPrismaClient();
  if (!client) return null;
  return client.solicitud.findFirst({
    where: {
      id: Number(solicitudId),
      tenantId,
    },
    select: {
      id: true,
      tenantId: true,
      userId: true,
      agenteId: true,
      conversationId: true,
      estado: true,
      user: {
        select: {
          id: true,
          phone: true,
          nombre: true,
        },
      },
      conversation: {
        select: {
          id: true,
          status: true,
        },
      },
    },
  });
}

async function listMensajesBySolicitud({ solicitudId, tenantId, page = 1, limit = 50, q, direccion, start, end, lectura }) {
  const client = getPrismaClient();
  if (!client) return null;

  const solicitud = await getSolicitudMessagingContext(Number(solicitudId), tenantId);
  if (!solicitud) return null;

  const currentPage = Math.max(Number(page) || 1, 1);
  const currentLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const skip = (currentPage - 1) * currentLimit;
  const searchQuery = String(q ?? '').trim().toLowerCase();
  const normalizedDireccion = ['entrada', 'salida'].includes(String(direccion ?? '').trim().toLowerCase())
    ? String(direccion).trim().toLowerCase()
    : null;
  const normalizedLectura = ['leido', 'no_leido'].includes(String(lectura ?? '').trim().toLowerCase())
    ? String(lectura).trim().toLowerCase()
    : null;
  const startDate = normalizeMensajeDateFilter(start, 'start');
  const endDate = normalizeMensajeDateFilter(end, 'end');

  if (!solicitud.userId) {
    return {
      solicitud,
      data: [],
      total: 0,
      page: currentPage,
      limit: currentLimit,
    };
  }

  const where = {
    tenantId,
    userId: solicitud.userId,
    ...(normalizedDireccion ? { direccion: normalizedDireccion } : {}),
    ...(normalizedLectura ? { leido: normalizedLectura === 'leido' } : {}),
    ...((startDate || endDate)
      ? {
          createdAt: {
            ...(startDate ? { gte: startDate } : {}),
            ...(endDate ? { lte: endDate } : {}),
          },
        }
      : {}),
  };

  if (!searchQuery) {
    const [total, data] = await Promise.all([
      client.mensaje.count({ where }),
      client.mensaje.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: currentLimit,
        include: {
          user: {
            select: {
              id: true,
              phone: true,
              nombre: true,
            },
          },
        },
      }),
    ]);

    return {
      solicitud,
      data,
      total,
      page: currentPage,
      limit: currentLimit,
    };
  }

  // Text search is applied in-memory because contenido can be heterogeneous JSON.
  const allRows = await client.mensaje.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      user: {
        select: {
          id: true,
          phone: true,
          nombre: true,
        },
      },
    },
  });

  const filteredRows = allRows.filter((row) => {
    const searchableText = extractMensajeSearchText(row.contenido).toLowerCase();
    return searchableText.includes(searchQuery);
  });

  const total = filteredRows.length;
  const data = filteredRows.slice(skip, skip + currentLimit);

  return {
    solicitud,
    data,
    total,
    page: currentPage,
    limit: currentLimit,
  };
}

async function updateMensajeDeliveryStatusByWaMsgId(waMsgId, status) {
  const client = getPrismaClient();
  if (!client || !waMsgId || !status) return null;

  const normalized = normalizeMensajeStatus(status, null);
  if (!normalized) {
    const existing = await client.mensaje.findUnique({ where: { waMsgId } });
    return existing ? { count: 1, updated: false } : { count: 0, updated: false };
  }

  const result = await client.mensaje.updateMany({
    where: { waMsgId },
    data: {
      status: normalized,
      ...(normalized === 'read' ? { leido: true } : {}),
      ...(normalized !== 'failed' ? { errorReason: null } : {}),
    },
  });
  return { count: result.count, updated: result.count > 0, status: normalized };
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
  // Avoid DB-specific DISTINCT/ORDER BY edge cases by deduping in memory.
  // Fetch a bounded recent window and keep first message per conversation key.
  const recent = await client.mensaje.findMany({
    where:   { tenantId },
    orderBy: { createdAt: 'desc' },
    take:    Math.max(Number(limit) * 8, Number(limit)),
    include: { user: true },
  });

  const seen = new Set();
  const threads = [];
  for (const msg of recent) {
    const key = msg.userId ? `u:${msg.userId}` : `p:${msg.user?.phone || `msg_${msg.id}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    threads.push(msg);
    if (threads.length >= Number(limit)) break;
  }

  return threads;
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
  getEmailSettings,
  getWaCredentials,
  CONFIG_SECRET_SENTINEL,
  WA_TOKEN_SENTINEL,
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
  getSolicitudesReport,
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
  listWebhookConfigs,
  createWebhookConfig,
  updateWebhookConfig,
  deleteWebhookConfig,
  markWebhookDeliveryResult,
  listSolicitudWebhookDeliveries,
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
  getSolicitudMessagingContext,
  listMensajesBySolicitud,
  updateMensajeDeliveryStatusByWaMsgId,
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

