'use strict';
/**
 * GET  /whatsapp                    — Meta webhook verification
 * POST /whatsapp                    — WhatsApp Cloud API incoming webhook
 * POST /whatsapp/send               — Send outbound text (admin panel)
 * GET  /whatsapp/conversaciones     — List conversation threads (admin panel)
 * GET  /whatsapp/mensajes           — Full message history for a user (admin panel)
 * GET  /whatsapp/flows              — Meta Flows webhook verification
 * POST /whatsapp/flows              — Meta Flows data_exchange endpoint
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const db = require('../services/database');
const socketService = require('../services/socketService');
const wa = require('../services/whatsapp');
const chatbotRouter = require('../services/chatbotRouter');
const requireJwt = require('../middleware/requireJwt');
const { getRedisClient } = require('../services/redis');
const { getNextScreen } = require('../services/flowNavigation');
const { ingestEvent } = require('../services/eventGateway');
const crmSync = require('../services/crmSync');
const { getPrismaClient } = require('../services/database');
const {
  DEFAULT_TRANSCRIPTION_CONFIG,
  getTenantTranscriptionConfig,
  transcribeAudioBuffer,
} = require('../services/audioTranscription');

const router = express.Router();

async function resolveTenantId(req, explicitTenantSlug) {
  const fromAuth =
    req.admin?.tenantId ??
    req.admin?.tenant_id ??
    req.user?.tenantId ??
    req.user?.tenant_id;
  if (fromAuth) return fromAuth;

  const isSuperAdmin = Boolean(req.admin?.superAdmin ?? req.user?.superAdmin);
  if (!isSuperAdmin) return null;

  const slug = typeof explicitTenantSlug === 'string' ? explicitTenantSlug.trim() : '';
  if (!slug) return null;

  const prisma = getPrismaClient();
  if (!prisma) return null;

  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true },
  });
  return tenant?.id ?? null;
}

function _toIsoFromUnixSeconds(seconds) {
  const ts = Number(seconds);
  if (!Number.isFinite(ts)) return new Date().toISOString();
  return new Date(ts * 1000).toISOString();
}

async function _ingestUegBestEffort({ tenantId, correlationId, idempotencyKey, rawEvent, context }) {
  try {
    await ingestEvent({
      tenantId,
      correlationId,
      idempotencyKeyHeader: idempotencyKey,
      rawEvent,
    });
  } catch (uegErr) {
    logger.warn('UEG dual-write failed on /whatsapp', {
      tenantId,
      context,
      message: uegErr.message,
    });
  }
}

function _extractMediaFromContenido(tipo, contenido) {
  const payload = (contenido && typeof contenido === 'object') ? contenido : {};
  const normalizedTipo = String(tipo ?? '').trim().toLowerCase();
  const candidates = ['image', 'audio', 'document'];

  if (candidates.includes(normalizedTipo)) {
    const media = payload[normalizedTipo];
    if (media && typeof media === 'object') {
      return { type: normalizedTipo, media };
    }
  }

  for (const candidate of candidates) {
    const media = payload[candidate];
    if (media && typeof media === 'object') {
      return { type: candidate, media };
    }
  }

  const raw = (payload.raw && typeof payload.raw === 'object') ? payload.raw : null;
  if (raw) {
    for (const candidate of candidates) {
      const media = raw[candidate];
      if (media && typeof media === 'object') {
        return { type: candidate, media };
      }
    }
  }

  return null;
}

async function _transcribeAudioMessageBestEffort({
  tenant,
  mensaje,
  phone,
  userId,
  phoneNumberId,
  accessToken,
  correlationId,
  conversationMeta,
}) {
  try {
    const existingAudioTranscript = (mensaje?.contenido && typeof mensaje.contenido === 'object')
      ? mensaje.contenido.audioTranscript
      : null;
    if (existingAudioTranscript && typeof existingAudioTranscript === 'object') {
      const existingStatus = String(existingAudioTranscript.status || '').trim().toLowerCase();
      if (existingStatus === 'processing' || existingStatus === 'completed') {
        logger.info('Audio transcription skipped: already processed', {
          tenantId: tenant?.id,
          mensajeId: mensaje?.id,
          status: existingStatus,
        });
        return;
      }
    }

    const config = await getTenantTranscriptionConfig(tenant.id);
    if (!config.enabled) return;

    const audioMatch = _extractMediaFromContenido('audio', mensaje?.contenido);
    const audioPayload = audioMatch?.type === 'audio' ? audioMatch.media : null;
    const mediaId = String(audioPayload?.id ?? '').trim();
    if (!mediaId) return;
    if (!accessToken) {
      logger.warn('Audio transcription skipped: missing access token', { tenantId: tenant.id, mensajeId: mensaje.id });
      return;
    }

    const startedContenido = {
      ...(mensaje.contenido || {}),
      audioTranscript: {
        status: 'processing',
        provider: config.provider,
        updatedAt: new Date().toISOString(),
      },
    };

    const prisma = getPrismaClient();
    if (!prisma) return;

    await prisma.mensaje.update({
      where: { id: mensaje.id },
      data: { contenido: startedContenido },
    });

    socketService.emit(tenant.id, 'mensaje_actualizado', {
      id: mensaje.id,
      userId,
      tipo: 'audio',
      contenido: startedContenido,
      createdAt: mensaje.createdAt,
      direccion: mensaje.direccion,
    });

    const media = await wa.downloadMediaById(mediaId, accessToken);
    const transcript = await transcribeAudioBuffer({
      buffer: media.buffer,
      mimeType: media.mimeType || audioPayload?.mime_type || 'audio/ogg',
      tenantId: tenant.id,
      config,
    });

    const completedContenido = {
      ...(mensaje.contenido || {}),
      audioTranscript: {
        status: transcript.ok ? 'completed' : 'failed',
        provider: transcript.provider || config.provider,
        text: transcript.text || null,
        error: transcript.error || null,
        meta: transcript.meta || {},
        updatedAt: new Date().toISOString(),
      },
    };

    await prisma.mensaje.update({
      where: { id: mensaje.id },
      data: { contenido: completedContenido },
    });

    socketService.emit(tenant.id, 'mensaje_actualizado', {
      id: mensaje.id,
      userId,
      tipo: 'audio',
      contenido: completedContenido,
      createdAt: mensaje.createdAt,
      direccion: mensaje.direccion,
    });

    if (config.useForBotInput && userId !== null) {
      const transcriptInput = transcript.ok && transcript.text
        ? transcript.text
        : '__voice_note__';

      _runChatbot({
        tenant,
        userId,
        phone,
        userInput: transcriptInput,
        phoneNumberId,
        accessToken,
        correlationId,
        inboundMensajeId: mensaje.id,
        conversationMeta,
      }).catch((err) => logger.error('_runChatbot(audio transcript) error', {
        tenantId: tenant.id,
        mensajeId: mensaje.id,
        message: err.message,
      }));
    }
  } catch (err) {
    logger.warn('Audio transcription best-effort failed', {
      tenantId: tenant?.id,
      mensajeId: mensaje?.id,
      message: err.message,
    });
  }
}

// ── Meta Webhook Signature Verification ─────────────────────────────────────
// Validates X-Hub-Signature-256 sent by Meta on every POST.
// Tries tenant-level secrets first, then environment fallbacks.
async function resolveMetaAppSecrets(req) {
  const secretCandidates = [];
  const pushCandidate = (label, value) => {
    const normalized = String(value ?? '').trim();
    if (!normalized) return;
    if (secretCandidates.some((item) => item.value === normalized)) return;
    secretCandidates.push({ label, value: normalized });
  };

  const prisma = getPrismaClient();
  if (!prisma) {
    pushCandidate('WA_APP_SECRET', process.env.WA_APP_SECRET);
    pushCandidate('FACEBOOK_APP_SECRET', process.env.FACEBOOK_APP_SECRET);
    return secretCandidates;
  }

  const phoneNumberId = String(
    req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ??
    req.body?.phone_number_id ??
    req.query?.phone_number_id ??
    ''
  ).trim();

  if (phoneNumberId) {
    const waConfigs = await prisma.configuracion.findMany({
      where: { clave: 'wa_credentials' },
      select: { tenantId: true, valor: true },
    });
    const matched = waConfigs.find((row) => {
      const configuredPhone = String(row?.valor?.phoneNumberId ?? '').trim();
      return configuredPhone === phoneNumberId;
    });

    if (matched?.tenantId) {
      const secretFromDb = await db.getWaAppSecret(matched.tenantId);
      pushCandidate('db:phone-match', secretFromDb);
    }
  }

  const waSecretRows = await prisma.configuracion.findMany({
    where: { clave: { in: ['wa_app_secret', 'whatsapp_app_secret'] } },
    select: { tenantId: true },
  });
  if (waSecretRows.length === 1) {
    const secretFromDb = await db.getWaAppSecret(waSecretRows[0].tenantId);
    pushCandidate('db:single-tenant', secretFromDb);
  }

  pushCandidate('WA_APP_SECRET', process.env.WA_APP_SECRET);
  pushCandidate('FACEBOOK_APP_SECRET', process.env.FACEBOOK_APP_SECRET);

  return secretCandidates;
}

async function verifyMetaSignature(req, res, next) {
  try {
    const secretCandidates = await resolveMetaAppSecrets(req);
    if (!secretCandidates.length) {
      logger.warn('WA_APP_SECRET not set: webhook signature verification is disabled');
      return next();
    }

    const sig = req.headers['x-hub-signature-256'];
    if (!sig) {
      return res.status(401).json({ error: 'Missing webhook signature' });
    }

    if (!req.rawBody) {
      logger.error('rawBody unavailable — ensure express.json verify is configured');
      return res.status(400).json({ error: 'Raw body unavailable for signature check' });
    }

    const received = String(sig).trim();
    const signatureMatch = received.match(/^(?:sha256\s*=\s*)?"?([a-f0-9]{64})"?$/i);
    if (!signatureMatch) {
      logger.warn('WhatsApp webhook signature invalid format', {
        correlationId: req.correlationId,
        headerLength: received.length,
        headerSample: received.slice(0, 32),
      });
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const receivedHex = signatureMatch[1].toLowerCase();
    const receivedBuf = Buffer.from(receivedHex, 'hex');

    let matched = false;
    const triedHashes = [];
    for (const candidate of secretCandidates) {
      const expectedHex = crypto
        .createHmac('sha256', candidate.value)
        .update(req.rawBody)
        .digest('hex');
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      if (crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
        matched = true;
        break;
      }
      triedHashes.push({
        label: candidate.label,
        secretSHA256: crypto.createHash('sha256').update(candidate.value).digest('hex'),
        expectedPrefix: expectedHex.slice(0, 16),
      });
    }

    if (!matched) {
      const bodyPreview = req.rawBody.slice(0, 200).toString('utf8').replace(/[\x00-\x1f]/g, '?');
      logger.warn('WhatsApp webhook signature mismatch (all secrets tried)', {
        correlationId: req.correlationId,
        receivedSig: received,
        triedHashes,
        bodyLength: req.rawBody.length,
        bodyPreview,
        contentType: req.headers['content-type'],
      });
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } catch (err) {
    if (err instanceof RangeError) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    return next(err);
  }

  next();
}

function normalizeFlowText(value) {
  return String(value ?? '').trim();
}

async function getFlowPrivateKeyPem(tenantId = null) {
  if (tenantId) {
    const cfg = await db.getConfig(tenantId, 'flow_endpoint_private_key');
    const configuredKey =
      typeof cfg?.valor === 'string'
        ? cfg.valor
        : cfg?.valor && typeof cfg.valor === 'object'
          ? cfg.valor.privateKey
          : null;

    const normalizedConfigured = normalizeFlowText(configuredKey).replace(/\\n/g, '\n');
    if (normalizedConfigured) {
      return normalizedConfigured;
    }
  }

  const rawKey =
    process.env.WA_FLOW_PRIVATE_KEY ||
    process.env.FLOW_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;

  const normalized = normalizeFlowText(rawKey).replace(/\\n/g, '\n');
  if (!normalized) {
    throw new Error('Flow private key is not configured');
  }

  return normalized;
}

function isEncryptedFlowRequest(body) {
  return Boolean(
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    typeof body.encrypted_flow_data === 'string' &&
    typeof body.encrypted_aes_key === 'string' &&
    typeof body.initial_vector === 'string'
  );
}

function flipInitialVector(initialVectorBuffer) {
  const flipped = Buffer.alloc(initialVectorBuffer.length);
  for (let index = 0; index < initialVectorBuffer.length; index += 1) {
    flipped[index] = initialVectorBuffer[index] ^ 0xff;
  }
  return flipped;
}

async function decryptFlowRequest(body, tenantId = null) {
  const privateKeyPem = await getFlowPrivateKeyPem(tenantId);
  const privateKey = crypto.createPrivateKey({ key: privateKeyPem });
  const aesKeyBuffer = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(body.encrypted_aes_key, 'base64')
  );

  const initialVectorBuffer = Buffer.from(body.initial_vector, 'base64');
  const encryptedFlowDataBuffer = Buffer.from(body.encrypted_flow_data, 'base64');
  const authTagLength = 16;

  if (encryptedFlowDataBuffer.length <= authTagLength) {
    throw new Error('encrypted_flow_data is too short');
  }

  const encryptedPayload = encryptedFlowDataBuffer.subarray(0, -authTagLength);
  const authTag = encryptedFlowDataBuffer.subarray(-authTagLength);

  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, initialVectorBuffer);
  decipher.setAuthTag(authTag);

  const decryptedJson = Buffer.concat([
    decipher.update(encryptedPayload),
    decipher.final(),
  ]).toString('utf8');

  return {
    decryptedBody: JSON.parse(decryptedJson),
    aesKeyBuffer,
    initialVectorBuffer,
  };
}

function encryptFlowResponse(payload, aesKeyBuffer, initialVectorBuffer) {
  const cipher = crypto.createCipheriv(
    'aes-128-gcm',
    aesKeyBuffer,
    flipInitialVector(initialVectorBuffer)
  );

  return Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}

function resolveFlowScreenName(screen, data, action) {
  const candidates = [
    screen,
    data?.screen,
    data?.current_screen,
    data?.previous_screen,
    data?.previousScreen,
    data?.entry_screen,
    data?.start_screen,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeFlowText(candidate);
    if (normalized) return normalized;
  }

  if (action === 'INIT' || action === 'BACK') {
    return 'INICIO';
  }

  return null;
}

function sendFlowResponse(res, payload, encryptedContext) {
  if (!encryptedContext) {
    return res.json(payload);
  }

  return res
    .type('text/plain')
    .send(encryptFlowResponse(payload, encryptedContext.aesKeyBuffer, encryptedContext.initialVectorBuffer));
}

function getFlowVariableCandidates(variableName) {
  const normalized = normalizeFlowText(variableName);
  if (!normalized) return [];

  const candidates = new Set([normalized]);
  const segments = normalized.split('.').filter(Boolean);
  if (segments.length > 0) {
    candidates.add(segments[segments.length - 1]);
  }
  if (segments.length > 1 && segments[0].toLowerCase() === 'variables') {
    candidates.add(segments.slice(1).join('.'));
  }
  return [...candidates];
}

function getFlowDataValue(data, variableName) {
  if (!data || typeof data !== 'object') return undefined;
  for (const candidate of getFlowVariableCandidates(variableName)) {
    if (Object.prototype.hasOwnProperty.call(data, candidate)) {
      return data[candidate];
    }
  }
  return undefined;
}

function getPublishedFlowNodeResponse(definition, screenId) {
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const node = nodes.find((item) => item?.id === screenId);
  if (!node) return { screen: screenId, data: {} };

  return {
    screen: node.id,
    data: {
      text: String(node.config?.text ?? '').trim(),
      title: String(node.config?.title ?? '').trim(),
      options: Array.isArray(node.config?.options)
        ? node.config.options.map((option) => ({
            id: String(option?.id ?? ''),
            title: String(option?.title ?? option?.id ?? '').trim(),
          }))
        : [],
    },
  };
}

function resolvePublishedFlowNextScreen(definition, screenId, action, data) {
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const entryPoint = normalizeFlowText(definition?.entry_point) || normalizeFlowText(nodes[0]?.id);
  const normalizedAction = normalizeFlowText(action).toUpperCase();

  if (!screenId || normalizedAction === 'INIT') {
    return entryPoint;
  }

  const node = nodes.find((item) => item?.id === screenId);
  if (!node) return entryPoint;
  if (normalizedAction === 'BACK') return screenId;

  if (node.type === 'menu') {
    const selectedRaw = getFlowDataValue(data, node.config?.variable);
    const selected = normalizeFlowText(selectedRaw);
    if (selected) {
      const matchedOption = Array.isArray(node.config?.options)
        ? node.config.options.find((option) => {
            const optionId = normalizeFlowText(option?.id);
            const optionTitle = normalizeFlowText(option?.title);
            return selected === optionId || selected === optionTitle;
          })
        : null;
      const branchKey = matchedOption?.id ?? selected;
      return node.branches?.[branchKey] ?? node.next ?? screenId;
    }

    // Some Meta Flow payloads omit the expected variable key for menu selections.
    // If the menu has exactly one option, auto-advance to avoid getting stuck
    // on single-option screens (except explicit BACK actions).
    const options = Array.isArray(node.config?.options) ? node.config.options : [];
    if (normalizedAction !== 'BACK' && options.length === 1) {
      const onlyOptionId = normalizeFlowText(options[0]?.id);
      if (onlyOptionId) {
        return node.branches?.[onlyOptionId] ?? node.next ?? screenId;
      }
    }

    return screenId;
  }

  if (node.type === 'input') {
    const capturedValue = getFlowDataValue(data, node.config?.variable);
    return capturedValue !== undefined ? node.next ?? screenId : screenId;
  }

  return node.next ?? screenId;
}

async function getTenantPublishedFlowDefinition(tenantId) {
  const prisma = getPrismaClient();
  if (!prisma || !tenantId) return null;

  const version = await prisma.flowVersion.findFirst({
    where: { tenantId, published: true },
    orderBy: { versionNumber: 'desc' },
    select: { definition: true },
  });

  return version?.definition ?? null;
}

// ── GET: Meta webhook verification ──────────────────────────────────────────

router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verification failed', { mode, token });
  return res.sendStatus(403);
});

// ── POST: incoming events ────────────────────────────────────────────────────

router.post('/', verifyMetaSignature, async (req, res, next) => {
  // Be tolerant to misconfigured Flows endpoints that still post to /whatsapp.
  if (isEncryptedFlowRequest(req.body) || req.body?.flow_token || req.body?.action === 'ping') {
    return handleMetaFlowsDataExchange(req, res, next);
  }

  // Always acknowledge immediately — Meta expects 200 within 20 s
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value;

        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // Resolve tenant by phone_number_id
        const tenant = await db.findTenantByWaPhoneNumberId(phoneNumberId);
        if (!tenant) {
          logger.warn('No tenant for phone_number_id', { phoneNumberId });
          continue;
        }

        // Get access token for outbound replies
        const { accessToken } = await db.getWaCredentials(tenant.id);

        // Handle status updates (delivery receipts)
        for (const status of value.statuses ?? []) {
          logger.info('WhatsApp status update', {
            tenantId: tenant.id,
            msgId: status.id,
            status: status.status,
          });

          await db.updateMensajeDeliveryStatusByWaMsgId(status.id, status.status).catch(() => null);

          await _ingestUegBestEffort({
            tenantId: tenant.id,
            correlationId: req.correlationId,
            idempotencyKey: status.id ? `wa_status:${status.id}:${status.status}` : null,
            rawEvent: {
              channel: 'whatsapp',
              source: 'meta_whatsapp_cloud',
              eventType: 'message_status_updated',
              direction: 'inbound',
              occurredAt: _toIsoFromUnixSeconds(status.timestamp),
              payload: {
                phoneNumberId,
                status,
              },
              metadata: {
                route: '/whatsapp',
                type: 'status_update',
              },
            },
            context: 'status_update',
          });

          socketService.emit(tenant.id, 'wa_status', {
            waMsgId: status.id,
            status: status.status,
            timestamp: status.timestamp,
          });

          socketService.emit(tenant.id, 'SOLICITUD_MESSAGE_STATUS', {
            waMsgId: status.id,
            status: status.status,
            timestamp: status.timestamp,
          });
        }

        // Handle incoming messages
        for (const msg of value.messages ?? []) {
          await _handleIncomingMessage({
            msg,
            contacts: value.contacts,
            tenant,
            phoneNumberId,
            accessToken,
            correlationId: req.correlationId,
          });
        }
      }
    }
  } catch (err) {
    logger.error('Error processing WhatsApp webhook', { message: err.message, stack: err.stack });
  }
});

// ── Private ──────────────────────────────────────────────────────────────────

async function _handleIncomingMessage({ msg, contacts, tenant, phoneNumberId, accessToken, correlationId, conversationMeta }) {
  const phone   = msg.from;
  const waMsgId = msg.id;
  const tipo    = msg.type;

  // ── Idempotency: skip if already processed (Meta may redeliver) ──────────
  if (waMsgId) {
    const existing = await db.findMensajeByWaMsgId(waMsgId);
    if (existing) {
      logger.info('Duplicate WhatsApp message ignored', { waMsgId });
      return;
    }
  }

  // Resolve / create user
  const user   = await db.findOrCreateUser(phone, tenant.id);
  const userId = user?.id ?? null;

  // Fail early if we can't identify the user
  if (userId === null) {
    logger.error('Could not create or find user for incoming WhatsApp message', {
      tenantId: tenant.id,
      phone,
      waMsgId,
    });
    return;
  }


  // ── Build contenido + extract chatbot input ──────────────────────────────
  let contenido;
  let userInput = null;

  switch (tipo) {
    case 'text':
      contenido = { text: msg.text?.body };
      userInput = msg.text?.body ?? null;
      break;
    case 'interactive': {
      const iType = msg.interactive?.type;
      if (iType === 'nfm_reply') {
        // WhatsApp Flows (Native Flow Message) completion
        const nfm = msg.interactive.nfm_reply ?? {};
        let formData = {};
        try { formData = JSON.parse(nfm.response_json ?? '{}'); } catch {}
        contenido = { interactive: { type: 'nfm_reply', data: formData } };
        userInput = nfm.response_json ?? null;
      } else {
        const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
        contenido = { interactive: { type: iType, reply } };
        userInput = reply?.id ?? null;
      }
      break;
    }
    case 'image':
      contenido = { image: msg.image };
      break;
    case 'audio':
      contenido = { audio: msg.audio };
      break;
    case 'document':
      contenido = { document: msg.document };
      break;
    default:
      contenido = { raw: msg };
  }

  if (tipo === 'text' && typeof userInput === 'string' && userInput.trim()) {
    userInput = await _normalizeTextMenuSelection({
      tenantId: tenant.id,
      userId,
      rawInput: userInput,
    });
  }

  // --- BLOQUEO DE FLUJO SI HAY SOLICITUD ABIERTA ---
  if (userId !== null) {
    const openSolicitud = await db.findOpenSolicitudForUser(userId, tenant.id);
    if (openSolicitud) {
      // Opcional: puedes personalizar el mensaje
      await wa.sendText(phoneNumberId, phone, 'Ya tienes una solicitud activa. Por favor espera a que sea atendida antes de iniciar un nuevo trámite.', accessToken, tenant, userId, correlationId);
      logger.info('Intento de reinicio de flujo bloqueado por solicitud activa', { tenantId: tenant.id, userId, phone });
      return {
        userId,
        messageId: mensaje?.id,
        conversationId: null,
        blockedByOpenSolicitud: true,
      };
    }
  }

  // Persist message
  const mensaje = await db.saveMensaje({
    tenantId:  tenant.id,
    userId,
    waMsgId,
    direccion: 'entrada',
    tipo,
    contenido,
  });
  // Store mensaje.id so we can back-fill conversationId after the chatbot runs
  const mensajeId = mensaje.id;

  const messageWithContenido = {
    ...mensaje,
    contenido,
    direccion: 'entrada',
  };

  await _ingestUegBestEffort({
    tenantId: tenant.id,
    correlationId,
    idempotencyKey: waMsgId,
    rawEvent: {
      channel: 'whatsapp',
      source: 'meta_whatsapp_cloud',
      eventType: 'message_received',
      direction: 'inbound',
      occurredAt: _toIsoFromUnixSeconds(msg.timestamp),
      payload: {
        userId,
        phone,
        waMsgId,
        tipo,
        contenido,
      },
      metadata: {
        route: '/whatsapp',
        type: 'incoming_message',
      },
    },
    context: 'incoming_message',
  });

  const contactName = contacts?.find((c) => c.wa_id === phone)?.profile?.name ?? null;

  // ── CRM auto-sync (best-effort, non-blocking) ────────────────────────────
  if (userId !== null) {
    crmSync.touch({ userId, prisma: getPrismaClient(), canal: 'whatsapp', nombre: contactName }).catch(() => {});
  }

  logger.info('WhatsApp message received', {
    tenantId: tenant.id,
    userId,
    phone,
    tipo,
    waMsgId,
  });

  // Emit real-time event to admin dashboard
  socketService.emit(tenant.id, 'nuevo_mensaje', {
    id:          mensaje.id,
    userId,
    phone,
    contactName,
    tipo,
    contenido,
    waMsgId,
    createdAt:   mensaje.createdAt,
  });

  // Notify open solicitudes for this contact (best-effort, non-blocking)
  if (userId !== null) {
    getPrismaClient().solicitud.findFirst({
      where: { tenantId: tenant.id, userId, estado: { notIn: ['completed', 'rejected'] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    }).then((sol) => {
      if (sol) {
        socketService.emit(tenant.id, 'SOLICITUD_MESSAGE_SENT', {
          solicitudId: sol.id,
          mensaje,
        });
      }
    }).catch(() => {});
  }

  // Mark as read (best-effort)
  if (accessToken) {
    wa.markAsRead(phoneNumberId, waMsgId, accessToken).catch((err) => {
      logger.warn('Could not mark message as read', { waMsgId, message: err.message });
    });
  }

  // ── Chatbot engine ───────────────────────────────────────────────────────
  let chatbotConversationId = null;
  if (userId !== null && userInput !== null) {
    if (conversationMeta?.sandbox === true) {
      try {
        chatbotConversationId = await _runChatbot({
          tenant,
          userId,
          phone,
          userInput,
          phoneNumberId,
          accessToken,
          correlationId,
          inboundMensajeId: mensajeId,
          conversationMeta,
        });
      } catch (err) {
        logger.error('_runChatbot error', { tenantId: tenant.id, message: err.message, sandbox: true });
      }
    } else {
      _runChatbot({ tenant, userId, phone, userInput, phoneNumberId, accessToken, correlationId, inboundMensajeId: mensajeId, conversationMeta })
        .catch((err) => logger.error('_runChatbot error', { tenantId: tenant.id, message: err.message }));
    }
  }

  if (tipo === 'audio') {
    setImmediate(() => {
      _transcribeAudioMessageBestEffort({
        tenant,
        mensaje: messageWithContenido,
        phone,
        userId,
        phoneNumberId,
        accessToken,
        correlationId,
        conversationMeta,
      });
    });
  }

  return {
    userId,
    messageId: mensajeId,
    conversationId: chatbotConversationId,
  };
}

// ── Chatbot dispatcher ────────────────────────────────────────────────────────

async function _runChatbot({ tenant, userId, phone, userInput, phoneNumberId, accessToken, correlationId, inboundMensajeId, conversationMeta }) {
  const { response, fallbackToHuman, conversationId } = await chatbotRouter.routeMessage({
    tenantId: tenant.id,
    userId,
    input: userInput,
    phone,
    conversationMeta,
  });

  // Back-fill conversationId on the inbound message that triggered this run
  if (conversationId && inboundMensajeId) {
    getPrismaClient().mensaje.update({
      where: { id: inboundMensajeId },
      data:  { conversationId },
    }).catch(() => {});
  }

  if (fallbackToHuman) {
    await _handleFallbackToHuman({
      tenant,
      userId,
      phone,
      response,
      phoneNumberId,
      accessToken,
      correlationId,
      conversationId,
      conversationMeta,
    });
  } else if (response) {
    await _sendChatbotResponse({
      tenant,
      userId,
      phone,
      phoneNumberId,
      accessToken,
      response,
      correlationId,
      conversationId,
      conversationMeta,
    });
  }

  return conversationId ?? null;
}

async function _handleFallbackToHuman({ tenant, userId, phone, response, phoneNumberId, accessToken, correlationId, conversationId, conversationMeta }) {
  // Send handoff message to user if provided
  if (response?.text) {
    await _sendText(phoneNumberId, phone, response.text, accessToken, tenant, userId, correlationId, {
      conversationId,
      conversationMeta,
    });
  }

  // Create solicitud for human agent follow-up (avoid duplicates)
  const openSolicitud = await db.findOpenSolicitudForUser(userId, tenant.id);
  if (!openSolicitud) {
    await db.saveSolicitud(userId, {}, tenant.id);
    logger.info('Solicitud created for human handoff', { tenantId: tenant.id, userId, phone });
  }

  // Emit real-time handoff event to admin panel
  socketService.emit(tenant.id, 'chatbot_handoff', {
    userId,
    phone,
    tenantId: tenant.id,
  });
}

async function _sendChatbotResponse({ tenant, userId, phone, phoneNumberId, accessToken, response, correlationId, conversationId, conversationMeta }) {
  const type = response?.type ?? 'text';
  // Default: send native interactive (selectable) WhatsApp menus/buttons.
  // Opt-in to text fallback only when explicitly enabled.
  const forceTextInteractive = process.env.WA_FORCE_TEXT_INTERACTIONS === '1';
  const preferTextMenu = type === 'list' && (forceTextInteractive || process.env.WA_PREFER_TEXT_MENU === '1');
  const preferTextButtons = type === 'buttons' && forceTextInteractive;
  const useSandboxOutboundMock =
    conversationMeta?.sandbox === true && conversationMeta?.outboundMetaMock === true;

  const persistFailedOutbound = async (reason) => {
    try {
      const failedMsg = await db.saveMensaje({
        tenantId: tenant.id,
        userId,
        waMsgId: null,
        direccion: 'salida',
        tipo: ((type === 'buttons' && !preferTextButtons) || (type === 'list' && !preferTextMenu)) ? 'interactive' : 'text',
        contenido: response,
        conversationId: conversationId ?? undefined,
        status: 'failed',
        errorReason: reason,
      });

      if (failedMsg) {
        socketService.emit(tenant.id, 'nuevo_mensaje', {
          id: failedMsg.id,
          userId,
          phone,
          tipo: failedMsg.tipo,
          contenido: failedMsg.contenido,
          waMsgId: failedMsg.waMsgId,
          createdAt: failedMsg.createdAt,
          direccion: 'salida',
          status: failedMsg.status,
          errorReason: failedMsg.errorReason,
        });
      }
    } catch (persistErr) {
      logger.warn('Failed to persist outbound failed message', {
        tenantId: tenant.id,
        phone,
        message: persistErr.message,
      });
    }
  };

  if (useSandboxOutboundMock) {
    const mockWaMsgId = `sandbox-outbound-${Date.now()}`;
    const outboundMsg = await db.saveMensaje({
      tenantId:       tenant.id,
      userId,
      waMsgId:        mockWaMsgId,
      direccion:      'salida',
      tipo:           type === 'buttons' ? 'interactive' : 'text',
      contenido:      { ...(response || {}), mock: true, mockMode: 'outboundMetaMock' },
      conversationId: conversationId ?? undefined,
    });

    await _ingestUegBestEffort({
      tenantId: tenant.id,
      correlationId,
      idempotencyKey: outboundMsg.waMsgId ?? `wa_outbound:${outboundMsg.id}`,
      rawEvent: {
        channel: 'whatsapp',
        source: 'sandbox_meta_mock',
        eventType: 'message_sent',
        direction: 'outbound',
        occurredAt: outboundMsg.createdAt,
        payload: {
          userId,
          phone,
          waMsgId: outboundMsg.waMsgId,
          tipo: outboundMsg.tipo,
          contenido: response,
        },
        metadata: {
          route: '/sandbox/simulate/inbound',
          type: 'chatbot_response_mock',
          mock: true,
        },
      },
      context: 'chatbot_response_mock',
    });

    socketService.emit(tenant.id, 'nuevo_mensaje', {
      id:        outboundMsg.id,
      userId,
      phone,
      tipo:      outboundMsg.tipo,
      contenido: outboundMsg.contenido,
      waMsgId:   outboundMsg.waMsgId,
      createdAt: outboundMsg.createdAt,
      direccion: 'salida',
    });
    return;
  }

  if (!accessToken || !phoneNumberId) {
    const reason = 'Missing WhatsApp credentials';
    logger.warn('_sendChatbotResponse skipped: missing credentials', {
      tenantId: tenant.id,
      phone,
      hasAccessToken: Boolean(accessToken),
      hasPhoneNumberId: Boolean(phoneNumberId),
    });
    await persistFailedOutbound(reason);
    return;
  }

  try {
    let waResp;
    let persistedTipo = (type === 'buttons' || type === 'list') ? 'interactive' : 'text';
    let persistedContenido = response;

    if (type === 'buttons') {
      if (preferTextButtons) {
        const fallbackText = _buildButtonsFallbackText(response)
          || _sanitizeWaText(response.text, { max: 4096 })
          || 'Selecciona una opcion';
        waResp = await wa.sendTextMessage(phoneNumberId, phone, fallbackText, accessToken);
        persistedTipo = 'text';
        persistedContenido = { type: 'text', text: fallbackText };
      } else {
        const buttons = (response.buttons ?? []).slice(0, 3);
        waResp = await wa.sendButtonMessage(phoneNumberId, phone, response.text ?? '', buttons, accessToken);
      }
    } else if (type === 'list') {
      if (preferTextMenu) {
        const fallbackText = _buildListFallbackText(response)
          || _sanitizeWaText(response.text, { max: 4096 })
          || 'Selecciona una opcion';
        waResp = await wa.sendTextMessage(phoneNumberId, phone, fallbackText, accessToken);
        persistedTipo = 'text';
        persistedContenido = { type: 'text', text: fallbackText };
      } else {
      const sections = _normalizeListSections(response);
      if (!sections.length) {
        const fallbackText = String(response.text ?? '').trim() || 'Selecciona una opcion';
        waResp = await wa.sendTextMessage(
          phoneNumberId,
          phone,
          fallbackText,
          accessToken,
        );
        persistedTipo = 'text';
        persistedContenido = { type: 'text', text: fallbackText };
      } else {
        const buttonLabel = String(response.buttonLabel ?? 'Ver opciones').trim() || 'Ver opciones';
        waResp = await wa.sendListMessage(
          phoneNumberId,
          phone,
          String(response.text ?? '').trim() || 'Selecciona una opcion',
          buttonLabel,
          sections,
          accessToken,
        );

        // Opt-in only: avoid sending a duplicate text version of the list.
        // Set WA_LIST_TEXT_FALLBACK=1 to also send the text variant alongside the native list.
        const shouldSendDesktopFallback = process.env.WA_LIST_TEXT_FALLBACK === '1';
        if (shouldSendDesktopFallback) {
          const fallbackText = _buildListFallbackText(response);
          if (fallbackText) {
            await wa.sendTextMessage(phoneNumberId, phone, fallbackText, accessToken);
          }
        }
      }
      }
    } else if (type === 'waba_flow') {
      // Native WhatsApp Flow interactive message
      const flowId = response.flow_id ?? response.flowId;
      if (!flowId) {
        logger.warn('_sendChatbotResponse: waba_flow content missing flow_id, falling back to text', {
          tenantId: tenant.id, phone,
        });
        const fallback = String(response.body_text ?? response.bodyText ?? response.text ?? '').trim();
        if (fallback) {
          waResp = await wa.sendTextMessage(phoneNumberId, phone, fallback, accessToken);
          persistedTipo = 'text';
          persistedContenido = { type: 'text', text: fallback };
        }
      } else {
        waResp = await wa.sendFlowMessage(
          phoneNumberId,
          phone,
          {
            flowId,
            flowToken:     response.flow_token   ?? response.flowToken,
            flowCta:       response.flow_cta      ?? response.flowCta      ?? 'Abrir',
            bodyText:      response.body_text     ?? response.bodyText     ?? response.text ?? ' ',
            headerText:    response.header_text   ?? response.headerText,
            footerText:    response.footer_text   ?? response.footerText,
            initialScreen: response.initial_screen ?? response.initialScreen,
            screenData:    response.screen_data   ?? response.screenData,
          },
          accessToken,
        );
        persistedTipo = 'interactive';
        persistedContenido = response;
      }
    } else {
      // text or end
      waResp = await wa.sendTextMessage(phoneNumberId, phone, response.text ?? '', accessToken);
    }

    // Persist outbound message
    const outboundMsg = await db.saveMensaje({
      tenantId:       tenant.id,
      userId,
      waMsgId:        waResp?.messages?.[0]?.id ?? null,
      direccion:      'salida',
      tipo:           persistedTipo,
      contenido:      persistedContenido,
      conversationId: conversationId ?? undefined,
    });

    await _ingestUegBestEffort({
      tenantId: tenant.id,
      correlationId,
      idempotencyKey: outboundMsg.waMsgId ?? `wa_outbound:${outboundMsg.id}`,
      rawEvent: {
        channel: 'whatsapp',
        source: 'chatbot_runtime',
        eventType: 'message_sent',
        direction: 'outbound',
        occurredAt: outboundMsg.createdAt,
        payload: {
          userId,
          phone,
          waMsgId: outboundMsg.waMsgId,
          tipo: outboundMsg.tipo,
          contenido: persistedContenido,
        },
        metadata: {
          route: '/whatsapp',
          type: 'chatbot_response',
        },
      },
      context: 'chatbot_response',
    });

    socketService.emit(tenant.id, 'nuevo_mensaje', {
      id:        outboundMsg.id,
      userId,
      phone,
      tipo:      outboundMsg.tipo,
      contenido: persistedContenido,
      waMsgId:   outboundMsg.waMsgId,
      createdAt: outboundMsg.createdAt,
      direccion: 'salida',
    });
  } catch (err) {
    if (type === 'list') {
      try {
        const fallbackText = _buildListFallbackText(response);
        if (fallbackText) {
          await wa.sendTextMessage(phoneNumberId, phone, fallbackText, accessToken);
        }
      } catch (fallbackErr) {
        logger.warn('List fallback text send failed', {
          tenantId: tenant.id,
          phone,
          message: fallbackErr.message,
        });
      }
    } else if (type === 'buttons' && preferTextButtons) {
      try {
        const fallbackText = _buildButtonsFallbackText(response);
        if (fallbackText) {
          await wa.sendTextMessage(phoneNumberId, phone, fallbackText, accessToken);
        }
      } catch (fallbackErr) {
        logger.warn('Buttons fallback text send failed', {
          tenantId: tenant.id,
          phone,
          message: fallbackErr.message,
        });
      }
    }

    await persistFailedOutbound(err.message);

    logger.error('_sendChatbotResponse failed, enqueueing retry', {
      tenantId: tenant.id,
      phone,
      message: err.message,
    });

    // Enqueue for retry
    const redis = getRedisClient();
    if (redis) {
      const queuePayload = {
        tenantId: tenant.id,
        phone,
        messagePayload: type === 'buttons'
          ? (
            preferTextButtons
              ? _buildTextPayload(
                phone,
                _buildButtonsFallbackText(response)
                  || _sanitizeWaText(response.text, { max: 4096 })
                  || 'Selecciona una opcion',
              )
              : _buildButtonPayload(phone, response)
          )
          : type === 'list'
            ? (
              preferTextMenu
                ? _buildTextPayload(
                  phone,
                  _buildListFallbackText(response)
                    || _sanitizeWaText(response.text, { max: 4096 })
                    || 'Selecciona una opcion',
                )
                : _buildListPayload(phone, response)
            )
            : _buildTextPayload(phone, response.text ?? ''),
        attempts: 0,
      };
      await redis.lpush('queue:wa_send', JSON.stringify(queuePayload));
    }
  }
}

function _buildTextPayload(to, text) {
  const safeText = _sanitizeWaText(text, { max: 4096 }) || 'Selecciona una opcion';
  return {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    type:              'text',
    text:              { preview_url: false, body: safeText },
  };
}

function _buildButtonPayload(to, response) {
  const buttons = (response.buttons ?? []).slice(0, 3);
  const bodyText = _sanitizeWaText(response.text, { max: 1024 }) || 'Selecciona una opcion';
  return {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    type:              'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText.slice(0, 1024) },
      action: {
        buttons: buttons
          .map((b) => ({
            type: 'reply',
            reply: {
              id: String(b.id ?? '').trim().slice(0, 256),
              title: _sanitizeWaText(b.title, { max: 20, allowNewlines: false }),
            },
          }))
          .filter((b) => b.reply.id && b.reply.title),
      },
    },
  };
}

function _normalizeListSections(response) {
  let sections = Array.isArray(response?.sections) ? response.sections : [];
  if (!sections.length && Array.isArray(response?.buttons) && response.buttons.length) {
    sections = [{ title: 'Opciones', rows: response.buttons }];
  }

  return sections
    .map((sec) => {
      const rows = (Array.isArray(sec?.rows) ? sec.rows : [])
        .map((r) => ({
          id: String(r?.id ?? '').trim().slice(0, 200),
          title: _sanitizeWaText(r?.title, { max: 24, allowNewlines: false }),
          description: r?.description ? _sanitizeWaText(r.description, { max: 72, allowNewlines: false }) : '',
        }))
        .filter((r) => r.id && r.title)
        .slice(0, 10);

      const title = _sanitizeWaText(sec?.title, { max: 24, allowNewlines: false });
      return {
        ...(title ? { title } : {}),
        rows,
      };
    })
    .filter((sec) => sec.rows.length > 0)
    .slice(0, 10);
}

function _buildListPayload(to, response) {
  const sections = _normalizeListSections(response);
  if (!sections.length) {
    return _buildTextPayload(to, _sanitizeWaText(response?.text, { max: 4096 }) || 'Selecciona una opcion');
  }

  const bodyText = _sanitizeWaText(response?.text, { max: 1024 }) || 'Selecciona una opcion';
  const buttonLabel = _sanitizeWaText(response?.buttonLabel, { max: 20, allowNewlines: false }) || 'Ver opciones';

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText.slice(0, 1024) },
      action: {
        button: buttonLabel.slice(0, 20),
        sections,
      },
    },
  };
}

function _buildListFallbackText(response) {
  const sections = _normalizeListSections(response);
  if (!sections.length) return '';

  let optionIndex = 1;
  const lines = [];
  const header = _sanitizeWaText(response?.text, { max: 512 });
  if (header) lines.push(header);
  lines.push('Responde con el numero o con el ID de la opcion:');

  for (const sec of sections) {
    if (sec.title) lines.push(`- ${sec.title}`);
    for (const row of sec.rows) {
      lines.push(`  ${optionIndex}) ${row.title} (ID: ${row.id})`);
      optionIndex += 1;
    }
  }

  return lines.join('\n').slice(0, 3500);
}

function _buildButtonsFallbackText(response) {
  const buttons = Array.isArray(response?.buttons) ? response.buttons.slice(0, 10) : [];
  if (!buttons.length) return '';

  const lines = [];
  const header = _sanitizeWaText(response?.text, { max: 512 });
  if (header) lines.push(header);
  lines.push('Responde con el numero o con el ID de la opcion:');

  for (let i = 0; i < buttons.length; i += 1) {
    const btn = buttons[i];
    const title = _sanitizeWaText(btn?.title, { max: 80, allowNewlines: false });
    const id = _sanitizeWaText(btn?.id, { max: 80, allowNewlines: false });
    if (title && id) {
      lines.push(`${i + 1}) ${title} (ID: ${id})`);
    }
  }

  return lines.join('\n').slice(0, 3500);
}

function _parseMenuOptionsFromText(text) {
  if (!text) return [];

  const options = [];
  const lines = String(text).split(/\r?\n/);

  for (const line of lines) {
    const idMatch = line.match(/\(ID:\s*([^\)]+)\)/i);
    if (!idMatch) continue;

    const id = _sanitizeWaText(idMatch[1], { max: 256, allowNewlines: false });
    if (!id) continue;

    const numberMatch = line.match(/^\s*(\d+)\s*[\)\.\-:]/);
    const titleRaw = line
      .replace(/^\s*(\d+)\s*[\)\.\-:]\s*/, '')
      .replace(/\(ID:\s*[^\)]+\)/i, '')
      .trim();
    const title = _sanitizeWaText(titleRaw, { max: 120, allowNewlines: false });

    options.push({
      id,
      title: title || null,
      number: numberMatch ? Number(numberMatch[1]) : null,
    });
  }

  return options;
}

