'use strict';

const express = require('express');
const { sendEmail, EmailServiceError } = require('../services/emailService');

const router = express.Router();

router.post('/send', async (req, res, next) => {
  try {
    const canal = String(req.body?.canal ?? 'email').trim().toLowerCase();
    if (canal !== 'email') {
      return res.status(400).json({ error: 'Only canal=email is supported at the moment' });
    }

    const to = String(
      req.body?.to
      ?? req.body?.email
      ?? req.body?.destinatario
      ?? req.body?.recipient
      ?? ''
    ).trim();
    const subject = String(req.body?.subject ?? req.body?.asunto ?? 'Notificacion').trim();
    const text = String(req.body?.message ?? req.body?.mensaje ?? req.body?.text ?? '').trim();
    const htmlRaw = req.body?.html;
    const html = typeof htmlRaw === 'string' ? htmlRaw.trim() : '';
    const replyTo = String(req.body?.replyTo ?? '').trim() || undefined;
    const from = String(req.body?.from ?? '').trim() || undefined;

    if (!to) {
      return res.status(400).json({ error: 'to is required for email notifications' });
    }
    if (!subject) {
      return res.status(400).json({ error: 'subject is required for email notifications' });
    }
    if (!text && !html) {
      return res.status(400).json({ error: 'message or html is required for email notifications' });
    }

    const delivery = await sendEmail({
      to,
      subject,
      text: text || undefined,
      html: html || undefined,
      from,
      replyTo,
      tenantId: req.tenant?.id ?? null,
      metadata: {
        route: 'api/notifications/send',
        canal,
        conversationId: req.body?.conversationId ?? null,
        clienteId: req.body?.clienteId ?? null,
      },
    });

    return res.json({
      enviado: true,
      notifId: delivery.messageId,
      accepted: delivery.accepted,
      rejected: delivery.rejected,
    });
  } catch (err) {
    if (err instanceof EmailServiceError) {
      const status = err.code === 'EMAIL_NOT_CONFIGURED' || err.code === 'EMAIL_FROM_NOT_CONFIGURED' ? 503 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    return next(err);
  }
});

module.exports = router;