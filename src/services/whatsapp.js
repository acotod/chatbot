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

const GRAPH_URL = 'https://graph.facebook.com/v19.0';

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

module.exports = { sendTextMessage, sendButtonMessage, sendTemplateMessage, markAsRead };