async function _normalizeTextMenuSelection({ tenantId, userId, rawInput }) {
  const normalizedInput = _sanitizeWaText(rawInput, { max: 256, allowNewlines: false });
  if (!normalizedInput) return rawInput;

  try {
    const recentOutbound = await getPrismaClient().mensaje.findMany({
      where: {
        tenantId,
        userId,
        direccion: 'salida',
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        contenido: true,
        createdAt: true,
      },
    });

    for (const msg of recentOutbound) {
      const text = msg?.contenido?.text;
      const options = _parseMenuOptionsFromText(text);
      if (!options.length) continue;

      const exactId = options.find((opt) => opt.id.toLowerCase() === normalizedInput.toLowerCase());
      if (exactId) return exactId.id;

      const asNumber = normalizedInput.match(/^\s*(\d{1,2})\s*$/);
      if (asNumber) {
        const numeric = Number(asNumber[1]);
        const byNumber = options.find((opt) => opt.number === numeric) || options[numeric - 1];
        if (byNumber?.id) return byNumber.id;
      }

      const byTitle = options.find((opt) => opt.title && opt.title.toLowerCase() === normalizedInput.toLowerCase());
      if (byTitle?.id) return byTitle.id;
    }
  } catch (err) {
    logger.warn('Could not normalize text menu selection', {
      tenantId,
      userId,
      message: err.message,
    });
  }

  return rawInput;
}

