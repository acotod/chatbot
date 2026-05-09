'use strict';

const crypto = require('crypto');

/**
 * Generate a device fingerprint from request data
 * Combines User-Agent and IP to create a stable device identifier
 * @param {string} userAgent - Request User-Agent header
 * @param {string} ipAddress - Request IP address
 * @returns {string} SHA256 fingerprint
 */
function generateDeviceFingerprint(userAgent = '', ipAddress = '') {
  const combined = `${userAgent}|${ipAddress}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Extract device name from User-Agent
 * @param {string} userAgent - Request User-Agent header
 * @returns {string} Device name (browser/OS)
 */
function parseDeviceNameFromUserAgent(userAgent = '') {
  if (!userAgent) return 'Unknown Device';

  // Simple parsing - can be enhanced with ua-parser-js if needed
  if (userAgent.includes('Chrome')) return 'Chrome Browser';
  if (userAgent.includes('Safari')) return 'Safari Browser';
  if (userAgent.includes('Firefox')) return 'Firefox Browser';
  if (userAgent.includes('Edge')) return 'Edge Browser';
  if (userAgent.includes('Mobile')) return 'Mobile Device';
  if (userAgent.includes('Tablet')) return 'Tablet Device';

  return 'Other Device';
}

module.exports = {
  generateDeviceFingerprint,
  parseDeviceNameFromUserAgent,
};
