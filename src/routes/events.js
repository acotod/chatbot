'use strict';

const express = require('express');
const { validateEventIngest } = require('../middleware/eventValidation');
const { ingestEvent } = require('../services/eventGateway');
const convLogger = require('../engine/conversationLogger');

const router = express.Router();

router.post('/ingest', validateEventIngest, async (req, res, next) => {
  try {
    const result = await ingestEvent({
      tenantId: req.tenant.id,
      rawEvent: req.body,
      correlationId: req.correlationId,
      idempotencyKeyHeader: req.headers['x-idempotency-key'],
    });

    if (result.duplicate) {
      return res.status(200).json({
        ok: true,
        duplicate: true,
        eventId: result.eventLog.eventId,
      });
    }

    return res.status(202).json({
      ok: true,
      duplicate: false,
      eventId: result.normalized.eventId,
      queued: result.queued,
      queue: result.queueKey,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/save-conversation', async (req, res, next) => {
  try {
    const tenantId = req.tenant.id;
    const {
      userKey,
      flowId,
      flowVersionId = null,
      conversationId: providedConversationId = null,
      nodeRef = null,
      eventType = null,
      payload = {},
      context = null,
      status = null,
    } = req.body ?? {};

    const parsedFlowId = Number(flowId);
    if (!providedConversationId && (!userKey || Number.isNaN(parsedFlowId))) {
      return res.status(400).json({
        error: 'userKey and flowId are required when conversationId is not provided',
      });
    }

    const conversationId = providedConversationId || await convLogger.getOrCreate(
      tenantId,
      String(userKey),
      parsedFlowId,
      flowVersionId != null ? Number(flowVersionId) : null,
    );

    if (!conversationId) {
      return res.status(500).json({ error: 'No se pudo crear o resolver la conversación' });
    }

    if (context && typeof context === 'object' && !Array.isArray(context)) {
      await convLogger.updateContext(conversationId, context);
    }

    if (eventType) {
      await convLogger.log(conversationId, tenantId, nodeRef, eventType, payload && typeof payload === 'object' ? payload : { value: payload });
    }

    if (status) {
      await convLogger.end(conversationId, status, context && typeof context === 'object' ? context : {});
    }

    return res.json({
      ok: true,
      saved: true,
      conversationId,
      status: status ?? 'active',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