function _sanitizeWaText(value, { max = 1024, allowNewlines = true } = {}) {
  let text = String(value ?? '');

  // Repair frequent UTF-8 mojibake patterns from legacy payloads.
  text = text
    .replace(/Ã¡/g, 'a')
    .replace(/Ã©/g, 'e')
    .replace(/Ã­/g, 'i')
    .replace(/Ã³/g, 'o')
    .replace(/Ãº/g, 'u')
    .replace(/Ã±/g, 'n')
    .replace(/Ã/g, '')
    .replace(/�/g, '')
    .replace(/ð/g, '');

  // Drop invalid UTF-16 surrogates that can break Graph validation/display.
  text = text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  if (!allowNewlines) {
    text = text.replace(/[\r\n]+/g, ' ');
  }

  return text.trim().slice(0, max);
}

async function _sendText(phoneNumberId, phone, text, accessToken, tenant, userId, correlationId, options = {}) {
  const conversationId = options?.conversationId ?? null;
  const useSandboxOutboundMock =
    options?.conversationMeta?.sandbox === true && options?.conversationMeta?.outboundMetaMock === true;

  const persistFailedText = async (reason) => {
    try {
      const msg = await db.saveMensaje({
        tenantId: tenant.id,
        userId,
        waMsgId: null,
        direccion: 'salida',
        tipo: 'text',
        contenido: { text },
        conversationId: conversationId ?? undefined,
        status: 'failed',
        errorReason: reason,
      });

      if (msg) {
        socketService.emit(tenant.id, 'nuevo_mensaje', {
          id: msg.id,
          userId,
          phone,
          tipo: 'text',
          contenido: msg.contenido,
          waMsgId: msg.waMsgId,
          createdAt: msg.createdAt,
          direccion: 'salida',
          status: msg.status,
          errorReason: msg.errorReason,
        });
      }
    } catch (persistErr) {
      logger.warn('Failed to persist fallback failed message', {
        tenantId: tenant.id,
        phone,
        message: persistErr.message,
      });
    }
  };

  if (useSandboxOutboundMock) {
    try {
      const mockWaMsgId = `sandbox-outbound-${Date.now()}`;
      const msg = await db.saveMensaje({
        tenantId:       tenant.id,
        userId,
        waMsgId:        mockWaMsgId,
        direccion:      'salida',
        tipo:           'text',
        contenido:      { text, mock: true, mockMode: 'outboundMetaMock' },
        conversationId: conversationId ?? undefined,
      });

      await _ingestUegBestEffort({
        tenantId: tenant.id,
        correlationId,
        idempotencyKey: msg.waMsgId ?? `wa_outbound:${msg.id}`,
        rawEvent: {
          channel: 'whatsapp',
          source: 'sandbox_meta_mock',
          eventType: 'message_sent',
          direction: 'outbound',
          occurredAt: msg.createdAt,
          payload: {
            userId,
            phone,
            waMsgId: msg.waMsgId,
            tipo: 'text',
            contenido: { text },
          },
          metadata: {
            route: '/sandbox/simulate/inbound',
            type: 'fallback_message_mock',
            mock: true,
          },
        },
        context: 'fallback_message_mock',
      });

      socketService.emit(tenant.id, 'nuevo_mensaje', {
        id: msg.id, userId, phone,
        tipo: 'text', contenido: msg.contenido, waMsgId: msg.waMsgId,
        createdAt: msg.createdAt, direccion: 'salida',
      });
    } catch (err) {
      logger.warn('_sendText sandbox mock failed', { tenantId: tenant.id, phone, message: err.message });
    }
    return;
  }

  if (!accessToken || !phoneNumberId) {
    const reason = 'Missing WhatsApp credentials';
    logger.warn('_sendText skipped: missing credentials', {
      tenantId: tenant.id,
      phone,
      hasAccessToken: Boolean(accessToken),
      hasPhoneNumberId: Boolean(phoneNumberId),
    });
    await persistFailedText(reason);
    return;
  }

  try {
    const waResp = await wa.sendTextMessage(phoneNumberId, phone, text, accessToken);
    const msg = await db.saveMensaje({
      tenantId:  tenant.id,
      userId,
      waMsgId:   waResp?.messages?.[0]?.id ?? null,
      direccion: 'salida',
      tipo:      'text',
      contenido: { text },
    });

    await _ingestUegBestEffort({
      tenantId: tenant.id,
      correlationId,
      idempotencyKey: msg.waMsgId ?? `wa_outbound:${msg.id}`,
      rawEvent: {
        channel: 'whatsapp',
        source: 'chatbot_runtime',
        eventType: 'message_sent',
        direction: 'outbound',
        occurredAt: msg.createdAt,
        payload: {
          userId,
          phone,
          waMsgId: msg.waMsgId,
          tipo: 'text',
          contenido: { text },
        },
        metadata: {
          route: '/whatsapp',
          type: 'fallback_message',
        },
      },
      context: 'fallback_message',
    });

    socketService.emit(tenant.id, 'nuevo_mensaje', {
      id: msg.id, userId, phone,
      tipo: 'text', contenido: { text }, waMsgId: msg.waMsgId,
      createdAt: msg.createdAt, direccion: 'salida',
    });
  } catch (err) {
    await persistFailedText(err.message);
    logger.warn('_sendText failed', { tenantId: tenant.id, phone, message: err.message });
  }
}

