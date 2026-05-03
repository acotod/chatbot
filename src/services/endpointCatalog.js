'use strict';
/**
 * Endpoint Catalog — dynamic registry of available API endpoints
 * that can be wired to webhook nodes in the Flow Builder.
 *
 * The catalog is stored per-tenant as a JSON config entry with key "flow_endpoints_catalog".
 * When no tenant-specific catalog is found, a built-in default catalog is returned.
 *
 * Catalog shape (stored in Configuracion.valor):
 * {
 *   "endpoints": [
 *     {
 *       "id":          "getClient",
 *       "name":        "Consultar Cliente",
 *       "method":      "POST",
 *       "url":         "/api/client",
 *       "inputs":      ["cedula"],
 *       "outputs":     ["nombre", "saldo", "estatus"],
 *       "description": "Consulta datos de cliente por cédula"
 *     }
 *   ]
 * }
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const CONFIG_KEY = 'flow_endpoints_catalog';

/** Built-in catalog served when no tenant catalog is configured */
const DEFAULT_CATALOG = {
  endpoints: [
    {
      id:          'validateUser',
      name:        'Validar Usuario',
      method:      'POST',
      url:         '/api/users/validate',
      inputs:      ['cedula', 'telefono'],
      outputs:     ['nombre', 'estatus', 'saldo'],
      description: 'Valida la identidad del usuario por cédula o teléfono',
    },
    {
      id:          'getAppointments',
      name:        'Consultar Citas',
      method:      'GET',
      url:         '/api/appointments',
      inputs:      ['userId', 'fecha'],
      outputs:     ['citas', 'total'],
      description: 'Obtiene citas disponibles para una fecha dada',
    },
    {
      id:          'createTicket',
      name:        'Crear Ticket de Soporte',
      method:      'POST',
      url:         '/api/tickets',
      inputs:      ['nombre', 'descripcion', 'prioridad'],
      outputs:     ['ticketId', 'estado', 'agente'],
      description: 'Crea un nuevo ticket de soporte',
    },
  ],
};

/**
 * Get the endpoint catalog for a tenant.
 * Falls back to DEFAULT_CATALOG if no config is found.
 * @param {string} tenantId
 * @returns {Promise<{ endpoints: object[] }>}
 */
async function getCatalog(tenantId) {
  if (!tenantId) return DEFAULT_CATALOG;

  try {
    const config = await prisma.configuracion.findFirst({
      where: { tenantId, clave: CONFIG_KEY },
    });
    if (config?.valor && Array.isArray(config.valor.endpoints)) {
      return config.valor;
    }
  } catch (err) {
    // Non-blocking: fall through to default
  }

  return DEFAULT_CATALOG;
}

/**
 * Save (upsert) an endpoint catalog for a tenant.
 * @param {string} tenantId
 * @param {{ endpoints: object[] }} catalog
 */
async function saveCatalog(tenantId, catalog) {
  await prisma.configuracion.upsert({
    where:  { tenantId_clave: { tenantId, clave: CONFIG_KEY } },
    create: { tenantId, clave: CONFIG_KEY, valor: catalog },
    update: { valor: catalog },
  });
}

module.exports = { getCatalog, saveCatalog, DEFAULT_CATALOG, CONFIG_KEY };
