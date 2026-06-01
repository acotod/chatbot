'use strict';
/**
 * WhatsApp Business Cloud API service.
 * Handles sending messages via Meta Graph API.
 *
 * Credentials are stored per-tenant in configuraciones:
 *   clave: "wa_credentials"
 *   valor: { phoneNumberId: "...", accessToken: "..." }
 */

const logger = require('../utils/logger');

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v22.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Send a text message to a WhatsApp user.
 * @param {string} phoneNumberId  - Meta phone number ID
 * @param {string} to             - recipient phone (E.164, no +)
 * @param {string} text           - message body
 * @param {string} accessToken    - permanent / system user token
 * @returns {Promise<object>}     - Meta API response
 */
async function sendTextMessage(phoneNumberId, to, text, accessToken) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text },
  };
  return _post(phoneNumberId, payload, accessToken);
}

/**
 * Send an interactive button message.
 * @param {string} phoneNumberId
 * @param {string} to
 * @param {string} bodyText       - message body
 * @param {Array<{id:string, title:string}>} buttons - max 3
 * @param {string} accessToken
 */
async function sendButtonMessage(phoneNumberId, to, bodyText, buttons, accessToken) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };
  return _post(phoneNumberId, payload, accessToken);
}

/**
 * Send a template message (HSM).
 * @param {string} phoneNumberId
 * @param {string} to
 * @param {string} templateName
 * @param {string} languageCode  - e.g. "es_MX"
 * @param {string} accessToken
 */
async function sendTemplateMessage(phoneNumberId, to, templateName, languageCode, accessToken) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };
  return _post(phoneNumberId, payload, accessToken);
}

/**
 * Send an interactive list message (for menus with > 3 options).
 * @param {string} phoneNumberId
 * @param {string} to
 * @param {string} bodyText        - message body
 * @param {string} buttonLabel     - CTA button label (max 20 chars)
 * @param {Array<{title:string, rows:Array<{id:string,title:string,description?:string}>}>} sections
 * @param {string} accessToken
 */
async function sendListMessage(phoneNumberId, to, bodyText, buttonLabel, sections, accessToken) {
  const normalizedSections = (Array.isArray(sections) ? sections : [])
    .map((sec) => {
      const rows = (Array.isArray(sec?.rows) ? sec.rows : [])
        .map((r) => ({
          id: String(r?.id ?? '').trim().slice(0, 200),
          title: String(r?.title ?? '').trim().slice(0, 24),
          description: r?.description ? String(r.description).trim().slice(0, 72) : '',
        }))
        .filter((r) => r.id && r.title)
        .slice(0, 10);

      const title = String(sec?.title ?? '').trim().slice(0, 24);
      return {
        ...(title ? { title } : {}),
        rows,
      };
    })
    .filter((sec) => sec.rows.length > 0)
    .slice(0, 10);

  if (!normalizedSections.length) {
    const err = new Error('Invalid list payload: no valid rows');
    err.status = 400;
    throw err;
  }

  const safeBodyText = String(bodyText ?? '').trim() || 'Selecciona una opcion';
  const safeButtonLabel = String(buttonLabel ?? '').trim() || 'Ver opciones';

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: safeBodyText.slice(0, 1024) },
      action: {
        button: safeButtonLabel.slice(0, 20),
        sections: normalizedSections,
      },
    },
  };
  return _post(phoneNumberId, payload, accessToken);
}

/**
 * Mark an incoming message as read.
 * @param {string} phoneNumberId
 * @param {string} waMsgId
 * @param {string} accessToken
 */
async function markAsRead(phoneNumberId, waMsgId, accessToken) {
  const payload = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: waMsgId,
  };
  return _post(phoneNumberId, payload, accessToken);
}

/**
 * Resolve a media id (image/audio/document) to a temporary Graph download URL.
 * @param {string} mediaId
 * @param {string} accessToken
 */
