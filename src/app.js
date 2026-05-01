require('dotenv').config();
const express = require('express');
const webhookRouter = require('./routes/webhook');
const adminRouter = require('./routes/admin');
const resolveTenant = require('./middleware/resolveTenant');
const createRateLimiter = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(express.json());

// Per-tenant rate limiter (applied only to the webhook)
const tenantRateLimiter = createRateLimiter();

// POST /webhook — tenant identified by x-api-key header
app.use('/webhook', resolveTenant, tenantRateLimiter, webhookRouter);

// Admin routes (protected by ADMIN_API_KEY env var)
app.use('/admin', adminRouter);

app.use(errorHandler);

module.exports = app;
