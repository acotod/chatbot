'use strict';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch (_err) {
    return '';
  }
}

function wrapEmail(content) {
  return [
    '<!doctype html>',
    '<html><body style="margin:0;background:#f4f7f9;color:#0d2b3e;font-family:Arial,sans-serif">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7f9;padding:24px 12px">',
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #dce4e8">',
    '<tr><td style="padding:20px 24px;border-bottom:3px solid #00bfae;font-size:18px;font-weight:700">Chatbot</td></tr>',
    `<tr><td style="padding:24px;line-height:1.6;font-size:15px">${content}</td></tr>`,
    '<tr><td style="padding:16px 24px;border-top:1px solid #e6ecef;color:#5b6670;font-size:12px">Mensaje automático. No respondas a este correo.</td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
}

function createPasswordResetEmail({ agenteNombre, tenantNombre, resetUrl, expiresAt }) {
  const name = String(agenteNombre || 'agente').trim();
  const company = String(tenantNombre || 'tu empresa').trim();
  const expiry = expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt || '');
  const safeUrl = safeHttpUrl(resetUrl);
  const htmlLink = safeUrl
    ? `<p><a href="${escapeHtml(safeUrl)}" style="display:inline-block;background:#00bfae;color:#0d2b3e;padding:10px 16px;text-decoration:none;font-weight:700">Abrir enlace de recuperación</a></p>`
    : '<p>Solicita un nuevo enlace de recuperación desde el portal.</p>';

  return {
    subject: `Recuperación de acceso para ${company}`.replace(/[\r\n]+/g, ' '),
    text: [
      `Hola ${name},`,
      '',
      `Recibimos una solicitud para restablecer tu contraseña de acceso a ${company}.`,
      safeUrl ? `Usa este enlace: ${safeUrl}` : 'Solicita un nuevo enlace de recuperación desde el portal.',
      `Este enlace vence el ${expiry}.`,
      '',
      'Si no solicitaste este cambio, ignora este mensaje.',
    ].join('\n'),
    html: wrapEmail([
      `<p>Hola ${escapeHtml(name)},</p>`,
      `<p>Recibimos una solicitud para restablecer tu contraseña de acceso a ${escapeHtml(company)}.</p>`,
      htmlLink,
      `<p>Este enlace vence el <strong>${escapeHtml(expiry)}</strong>.</p>`,
      '<p>Si no solicitaste este cambio, ignora este mensaje.</p>',
    ].join('')),
  };
}

function createAssignmentEmail({ solicitudId, agenteNombre, tenantNombre, loginUrl }) {
  const name = String(agenteNombre || 'agente').trim();
  const company = String(tenantNombre || 'tu empresa').trim();
  const safeUrl = safeHttpUrl(loginUrl);

  return {
    subject: `Se te asignó la solicitud #${solicitudId}`.replace(/[\r\n]+/g, ' '),
    text: [
      `Hola ${name}, se te asignó la solicitud #${solicitudId} en ${company}.`,
      'Ingresa al portal para revisar la solicitud y responder:',
      safeUrl,
    ].join('\n'),
    html: wrapEmail([
      `<p>Hola ${escapeHtml(name)},</p>`,
      `<p>Se te asignó la solicitud <strong>#${escapeHtml(solicitudId)}</strong> en ${escapeHtml(company)}.</p>`,
      safeUrl
        ? `<p><a href="${escapeHtml(safeUrl)}">Abrir el portal de solicitudes</a></p>`
        : '<p>Ingresa al portal para revisar la solicitud y responder.</p>',
    ].join('')),
  };
}

function createInternalForwardEmail({ solicitudId, userName, phone, message }) {
  const safeName = String(userName || '').trim();
  const safePhone = String(phone || '').trim();
  const safeMessage = String(message || '');
  const rows = [
    '<p>Se registró un nuevo mensaje de cliente en tu solicitud asignada.</p>',
    `<p><strong>Solicitud ID:</strong> ${escapeHtml(solicitudId)}</p>`,
    safeName ? `<p><strong>Cliente:</strong> ${escapeHtml(safeName)}</p>` : '',
    `<p><strong>Teléfono del cliente:</strong> ${escapeHtml(safePhone)}</p>`,
    `<p><strong>Mensaje del cliente:</strong></p><blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #00bfae">${escapeHtml(safeMessage).replace(/\r?\n/g, '<br>')}</blockquote>`,
    '<p>Canal: chat interno de agente + notificación por correo.</p>',
  ].filter(Boolean);

  return {
    subject: `Nuevo mensaje en solicitud #${solicitudId}`.replace(/[\r\n]+/g, ' '),
    text: [
      'Se registró un nuevo mensaje de cliente en tu solicitud asignada.',
      `Solicitud ID: ${solicitudId}`,
      safeName ? `Cliente: ${safeName}` : '',
      `Teléfono cliente: ${safePhone}`,
      `Mensaje cliente: ${safeMessage}`,
      'Canal: chat interno de agente + notificación por correo.',
    ].filter(Boolean).join('\n'),
    html: wrapEmail(rows.join('')),
  };
}

module.exports = {
  escapeHtml,
  createPasswordResetEmail,
  createAssignmentEmail,
  createInternalForwardEmail,
};
