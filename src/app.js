require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
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
const correlationId = require('./middleware/correlationId');

const app = express();

// Security headers (allow cross-origin resource embedding for public uploaded assets)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS — restrict to whitelisted origins
const defaultAllowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

const configuredAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins = configuredAllowedOrigins.length > 0
  ? configuredAllowedOrigins
  : defaultAllowedOrigins;

const corsOptions = {
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({
  verify: (_req, _res, buf) => {
    _req.rawBody = buf;
  },
}));

// Correlation ID — must run before routes
app.use(correlationId);

// Health check (no auth required)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Serve uploaded files (logos, etc.)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), {
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

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
