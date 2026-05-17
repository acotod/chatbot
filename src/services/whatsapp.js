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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

module.exports = { sendTextMessage, sendButtonMessage, sendListMessage, sendTemplateMessage, markAsRead };
