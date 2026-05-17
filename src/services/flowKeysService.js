'use strict';
/**
 * Flow Keys Service
 *
 * Handles:
 * - Auto-generation of RSA key pairs for Meta Flows encryption
 * - Registration of public keys with Meta's Graph API
 * - Validation of encrypted Flow requests/responses
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v25.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Generate RSA-2048 key pair for Meta Flows
 * @returns {{ publicKey: string, privateKey: string }}
 */
function generateFlowKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return { publicKey, privateKey };
}

/**
 * Register Flow public key with Meta
 *
 * @param {string} phoneNumberId - WhatsApp phone number ID
 * @param {string} publicKeyPem - Public key in PEM format
 * @param {string} accessToken - Meta Graph API access token
 *
 * @returns {Promise<{ ok: boolean, error?: string, meta?: object }>}
 */
async function registerFlowPublicKey(phoneNumberId, publicKeyPem, accessToken) {
  if (!phoneNumberId || !publicKeyPem || !accessToken) {
    return {
      ok: false,
      error: 'Missing phoneNumberId, publicKeyPem, or accessToken',
    };
  }

  try {
    const endpoint = `${GRAPH_URL}/${phoneNumberId}/whatsapp_business_encryption`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        business_public_key: publicKeyPem,
      }).toString(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;

      logger.warn('Failed to register Flow public key with Meta', {
        phoneNumberId,
        status: response.status,
        error: errorMsg,
      });

      return {
        ok: false,
        error: errorMsg,
        meta: errorData,
      };
    }

    const result = await response.json();

    logger.info('Flow public key registered with Meta', {
      phoneNumberId,
      signatureStatus: result.business_public_key_signature_status,
    });

    return {
      ok: true,
      meta: result,
    };
  } catch (err) {
    logger.error('Error registering Flow public key', {
      phoneNumberId,
      error: err.message,
    });

    return {
      ok: false,
      error: err.message,
    };
  }
}

/**
 * Get current Flow public key registration status from Meta
 *
 * @param {string} phoneNumberId - WhatsApp phone number ID
 * @param {string} accessToken - Meta Graph API access token
 *
 * @returns {Promise<{ ok: boolean, status?: string, error?: string }>}
 */
async function getFlowPublicKeyStatus(phoneNumberId, accessToken) {
  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      error: 'Missing phoneNumberId or accessToken',
    };
  }

  try {
    const endpoint = `${GRAPH_URL}/${phoneNumberId}/whatsapp_business_encryption`;

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;

      logger.warn('Failed to get Flow public key status', {
        phoneNumberId,
        status: response.status,
        error: errorMsg,
      });

      return {
        ok: false,
        error: errorMsg,
        status: null,
      };
    }

    const result = await response.json();

    logger.debug('Flow public key status retrieved', {
      phoneNumberId,
      signatureStatus: result.business_public_key_signature_status,
    });

    return {
      ok: true,
      status: result.business_public_key_signature_status,
    };
  } catch (err) {
    logger.error('Error getting Flow public key status', {
      phoneNumberId,
      error: err.message,
    });

    return {
      ok: false,
      error: err.message,
      status: null,
    };
  }
}

module.exports = {
  generateFlowKeyPair,
  registerFlowPublicKey,
  getFlowPublicKeyStatus,
};