async function getMediaMetadata(mediaId, accessToken) {
  const normalizedId = String(mediaId ?? '').trim();
  if (!normalizedId) {
    const err = new Error('mediaId is required');
    err.status = 400;
    throw err;
  }

  const url = `${GRAPH_URL}/${normalizedId}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (err) {
    logger.error('WhatsApp media metadata network error', { mediaId: normalizedId, message: err.message });
    throw err;
  }

  const json = await response.json();
  if (!response.ok) {
    logger.error('WhatsApp media metadata error', { mediaId: normalizedId, status: response.status, body: json });
    const err = new Error(json?.error?.message || 'WhatsApp media metadata error');
    err.status = response.status;
    err.waError = json?.error;
    throw err;
  }

  return {
    url: json?.url ? String(json.url) : '',
    mimeType: json?.mime_type ? String(json.mime_type) : '',
    sha256: json?.sha256 ? String(json.sha256) : '',
    fileSize: Number(json?.file_size ?? 0) || null,
    id: normalizedId,
  };
}

/**
 * Download media content from a Graph temporary media URL.
 * @param {string} mediaUrl
 * @param {string} accessToken
 */
async function downloadMediaBuffer(mediaUrl, accessToken) {
  const url = String(mediaUrl ?? '').trim();
  if (!url) {
    const err = new Error('mediaUrl is required');
    err.status = 400;
    throw err;
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (err) {
    logger.error('WhatsApp media download network error', { message: err.message });
    throw err;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.error('WhatsApp media download error', { status: response.status, body: text.slice(0, 500) });
    const err = new Error('WhatsApp media download error');
    err.status = response.status;
    throw err;
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await response.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType,
  };
}

/**
 * Resolve media metadata and download media in one call.
 * @param {string} mediaId
 * @param {string} accessToken
 */
async function downloadMediaById(mediaId, accessToken) {
  const meta = await getMediaMetadata(mediaId, accessToken);
  const file = await downloadMediaBuffer(meta.url, accessToken);
  return {
    ...file,
    ...meta,
  };
}

/**
 * Send a native WhatsApp Flow message (interactive.flow).
 * Opens the Meta Flow UI directly in the user's WhatsApp conversation.
 *
 * @param {string} phoneNumberId
 * @param {string} to                     - recipient phone (E.164, no +)
 * @param {object} params
 * @param {string} params.flowId          - Meta-assigned numeric Flow ID
 * @param {string} [params.flowToken]     - unique token per send (UUID); auto-generated if omitted
 * @param {string} [params.flowCta]       - CTA button label (max 20 chars, default "Abrir")
 * @param {string} [params.bodyText]      - message body (required by Meta)
 * @param {string} [params.headerText]    - optional header text
 * @param {string} [params.footerText]    - optional footer text
 * @param {string} [params.initialScreen] - first screen to open (default: first screen in definition)
 * @param {object} [params.screenData]    - optional data payload for the initial screen
 * @param {string} accessToken
 */
async function sendFlowMessage(phoneNumberId, to, params, accessToken) {
  const {
    flowId,
    flowToken,
    flowCta      = 'Abrir',
    bodyText     = ' ',
    headerText,
    footerText,
    initialScreen,
    screenData,
  } = params ?? {};

  if (!flowId) {
    const err = new Error('sendFlowMessage: flowId is required');
    err.status = 400;
    throw err;
  }

  // Generate a unique token per send if not provided
  const token = flowToken || crypto.randomUUID();

  const actionPayload = {
    screen: initialScreen || 'INIT',
    ...(screenData && typeof screenData === 'object' ? { data: screenData } : {}),
  };

  const interactive = {
    type: 'flow',
    body: { text: String(bodyText).trim() || ' ' },
    action: {
      name: 'flow',
      parameters: {
        flow_message_version: '3',
        flow_token: String(token),
        flow_id: String(flowId),
        flow_cta: String(flowCta).trim().slice(0, 20) || 'Abrir',
        flow_action: 'navigate',
        flow_action_payload: actionPayload,
      },
    },
  };

  if (headerText) {
    interactive.header = { type: 'text', text: String(headerText).trim() };
  }

  if (footerText) {
    interactive.footer = { text: String(footerText).trim() };
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  };

  return _post(phoneNumberId, payload, accessToken);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const crypto = require('crypto');

async function _post(phoneNumberId, payload, accessToken) {
  const url = `${GRAPH_URL}/${phoneNumberId}/messages`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.error('WhatsApp API network error', { message: err.message });
    throw err;
  }

  const json = await response.json();

  if (!response.ok) {
    logger.error('WhatsApp API error', { status: response.status, body: json });
    const err = new Error(json?.error?.message || 'WhatsApp API error');
    err.status = response.status;
    err.waError = json?.error;
    throw err;
  }

  return json;
}

module.exports = {
  sendTextMessage,
  sendButtonMessage,
  sendListMessage,
  sendTemplateMessage,
  sendFlowMessage,
  markAsRead,
  getMediaMetadata,
  downloadMediaBuffer,
  downloadMediaById,
};
