require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const webhookRouter = require('./routes/webhook');
const adminRouter = require('./routes/admin');
const authRouter = require('./routes/auth');
const deviceSessionsRouter = require('./routes/deviceSessions');
const rbacRouter = require('./routes/rbac');
const auditRouter = require('./routes/auditLogs');
const whatsappRouter = require('./routes/whatsapp');
const eventsRouter = require('./routes/events');
const conversationsRouter = require('./routes/conversations');
const notificationsRouter  = require('./routes/notifications');
const calendarRouter       = require('./routes/calendar');
const integrationsRouter   = require('./routes/integrations');
const sandboxRouter        = require('./routes/sandbox');
const variablesRouter      = require('./routes/variables');
const flowsRouter          = require('./routes/flows');
const wabaFlowsRouter      = require('./routes/waba-flows');
const crmRouter            = require('./routes/crm');
const portalRouter         = require('./routes/portal');
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

function expandLoopbackOriginAliases(origins) {
  const expanded = new Set(origins);

  for (const origin of origins) {
    try {
      const u = new URL(origin);
      if (u.hostname === 'localhost') {
        expanded.add(`${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ''}`);
      } else if (u.hostname === '127.0.0.1') {
        expanded.add(`${u.protocol}//localhost${u.port ? `:${u.port}` : ''}`);
      }
    } catch {
      // Ignore malformed configured origins and keep startup resilient.
    }
  }

  return [...expanded];
}

const allowedOrigins = configuredAllowedOrigins.length > 0
  ? expandLoopbackOriginAliases(configuredAllowedOrigins)
  : defaultAllowedOrigins;

const corsOptions = {
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-correlation-id', 'x-idempotency-key', 'x-tab-id'],
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

// Device Sessions & MFA management (auth required)
app.use('/device-sessions', deviceSessionsRouter);

// Per-tenant rate limiter (applied only to the webhook)
const tenantRateLimiter = createRateLimiter();

// POST /webhook — tenant identified by x-api-key header
app.use('/webhook', resolveTenant, tenantRateLimiter, webhookRouter);

// POST /events/ingest — canonical Unified Event Gateway ingest endpoint
app.use('/events', resolveTenant, tenantRateLimiter, eventsRouter);

// Internal endpoints exposed to the integration runner via x-api-key
app.use('/api/notifications', resolveTenant, tenantRateLimiter, notificationsRouter);

// Admin routes (protected by JWT — POST /auth/login to get a token)
app.use('/admin', adminRouter);

// Conversation event-sourcing routes (protected by JWT)
app.use('/conversations', conversationsRouter);
app.use('/calendar',       calendarRouter);

// RBAC routes (roles, permisos, admin users)
app.use('/rbac', rbacRouter);

// Audit logs
app.use('/audit', auditRouter);

// WhatsApp Business Cloud API (GET: verify, POST: incoming messages + /send)
app.use('/whatsapp', whatsappRouter);

// Flow management (JWT-protected)
app.use('/flows', flowsRouter);
app.use('/integrations', integrationsRouter);
app.use('/sandbox', sandboxRouter);
app.use('/variables', variablesRouter);
app.use('/waba-flows', wabaFlowsRouter);
app.use('/crm', crmRouter);

// Customer portal (token-based access, no admin JWT required)
app.use('/portal', portalRouter);

app.use(errorHandler);

module.exports = app;
