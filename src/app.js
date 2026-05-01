require('dotenv').config();
const express = require('express');
const webhookRouter = require('./routes/webhook');
const adminRouter = require('./routes/admin');
const authRouter = require('./routes/auth');
const rbacRouter = require('./routes/rbac');
const auditRouter = require('./routes/auditLogs');
const flowsRouter = require('./routes/flows');
const whatsappRouter = require('./routes/whatsapp');
const resolveTenant = require('./middleware/resolveTenant');
const createRateLimiter = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(express.json());

// Health check (no auth required)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Auth (no auth required)
app.use('/auth', authRouter);

// Per-tenant rate limiter (applied only to the webhook)
const tenantRateLimiter = createRateLimiter();

// POST /webhook — tenant identified by x-api-key header
app.use('/webhook', resolveTenant, tenantRateLimiter, webhookRouter);

// Admin routes (protected by JWT — POST /auth/login to get a token)
app.use('/admin', adminRouter);

// RBAC routes (roles, permisos, admin users)
app.use('/rbac', rbacRouter);

// Audit logs
app.use('/audit', auditRouter);

// Flow management
app.use('/flows', flowsRouter);

// WhatsApp Business Cloud API (GET: verify, POST: incoming messages + /send)
app.use('/whatsapp', whatsappRouter);

app.use(errorHandler);

module.exports = app;
