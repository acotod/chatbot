'use strict';
/**
 * Socket.io service.
 * Call socketService.init(httpServer) once, then use socketService.emit()
 * from anywhere in the app.
 */
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const logger = require('../utils/logger');

let _io = null;

function init(httpServer) {
  _io = new Server(httpServer, {
    cors: {
      origin: process.env.ADMIN_ORIGIN || '*',
      methods: ['GET', 'POST'],
    },
  });

  // ── JWT auth on every socket connection ──────────────────────────────────
  _io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const secret = process.env.JWT_SECRET;

    if (!secret) return next(new Error('JWT not configured'));
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, secret);
      socket.data.adminPayload = payload;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  _io.on('connection', (socket) => {
    const { tenantId } = socket.handshake.query;
    const payload = socket.data.adminPayload ?? {};

    if (tenantId) {
      // superAdmin (env-var legacy) or DB-backed superAdmin can join any room.
      // Tenant-scoped admins may only join their own tenant room.
      const isSuperAdmin =
        (payload.sub === 'admin' && !payload.adminUserId) || payload.superAdmin === true;
      const allowedTenantId = isSuperAdmin ? tenantId : (payload.tenantId ?? null);

      if (allowedTenantId !== tenantId) {
        logger.warn({ socketId: socket.id, tenantId, allowedTenantId }, 'socket tenant mismatch — disconnecting');
        socket.disconnect(true);
        return;
      }

      socket.join(`tenant:${tenantId}`);
      logger.info({ socketId: socket.id, tenantId }, 'socket joined tenant room');
    }

    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'socket disconnected');
    });
  });

  logger.info('socket.io initialized');
  return _io;
}

/**
 * Emit an event to all sockets in a tenant room (or globally).
 * @param {string|null} tenantId  - target tenant room; null = broadcast all
 * @param {string}      event     - event name
 * @param {*}           data
 */
function emit(tenantId, event, data) {
  if (!_io) return;
  const room = tenantId ? `tenant:${tenantId}` : null;
  if (room) {
    _io.to(room).emit(event, data);
  } else {
    _io.emit(event, data);
  }
}

function getIo() {
  return _io;
}

module.exports = { init, emit, getIo };
