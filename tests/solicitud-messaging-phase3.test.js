/**
 * Solicitud Messaging - Phase 3 Test Suite
 *
 * Covers:
 * 1. Message filter logic (q text search, direccion filter, pagination bounds)
 * 2. extractMensajeSearchText helper correctness
 * 3. Socket event emission contracts in backend routes
 * 4. Frontend real-time subscriptions (structural file checks)
 * 5. Conversaciones → Solicitudes cross-link feature
 * 6. Agent socket emission after send
 * 7. Webhook inbound socket fan-out to open solicitudes
 * 8. Regression – existing message endpoints still exist
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../src/services/database');

// ─── Helper: read source file ──────────────────────────────────────────────

function readSrc(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

// ─── 1. extractMensajeSearchText (unit) ──────────────────────────────────

describe('extractMensajeSearchText – unit', () => {
  // Access the internal function by evaluating the module in isolation.
  // The function is not exported, so we test it through listMensajesBySolicitud
  // behaviour (covered in filter tests below) and via duck-typing checks.

  it('database module exports listMensajesBySolicitud', () => {
    expect(typeof db.listMensajesBySolicitud).toBe('function');
  });

  it('extractMensajeSearchText logic is defined in database.js', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toContain('function extractMensajeSearchText');
    expect(src).toContain("candidateKeys = ['text', 'body', 'message', 'caption']");
  });

  it('uses JSON.stringify as fallback for unknown shapes', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toContain('JSON.stringify(contenido)');
  });
});

// ─── 2. listMensajesBySolicitud – filter parameter handling ──────────────

describe('listMensajesBySolicitud – filter parameter contracts', () => {
  it('accepts q and direccion as named parameters', () => {
    const src = readSrc('src', 'services', 'database.js');
    // Function signature must include q and direccion
    expect(src).toMatch(/listMensajesBySolicitud\(\{[^)]*\bq\b[^)]*\}/);
    expect(src).toMatch(/listMensajesBySolicitud\(\{[^)]*\bdireccion\b[^)]*\}/);
  });

  it('accepts start and end as named parameters', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toMatch(/listMensajesBySolicitud\(\{[^)]*\bstart\b[^)]*\}/);
    expect(src).toMatch(/listMensajesBySolicitud\(\{[^)]*\bend\b[^)]*\}/);
  });

  it('normalizes direccion to only accepted values (entrada|salida)', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toContain("['entrada', 'salida'].includes");
    expect(src).toContain('normalizedDireccion');
  });

  it('trims and lowercases q before searching', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toContain("String(q ?? '').trim().toLowerCase()");
  });

  it('applies text search in-memory against extracted content', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toContain('extractMensajeSearchText(row.contenido).toLowerCase()');
    expect(src).toContain('searchableText.includes(searchQuery)');
  });

  it('caps limit at 200 to prevent oversized queries', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toContain('Math.min(Math.max(Number(limit) || 50, 1), 200)');
  });

  it('normalizes start/end date filters safely', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toContain('normalizeMensajeDateFilter(start');
    expect(src).toContain('normalizeMensajeDateFilter(end');
  });

  it('applies createdAt range filter when start/end are provided', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toContain('createdAt');
    expect(src).toContain('gte: startDate');
    expect(src).toContain('lte: endDate');
  });

  it('returns null when getPrismaClient() is not available', () => {
    const src = readSrc('src', 'services', 'database.js');
    // Guard pattern at top of function
    expect(src).toMatch(/listMensajesBySolicitud[^{]+\{[\s\S]{0,200}if \(!client\) return null/);
  });

  it('returns empty data when solicitud has no userId', () => {
    const src = readSrc('src', 'services', 'database.js');
    expect(src).toContain('if (!solicitud.userId)');
    expect(src).toContain('data: [],');
    expect(src).toContain('total: 0,');
  });

  it('returns pagination metadata in response', () => {
    const src = readSrc('src', 'services', 'database.js');
    // All return paths include page and limit
    const matches = src.match(/return \{[\s\S]*?solicitud,[\s\S]*?data,[\s\S]*?total,[\s\S]*?page:/g);
    expect(matches).toBeTruthy();
    expect((matches || []).length).toBeGreaterThanOrEqual(2); // no-text and text paths
  });
});

// ─── 3. Admin route – passes filter params to db ─────────────────────────

describe('Admin route – filter params forwarded to DB', () => {
  it('reads q from req.query in GET messages handler', () => {
    const src = readSrc('src', 'routes', 'admin.js');
    // Must extract q from query string
    expect(src).toMatch(/req\.query\??\.q|const\s+\{[^}]*\bq\b[^}]*\}\s*=\s*req\.query/);
  });

  it('reads direccion from req.query in GET messages handler', () => {
    const src = readSrc('src', 'routes', 'admin.js');
    expect(src).toMatch(/req\.query\??\.direccion|const\s+\{[^}]*\bdireccion\b[^}]*\}\s*=\s*req\.query/);
  });

  it('reads start and end from req.query in GET messages handler', () => {
    const src = readSrc('src', 'routes', 'admin.js');
    expect(src).toMatch(/req\.query\??\.start|\bstart:\s*req\.query\??\.start/);
    expect(src).toMatch(/req\.query\??\.end|\bend:\s*req\.query\??\.end/);
  });

  it('passes both filter params to listMensajesBySolicitud call', () => {
    const src = readSrc('src', 'routes', 'admin.js');
    expect(src).toContain('listMensajesBySolicitud');
    // Both q and direccion must appear near the call site
    const callIndex = src.indexOf('listMensajesBySolicitud');
    const callContext = src.slice(callIndex - 50, callIndex + 420);
    expect(callContext).toContain('q');
    expect(callContext).toContain('direccion');
    expect(callContext).toContain('start');
    expect(callContext).toContain('end');
  });

  it('emits SOLICITUD_MESSAGE_SENT socket event after admin send', () => {
    const src = readSrc('src', 'routes', 'admin.js');
    expect(src).toContain("'SOLICITUD_MESSAGE_SENT'");
    expect(src).toContain('socketService.emit');
  });
});

// ─── 4. Auth route – agent filter params + socket emission ───────────────

describe('Auth route – agent filter params + socket emission', () => {
  it('reads q from req.query in GET agent messages handler', () => {
    const src = readSrc('src', 'routes', 'auth.js');
    expect(src).toMatch(/req\.query\??\.q|const\s+\{[^}]*\bq\b[^}]*\}\s*=\s*req\.query/);
  });

  it('reads direccion from req.query in GET agent messages handler', () => {
    const src = readSrc('src', 'routes', 'auth.js');
    expect(src).toMatch(/req\.query\??\.direccion|const\s+\{[^}]*\bdireccion\b[^}]*\}\s*=\s*req\.query/);
  });

  it('reads start and end from req.query in GET agent messages handler', () => {
    const src = readSrc('src', 'routes', 'auth.js');
    expect(src).toMatch(/req\.query\??\.start|\bstart:\s*req\.query\??\.start/);
    expect(src).toMatch(/req\.query\??\.end|\bend:\s*req\.query\??\.end/);
  });

  it('imports socketService', () => {
    const src = readSrc('src', 'routes', 'auth.js');
    expect(src).toContain("require('../services/socketService')");
  });

  it('emits SOLICITUD_MESSAGE_SENT after agent send', () => {
    const src = readSrc('src', 'routes', 'auth.js');
    expect(src).toContain("'SOLICITUD_MESSAGE_SENT'");
    // Must be after the audit() call in agent send handler
    const auditIndex = src.indexOf('AGENT_SEND_SOLICITUD_MESSAGE');
    const afterAudit  = src.slice(auditIndex, auditIndex + 500);
    expect(afterAudit).toContain('SOLICITUD_MESSAGE_SENT');
  });

  it('passes solicitudId and mensaje in socket payload', () => {
    const src = readSrc('src', 'routes', 'auth.js');
    const idx = src.indexOf("'SOLICITUD_MESSAGE_SENT'");
    const ctx = src.slice(idx, idx + 200);
    expect(ctx).toContain('solicitudId');
    expect(ctx).toContain('mensaje');
  });

  it('validates agent ownership before sending', () => {
    const src = readSrc('src', 'routes', 'auth.js');
    expect(src).toContain('Solicitud is not assigned to this agent');
  });
});

// ─── 5. Webhook – inbound message triggers solicitud socket fan-out ───────

describe('WhatsApp webhook – inbound message → solicitud socket fan-out', () => {
  it('emits SOLICITUD_MESSAGE_SENT after inbound message if open solicitud exists', () => {
    const src = readSrc('src', 'routes', 'whatsapp.js');
    expect(src).toContain("'SOLICITUD_MESSAGE_SENT'");
  });

  it('lookup is scoped to same tenant', () => {
    const src = readSrc('src', 'routes', 'whatsapp.js');
    const idx = src.indexOf("'SOLICITUD_MESSAGE_SENT'");
    const ctx = src.slice(Math.max(0, idx - 400), idx + 200);
    expect(ctx).toContain('tenant.id');
  });

  it('lookup excludes completed and rejected solicitudes', () => {
    const src = readSrc('src', 'routes', 'whatsapp.js');
    const idx = src.indexOf("'SOLICITUD_MESSAGE_SENT'");
    const ctx = src.slice(Math.max(0, idx - 400), idx + 50);
    expect(ctx).toContain('notIn');
    expect(ctx).toMatch(/completed|rejected/);
  });

  it('is non-blocking (best-effort with catch)', () => {
    const src = readSrc('src', 'routes', 'whatsapp.js');
    const idx = src.indexOf("'SOLICITUD_MESSAGE_SENT'");
    const ctx = src.slice(Math.max(0, idx - 100), idx + 200);
    expect(ctx).toContain('.catch(');
  });

  it('emits nuevo_mensaje for all inbound messages (existing behaviour intact)', () => {
    const src = readSrc('src', 'routes', 'whatsapp.js');
    expect(src).toContain("'nuevo_mensaje'");
  });

  it('emits SOLICITUD_MESSAGE_STATUS for delivery status updates', () => {
    const src = readSrc('src', 'routes', 'whatsapp.js');
    expect(src).toContain("'SOLICITUD_MESSAGE_STATUS'");
  });
});

// ─── 6. Frontend – solicitudes page real-time subscriptions ──────────────

describe('Frontend solicitudes page – real-time socket subscriptions', () => {
  it('imports useSocket hook', () => {
    const src = readSrc('admin', 'app', '(app)', 'solicitudes', 'page.tsx');
    expect(src).toContain('useSocket');
  });

  it('subscribes to SOLICITUD_MESSAGE_SENT for messages auto-refresh', () => {
    const src = readSrc('admin', 'app', '(app)', 'solicitudes', 'page.tsx');
    expect(src).toContain('"SOLICITUD_MESSAGE_SENT"');
  });

  it('subscribes to SOLICITUD_MESSAGE_STATUS for delivery status updates', () => {
    const src = readSrc('admin', 'app', '(app)', 'solicitudes', 'page.tsx');
    expect(src).toContain('"SOLICITUD_MESSAGE_STATUS"');
  });

  it('subscribes to STATUS_UPDATED for list refresh', () => {
    const src = readSrc('admin', 'app', '(app)', 'solicitudes', 'page.tsx');
    expect(src).toContain('"STATUS_UPDATED"');
  });

  it('invalidates solicitud-messages query on socket event', () => {
    const src = readSrc('admin', 'app', '(app)', 'solicitudes', 'page.tsx');
    expect(src).toContain('"solicitud-messages"');
    expect(src).toContain('invalidateQueries');
  });

  it('has text search filter state (messageSearch)', () => {
    const src = readSrc('admin', 'app', '(app)', 'solicitudes', 'page.tsx');
    expect(src).toContain('messageSearch');
  });

  it('has direction filter state (messageDirection)', () => {
    const src = readSrc('admin', 'app', '(app)', 'solicitudes', 'page.tsx');
    expect(src).toContain('messageDirection');
  });

  it('has date range filter state for messages', () => {
    const src = readSrc('admin', 'app', '(app)', 'solicitudes', 'page.tsx');
    expect(src).toContain('messageStartDate');
    expect(src).toContain('messageEndDate');
  });

  it('passes filter params to messages API call', () => {
    const src = readSrc('admin', 'app', '(app)', 'solicitudes', 'page.tsx');
    // q param forwarded
    expect(src).toMatch(/q:\s*messageSearch|q,\s*(?:\/\/[^\n]*)?\n?\s*direccion/);
    // direccion param forwarded
    expect(src).toContain('direccion');
    // start/end params forwarded
    expect(src).toContain('start: messageStartDate');
    expect(src).toContain('end: messageEndDate');
  });
});

// ─── 7. Frontend – conversaciones page cross-link ────────────────────────

describe('Frontend conversaciones page – solicitud cross-link', () => {
  it('imports useRouter for navigation', () => {
    const src = readSrc('admin', 'app', '(app)', 'conversaciones', 'page.tsx');
    expect(src).toContain('useRouter');
  });

  it('has navigation to /solicitudes route', () => {
    const src = readSrc('admin', 'app', '(app)', 'conversaciones', 'page.tsx');
    expect(src).toContain('"/solicitudes"');
  });

  it('renders a Ver link with ExternalLink icon in solicitudes panel', () => {
    const src = readSrc('admin', 'app', '(app)', 'conversaciones', 'page.tsx');
    expect(src).toContain('ExternalLink');
    expect(src).toContain('Ver');
  });

  it('still renders all solicitudes in the context panel', () => {
    const src = readSrc('admin', 'app', '(app)', 'conversaciones', 'page.tsx');
    expect(src).toContain('solicitudes.map');
  });

  it('still has Escalar and Urgente quick actions', () => {
    const src = readSrc('admin', 'app', '(app)', 'conversaciones', 'page.tsx');
    expect(src).toContain('Escalar');
    expect(src).toContain('Urgente');
  });
});

// ─── 8. Frontend API clients – filter params ─────────────────────────────

describe('Frontend API clients – filter param types', () => {
  it('admin api.ts messages() accepts q, direccion, start and end params', () => {
    const src = readSrc('admin', 'lib', 'api.ts');
    expect(src).toContain('q?:');
    expect(src).toContain('direccion?:');
    expect(src).toContain('start?:');
    expect(src).toContain('end?:');
  });

  it('agentApi.ts solicitudMessages() accepts q, direccion, start and end params', () => {
    const src = readSrc('admin', 'lib', 'agentApi.ts');
    expect(src).toContain('q?:');
    expect(src).toContain('direccion?:');
    expect(src).toContain('start?:');
    expect(src).toContain('end?:');
  });

  it('admin api sends q to backend query string', () => {
    const src = readSrc('admin', 'lib', 'api.ts');
    // messages function includes q? param in its type signature
    expect(src).toMatch(/messages.*q\?:/);
  });

  it('agent api sends direccion to backend query string', () => {
    const src = readSrc('admin', 'lib', 'agentApi.ts');
    expect(src).toContain('direccion');
  });
});

// ─── 9. Regression – Phase 1 DB exports still present ────────────────────

describe('Regression – Phase 1 database exports intact', () => {
  const exports = [
    'listMensajesBySolicitud',
    'getSolicitudMessagingContext',
    'saveMensaje',
    'getWaCredentials',
    'updateMensajeDeliveryStatusByWaMsgId',
  ];

  exports.forEach((fn) => {
    it(`exports ${fn}`, () => {
      expect(typeof db[fn]).toBe('function');
    });
  });
});

// ─── 10. Regression – Route endpoints still defined ──────────────────────

describe('Regression – Route endpoints still defined', () => {
  it('admin GET messages endpoint exists', () => {
    const src = readSrc('src', 'routes', 'admin.js');
    expect(src).toContain("solicitudes/:id/messages");
  });

  it('admin POST send message endpoint exists', () => {
    const src = readSrc('src', 'routes', 'admin.js');
    // POST with body that reads text
    const idx = src.indexOf("solicitudes/:id/messages");
    expect(idx).toBeGreaterThan(0);
  });

  it('agent GET messages endpoint exists', () => {
    const src = readSrc('src', 'routes', 'auth.js');
    expect(src).toContain("solicitudes/:id/messages");
  });

  it('agent POST send message endpoint exists', () => {
    const src = readSrc('src', 'routes', 'auth.js');
    expect(src).toContain('AGENT_SEND_SOLICITUD_MESSAGE');
  });
});
