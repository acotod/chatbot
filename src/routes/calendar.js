'use strict';

const express       = require('express');
const { PrismaClient } = require('@prisma/client');
const requireJwt    = require('../middleware/requireJwt');
const resolveTenant = require('../middleware/resolveTenant');
const calendarSvc   = require('../services/calendarService');

const prisma  = new PrismaClient();
const router  = express.Router();

router.use(requireJwt);
router.use(resolveTenant);

// ─── Calendars ────────────────────────────────────────────────────────────────

/**
 * GET /calendar
 * List all calendars for the tenant.
 */
router.get('/', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const calendars = await prisma.calendar.findMany({
      where  : { tenantId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ calendars });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /calendar
 * Create a new calendar.
 * Body: { name, agentId?, config }
 */
router.post('/', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const { name, agentId, config } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const calendar = await prisma.calendar.create({
      data: { tenantId, name, agentId: agentId ?? null, config: config ?? {} },
    });
    res.status(201).json({ calendar });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /calendar/:id
 * Get a single calendar.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const calendar = await prisma.calendar.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });
    res.json({ calendar });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /calendar/:id
 * Update a calendar (name, config, isActive).
 */
router.put('/:id', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const { name, config, isActive } = req.body;
    const existing = await prisma.calendar.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) return res.status(404).json({ error: 'Calendar not found' });

    const updated = await prisma.calendar.update({
      where: { id: req.params.id },
      data : {
        ...(name     !== undefined ? { name }     : {}),
        ...(config   !== undefined ? { config }   : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });
    res.json({ calendar: updated });
  } catch (err) {
    next(err);
  }
});

// ─── Slots ────────────────────────────────────────────────────────────────────

/**
 * GET /calendar/:id/slots
 * Get available slots (optionally: ?days=7)
 */
router.get('/:id/slots', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const calendar = await prisma.calendar.findFirst({ where: { id: req.params.id, tenantId } });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const days  = Math.min(parseInt(req.query.days, 10) || 5, 60);
    const slots = await calendarSvc.getAvailableSlots(req.params.id, days);
    res.json({ slots });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /calendar/:id/generate-slots
 * Manually trigger slot generation.
 * Body: { days? }
 */
router.post('/:id/generate-slots', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const calendar = await prisma.calendar.findFirst({ where: { id: req.params.id, tenantId } });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const days    = Math.min(parseInt(req.body.days, 10) || 14, 60);
    const created = await calendarSvc.generateSlots(req.params.id, days);
    res.json({ generated: created });
  } catch (err) {
    next(err);
  }
});

// ─── Appointments ─────────────────────────────────────────────────────────────

/**
 * GET /calendar/appointments
 * List appointments for the tenant.
 * Query: status, calendarId, from, to, userKey, page, limit
 */
router.get('/appointments', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const { status, calendarId, from, to, userKey } = req.query;
    const page  = Math.max(parseInt(req.query.page,  10) || 1,  1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const where = { tenantId };
    if (status)     where.status     = status;
    if (calendarId) where.calendarId = calendarId;
    if (userKey)    where.userKey    = userKey;
    if (from || to) {
      where.startTime = {};
      if (from) where.startTime.gte = new Date(from);
      if (to)   where.startTime.lte = new Date(to);
    }

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        include : { calendar: { select: { id: true, name: true } } },
        orderBy : { startTime: 'asc' },
        skip    : (page - 1) * limit,
        take    : limit,
      }),
      prisma.appointment.count({ where }),
    ]);

    res.json({ appointments, total, page, limit });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /calendar/appointments/:id
 * Single appointment.
 */
router.get('/appointments/:id', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const appointment = await calendarSvc.getAppointment(req.params.id, tenantId);
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /calendar/appointments/:id/cancel
 * Cancel an appointment.
 */
router.post('/appointments/:id/cancel', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const result = await calendarSvc.cancelAppointment(req.params.id, tenantId);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /calendar/appointments/:id/reschedule
 * Reschedule an appointment.
 * Body: { newSlotId }
 */
router.post('/appointments/:id/reschedule', async (req, res, next) => {
  try {
    const { tenantId } = req;
    const { newSlotId } = req.body;
    if (!newSlotId) return res.status(400).json({ error: 'newSlotId is required' });

    const result = await calendarSvc.rescheduleAppointment(req.params.id, newSlotId, tenantId);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ appointment: result.appointment });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
