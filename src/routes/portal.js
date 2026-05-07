'use strict';

const express = require('express');
const db = require('../services/database');
const { verifyPortalToken } = require('../services/portalAccess');

const router = express.Router();

async function resolvePortalAccess(req, res, next) {
  try {
    const token = req.params.token;
    if (!token) return res.status(401).json({ error: 'Portal token required' });

    const payload = verifyPortalToken(token);
    const tenantId = payload.tenantId;
    if (!tenantId) return res.status(401).json({ error: 'Invalid portal token' });

    const config = await db.getSolicitudesEnterpriseConfig(tenantId);
    if (!config.customerPortalEnabled) {
      return res.status(403).json({ error: 'Customer portal disabled for this tenant' });
    }

    req.portal = {
      tenantId,
      userId: payload.userId ?? null,
      solicitudId: payload.solicitudId ?? null,
      config,
    };

    next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired portal token' });
  }
}

// GET /portal/:token/solicitudes
router.get('/:token/solicitudes', resolvePortalAccess, async (req, res, next) => {
  try {
    const { tenantId, userId, solicitudId } = req.portal;

    if (userId) {
      const data = await db.listSolicitudes(tenantId, { userId, page: 1, limit: 100 });
      return res.json({ data });
    }

    if (solicitudId) {
      const single = await db.getSolicitudDetalle(Number(solicitudId), tenantId);
      if (!single) return res.json({ data: [] });
      return res.json({ data: [single] });
    }

    return res.json({ data: [] });
  } catch (err) {
    next(err);
  }
});

// GET /portal/:token/solicitudes/:id
router.get('/:token/solicitudes/:id', resolvePortalAccess, async (req, res, next) => {
  try {
    const solicitudId = Number(req.params.id);
    const { tenantId, userId, solicitudId: tokenSolicitudId } = req.portal;

    const solicitud = await db.getSolicitudDetalle(solicitudId, tenantId);
    if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });

    const isAllowed = (tokenSolicitudId && Number(tokenSolicitudId) === solicitudId)
      || (userId && solicitud.userId && Number(solicitud.userId) === Number(userId));

    if (!isAllowed) {
      return res.status(403).json({ error: 'Solicitud not accessible with this token' });
    }

    return res.json(solicitud);
  } catch (err) {
    next(err);
  }
});

// POST /portal/:token/solicitudes/:id/comments
router.post('/:token/solicitudes/:id/comments', resolvePortalAccess, async (req, res, next) => {
  try {
    const solicitudId = Number(req.params.id);
    const { tenantId, userId, solicitudId: tokenSolicitudId } = req.portal;

    const solicitud = await db.getSolicitudById(solicitudId, tenantId);
    if (!solicitud) return res.status(404).json({ error: 'Solicitud not found' });

    const isAllowed = (tokenSolicitudId && Number(tokenSolicitudId) === solicitudId)
      || (userId && solicitud.userId && Number(solicitud.userId) === Number(userId));
    if (!isAllowed) {
      return res.status(403).json({ error: 'Solicitud not accessible with this token' });
    }

    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content is required' });

    const comment = await db.addSolicitudComment({
      solicitudId,
      tenantId,
      userId: null,
      content,
      visibility: 'customer',
      attachments: [],
    });

    return res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
