const express = require('express');
const logger = require('../utils/logger');
const { webhookValidationRules, validate } = require('../middleware/validate');
const { getNextScreen } = require('../services/flowNavigation');
const db = require('../services/database');

const router = express.Router();

router.post('/', webhookValidationRules, validate, async (req, res, next) => {
  const { screen, data } = req.body;
  const tenantId = req.tenant.id;

  logger.info('Incoming webhook request', { tenantId, method: req.method, path: req.path, body: req.body });

  try {
    // Resolve user if phone provided
    let userId = null;
    if (data.phone) {
      const user = await db.findOrCreateUser(data.phone, tenantId);
      userId = user ? user.id : null;
    }

    // Persist the flow event
    await db.saveEvent(userId, screen, data, tenantId);

    // Persist solicitud when applicable
    if (screen === 'SOLICITUD_ESPACIO') {
      await db.saveSolicitud(userId, data, tenantId);
    }

    // Load tenant flow config (dynamic engine), fallback to default
    const flowConfig = await db.getConfig(tenantId, 'flow_navigation');
    const navigationOverride = flowConfig ? flowConfig.valor : null;

    // Navigate to the next screen
    const nextScreen = getNextScreen(screen, data, navigationOverride);
    if (nextScreen === null) {
      logger.warn('Navigation failed: unknown screen or option', { tenantId, screen, data });
      return res.status(400).json({ error: `Unknown screen or option for screen: ${screen}` });
    }

    logger.info('Navigation decision', { tenantId, from: screen, to: nextScreen });
    return res.json({ screen: nextScreen });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
