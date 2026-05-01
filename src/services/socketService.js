'use strict';
/**
 * Socket.io service.
 * Call socketService.init(httpServer) once, then use socketService.emit()
 * from anywhere in the app.
 */
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

  _io.on('connection', (socket) => {
    const { tenantId } = socket.handshake.query;
    if (tenantId) {
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
