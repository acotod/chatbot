'use strict';
/**
 * Async audit service — never blocks the request.
 * All writes are fire-and-forget via setImmediate.
 */
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * @param {object} opts
 * @param {string|null}  opts.tenantId
 * @param {number|null}  opts.adminUserId
 * @param {string}       opts.accion      e.g. "UPDATE_SOLICITUD_ESTADO"
 * @param {string}       opts.entidad     e.g. "solicitud"
 * @param {string|null}  opts.entidadId
 * @param {string|null}  opts.ip          request IP address
 * @param {string|null}  opts.userAgent   request User-Agent
 * @param {object|null}  opts.metadata    free-form JSON
 */
function audit(opts) {
  setImmediate(async () => {
    try {
      await prisma.auditLog.create({
        data: {
          tenantId:    opts.tenantId    ?? null,
          adminUserId: opts.adminUserId ?? null,
          accion:      opts.accion,
          entidad:     opts.entidad,
          entidadId:   opts.entidadId ? String(opts.entidadId) : null,
          ip:          opts.ip        ? String(opts.ip).substring(0, 45) : null,
          userAgent:   opts.userAgent ? String(opts.userAgent).substring(0, 500) : null,
          metadata:    opts.metadata  ?? undefined,
        },
      });
    } catch (err) {
      logger.error({ err }, 'audit write failed');
    }
  });
}

module.exports = { audit };