router._sandbox = {
  handleIncomingMessage: _handleIncomingMessage,
  runChatbot: _runChatbot,
  sendChatbotResponse: _sendChatbotResponse,
  sendText: _sendText,
  verifyMetaSignature,
};

// ── Send outbound message (used by admin routes) ─────────────────────────────

/**
 * POST /whatsapp/send
 * Body: { tenantId, to, text }
 * Auth: JWT required (handled by caller middleware)
 */
router.post('/send', requireJwt, async (req, res, next) => {
  try {
    const fromBodyTenantId = typeof req.body?.tenantId === 'string' ? req.body.tenantId.trim() : '';
    const tenantSlug = typeof req.body?.tenantSlug === 'string' ? req.body.tenantSlug.trim() : '';
    const resolvedTenantId = await resolveTenantId(req, tenantSlug);
    const tenantId = fromBodyTenantId || resolvedTenantId;
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    const text = typeof req.body?.text === 'string' ? req.body.text : '';

    if (!tenantId || !to || !text.trim()) {
      return res.status(400).json({ error: 'tenantId/tenantSlug, to and text are required' });
    }

    const creds = await db.getWaCredentials(tenantId);
    if (!creds?.phoneNumberId || !creds?.accessToken) {
      return res.status(422).json({ error: 'WhatsApp credentials not configured for this tenant' });
    }

    const { phoneNumberId, accessToken } = creds;

    const user    = await db.findOrCreateUser(to, tenantId);
    if (!user) {
      return res.status(500).json({ error: 'Failed to create or find user' });
    }

    const waResp  = await wa.sendTextMessage(phoneNumberId, to, text, accessToken);

    const mensaje = await db.saveMensaje({
      tenantId,
      userId:    user.id,
      waMsgId:   waResp.messages?.[0]?.id ?? null,
      direccion: 'salida',
      tipo:      'text',
      contenido: { text },
    });

    await _ingestUegBestEffort({
      tenantId,
      correlationId: req.correlationId,
      idempotencyKey: mensaje.waMsgId ?? `wa_outbound:${mensaje.id}`,
      rawEvent: {
        channel: 'whatsapp',
        source: 'admin_panel',
        eventType: 'message_sent',
        direction: 'outbound',
        occurredAt: mensaje.createdAt,
        payload: {
          userId: user.id,
          phone: to,
          waMsgId: mensaje.waMsgId,
          tipo: 'text',
          contenido: { text },
        },
        metadata: {
          route: '/whatsapp/send',
          type: 'admin_message',
        },
      },
      context: 'admin_message',
    });

    socketService.emit(tenantId, 'nuevo_mensaje', {
      id:        mensaje.id,
      userId:    user.id,
      phone:     to,
      tipo:      'text',
      contenido: { text },
      waMsgId:   waResp.messages?.[0]?.id ?? null,
      createdAt: mensaje.createdAt,
      direccion: 'salida',
    });

    return res.json({ ok: true, mensajeId: mensaje.id, waResponse: waResp });
  } catch (err) {
    const status = Number(err?.status) || 0;
    const waMessage = String(err?.waError?.message ?? err?.message ?? '').toLowerCase();
    const invalidMetaCredentials = status === 400
      && (waMessage.includes('unsupported post request')
        || waMessage.includes('does not exist')
        || waMessage.includes('missing permissions'));

    if (invalidMetaCredentials) {
      return res.status(422).json({
        error: 'Invalid WhatsApp credentials for tenant (phoneNumberId/accessToken)',
      });
    }

    next(err);
  }
});

