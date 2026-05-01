const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

let prisma;

function getPrismaClient() {
  if (!prisma) {
    try {
      prisma = new PrismaClient();
    } catch (err) {
      logger.error('Failed to instantiate PrismaClient', { message: err.message });
      prisma = null;
    }
  }
  return prisma;
}

/**
 * Find an existing user by phone or create a new one.
 * @param {string} phone
 * @returns {Promise<object|null>}
 */
async function findOrCreateUser(phone) {
  const client = getPrismaClient();
  if (!client) return null;

  let user = await client.user.findFirst({ where: { phone } });
  if (!user) {
    user = await client.user.create({ data: { phone } });
  }
  return user;
}

/**
 * Save a flow event to eventos_flujo.
 * @param {number|null} userId
 * @param {string} screen
 * @param {object} data
 */
async function saveEvent(userId, screen, data) {
  const client = getPrismaClient();
  if (!client) return null;

  return client.eventoFlujo.create({
    data: { userId: userId || null, screen, data },
  });
}

/**
 * Save a solicitud record with estado='pendiente'.
 * @param {number|null} userId
 * @param {object} data
 */
async function saveSolicitud(userId, data) {
  const client = getPrismaClient();
  if (!client) return null;

  return client.solicitud.create({
    data: {
      userId: userId || null,
      nombre: data.nombre || null,
      telefonoContacto: data.telefono_contacto || null,
      horario: data.horario || null,
      estado: 'pendiente',
    },
  });
}

module.exports = { findOrCreateUser, saveEvent, saveSolicitud, getPrismaClient };
