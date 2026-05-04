'use strict';

const express = require('express');
const { validateEventIngest } = require('../middleware/eventValidation');
const { ingestEvent } = require('../services/eventGateway');

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

module.exports = router;