// ── Admin: list conversation threads ─────────────────────────────────────────

/**
 * GET /whatsapp/conversaciones?tenantId= | ?tenantSlug=
 * Returns the latest message per unique user (conversation thread list).
 * Requires JWT.
 */
router.get('/conversaciones', requireJwt, async (req, res, next) => {
  try {
    const fromQueryTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
    const resolvedTenantId = await resolveTenantId(req, req.query.tenantSlug);
    const tenantId = fromQueryTenantId || resolvedTenantId;
    if (!tenantId) return res.status(400).json({ error: 'tenantId or tenantSlug is required' });

    const threads = await db.listConversaciones(tenantId);
    return res.json({ data: threads });
  } catch (err) {
    next(err);
  }
});

// ── Admin: message history for one user ──────────────────────────────────────

/**
 * GET /whatsapp/mensajes?tenantId=&userId=&page= | ?tenantSlug=&userId=&page=
 * Returns paginated message history for a user in a tenant.
 * Requires JWT.
 */
router.get('/mensajes', requireJwt, async (req, res, next) => {
  try {
    const { userId, page, limit } = req.query;
    const fromQueryTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
    const resolvedTenantId = await resolveTenantId(req, req.query.tenantSlug);
    const tenantId = fromQueryTenantId || resolvedTenantId;

    if (!tenantId || !userId) {
      return res.status(400).json({ error: 'tenantId/tenantSlug and userId are required' });
    }
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const mensajes = await db.listMensajes(tenantId, Number(userId), {
      page: page ? Number(page) : 1,
      limit: parsedLimit,
    });
    return res.json({ data: mensajes, page: page ? Number(page) : 1, limit: parsedLimit, count: mensajes.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /whatsapp/media/:messageId?tenantId= | ?tenantSlug=
 * Streams message media (image/audio/document) to admin UI.
 * Requires JWT.
 */
router.get('/media/:messageId', requireJwt, async (req, res, next) => {
  try {
    const parsedMessageId = Number(req.params.messageId);
    if (!Number.isInteger(parsedMessageId) || parsedMessageId <= 0) {
      return res.status(400).json({ error: 'Invalid messageId' });
    }

    const fromQueryTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
    const resolvedTenantId = await resolveTenantId(req, req.query.tenantSlug);
    const tenantId = fromQueryTenantId || resolvedTenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId or tenantSlug is required' });
    }

    const prisma = getPrismaClient();
    if (!prisma) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const mensaje = await prisma.mensaje.findFirst({
      where: {
        id: parsedMessageId,
        tenantId,
      },
      select: {
        id: true,
        tipo: true,
        contenido: true,
      },
    });

    if (!mensaje) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const mediaMatch = _extractMediaFromContenido(mensaje.tipo, mensaje.contenido);
    if (!mediaMatch) {
      return res.status(404).json({ error: 'Media metadata not found in message' });
    }

    const mediaPayload = mediaMatch.media;
    const mediaType = mediaMatch.type;

    const creds = await db.getWaCredentials(tenantId);
    if (!creds?.accessToken) {
      return res.status(422).json({ error: 'WhatsApp access token not configured for tenant' });
    }

    let mediaUrl = String(mediaPayload.link ?? '').trim();
    let contentType = String(mediaPayload.mime_type ?? '').trim();

    if (!mediaUrl) {
      const mediaId = String(mediaPayload.id ?? '').trim();
      if (!mediaId) {
        return res.status(404).json({ error: 'Media id not available for this message' });
      }
      const meta = await wa.getMediaMetadata(mediaId, creds.accessToken);
      mediaUrl = meta.url;
      if (!contentType) contentType = meta.mimeType || contentType;
    }

    const file = await wa.downloadMediaBuffer(mediaUrl, creds.accessToken);
    if (!contentType) {
      if (mediaType === 'image') contentType = 'image/jpeg';
      else if (mediaType === 'audio') contentType = 'audio/ogg';
      else if (mediaType === 'document') contentType = 'application/octet-stream';
    }

    res.setHeader('Content-Type', contentType || file.contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).send(file.buffer);
  } catch (err) {
    const status = Number(err?.status) || 502;
    const waMessage = String(err?.waError?.message ?? err?.message ?? '').toLowerCase();
    const shouldMapToNotFound = status === 400
      && (waMessage.includes('unsupported get request')
        || waMessage.includes('does not exist')
        || waMessage.includes('missing permissions'));

    if (shouldMapToNotFound) {
      return res.status(404).json({ error: 'Media unavailable or expired' });
    }

    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.message || 'Media unavailable' });
    }
    return next(err);
  }
});

// ── Meta Flows: data_exchange endpoint (Fase 5) ──────────────────────────────
// GET /whatsapp/flows  — Meta Flows webhook verification
// POST /whatsapp/flows — Meta Flows data_exchange (screen navigation)
//
// Tenant resolution: by flow_token stored in configuraciones
//   { clave: "flow_token", valor: { token: "..." } }
// OR fallback: resolves by WA_VERIFY_TOKEN (single tenant setups).
// Meta sends X-Hub-Signature-256 — validated by verifyMetaSignature.

router.get('/flows', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    logger.info('Meta Flows webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('Meta Flows webhook verification failed', { mode, token });
  return res.sendStatus(403);
});

async function handleMetaFlowsDataExchange(req, res, next) {
  try {
    const tenantSlugFromQuery = normalizeFlowText(req.query.tenant || req.query.tenantSlug);
    const tenantFromQuery = tenantSlugFromQuery
      ? await db.findTenantBySlug(tenantSlugFromQuery)
      : null;

    const encryptedContext = isEncryptedFlowRequest(req.body)
      ? await decryptFlowRequest(req.body, tenantFromQuery?.id ?? null)
      : null;
    const requestBody = encryptedContext?.decryptedBody ?? req.body;
    const { flow_token, action, screen, data = {} } = requestBody;

    // Ping health check from Meta
    if (action === 'ping') {
      return sendFlowResponse(res, { data: { status: 'active' } }, encryptedContext);
    }

    if (!flow_token && !tenantFromQuery) {
      return res.status(400).json({ error: 'flow_token is required' });
    }

    // Resolve tenant
    let tenant = null;
    if (flow_token) {
      tenant = await db.findTenantByFlowToken(flow_token);
    }

    if (!tenant && tenantFromQuery) {
      tenant = tenantFromQuery;
    }

    if (!tenant) {
      logger.warn('Meta Flows: tenant not resolved', { flow_token });
      return res.status(400).json({ error: 'Cannot resolve tenant from flow_token' });
    }

    if (!tenant.activo) {
      return res.status(403).json({ error: 'Tenant is inactive' });
    }

    // Resolve user if phone is in data
    let userId = null;
    if (data.phone) {
      const user = await db.findOrCreateUser(data.phone, tenant.id);
      userId = user?.id ?? null;
    }

    const resolvedScreen = resolveFlowScreenName(screen, data, action);
    if (!resolvedScreen) {
      logger.warn('Meta Flows screen missing', {
        tenantId: tenant.id,
        action: normalizeFlowText(action) || null,
        screen: normalizeFlowText(screen) || null,
        dataKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : [],
      });
      return res.status(400).json({ error: 'screen is required' });
    }

    // Persist event
    await db.saveEvent(userId, resolvedScreen, data, tenant.id);

    // Persist solicitud when applicable
    if (resolvedScreen === 'SOLICITUD_ESPACIO') {
      await db.saveSolicitud(userId, data, tenant.id);
    }

    // Load tenant flow config override (fallback to default)
    const flowConfig = await db.getConfig(tenant.id, 'flow_navigation');
    const navigationOverride = flowConfig ? flowConfig.valor : null;
    const publishedDefinition = await getTenantPublishedFlowDefinition(tenant.id);

    const normalizedAction = String(action || '').toUpperCase();
    const fallbackScreen = publishedDefinition
      ? resolvePublishedFlowNextScreen(
          publishedDefinition,
          normalizeFlowText(screen) || normalizeFlowText(data?.screen),
          normalizedAction,
          data,
        )
      : null;

    // Keep INIT on the current screen, but force submit-like actions forward.
    // Meta can send inconsistent action values across clients/versions.
    let nextScreen;
    if (fallbackScreen) {
      nextScreen = fallbackScreen;
    } else if (resolvedScreen === 'SOLICITUD_ESPACIO' && normalizedAction !== 'INIT') {
      nextScreen = 'CIERRE';
    } else {
      nextScreen = normalizedAction === 'INIT' || normalizedAction === 'BACK'
        ? resolvedScreen
        : getNextScreen(resolvedScreen, data, navigationOverride);
    }
    if (nextScreen === null && resolvedScreen === 'SOLICITUD_ESPACIO') {
      // Defensive fallback: never block users after submitting request form.
      nextScreen = 'CIERRE';
      logger.warn('Meta Flows fallback applied: SOLICITUD_ESPACIO -> CIERRE', {
        tenantId: tenant.id,
        action,
      });
    }
    if (nextScreen === null) {
      logger.warn('Meta Flows navigation failed', { tenantId: tenant.id, screen: resolvedScreen });
      return res.status(400).json({ error: `Unknown screen or option for screen: ${resolvedScreen}` });
    }

    // Enqueue urgencia async processing
    if (resolvedScreen === 'URGENCIA' || nextScreen === 'URGENCIA') {
      const redis = getRedisClient();
      if (redis) {
        await redis.lpush('queue:urgencias', JSON.stringify({
          tenantId: tenant.id, userId, screen: resolvedScreen, nextScreen, data, timestamp: Date.now(),
        }));
      }
    }

    logger.info('Meta Flows navigation', { tenantId: tenant.id, from: resolvedScreen, to: nextScreen, action });

    // Load screen templates for the next screen
    const templatesCfg = await db.getConfig(tenant.id, 'screen_templates');
    const templates = templatesCfg?.valor ?? {};
    const screenData = templates[nextScreen] ?? (publishedDefinition
      ? getPublishedFlowNodeResponse(publishedDefinition, nextScreen).data
      : {});

    return sendFlowResponse(res, { screen: nextScreen, data: screenData }, encryptedContext);
  } catch (err) {
    if (/Flow private key is not configured|bad decrypt|unable to authenticate data|encrypted_flow_data is too short/i.test(err.message || '')) {
      logger.warn('Meta Flows decryption failed', { message: err.message });
      return res.status(421).json({ error: 'Unable to decrypt flow payload' });
    }
    next(err);
  }
}

router.post('/flows', verifyMetaSignature, async (req, res, next) => {
  return handleMetaFlowsDataExchange(req, res, next);
});

router._flowsCrypto = {
  decryptFlowRequest,
  encryptFlowResponse,
  flipInitialVector,
  isEncryptedFlowRequest,
  resolveFlowScreenName,
};

module.exports = router;