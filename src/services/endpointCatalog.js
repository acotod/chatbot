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
const MANAGED_ENDPOINT_IDS = new Set([
  'updateContactByIdentification',
]);

/** Built-in catalog served when no tenant catalog is configured */
const DEFAULT_CATALOG = {
  endpoints: [
    // ── Session init ──────────────────────────────────────────────────────────
    {
      id:          'getSessionData',
      name:        'Cargar Datos de Sesión',
      method:      'POST',
      url:         '/api/session/init',
      inputs:      ['telefono'],
      outputs:     ['clienteId', 'nombre', 'cedula', 'saldo', 'estatus', 'plan', 'ultimaFactura'],
      description: 'Carga todos los datos del cliente al inicio de la conversación. Sus outputs quedan disponibles como variables para todos los nodos del flujo.',
      sessionInit: true,
    },

    // ── Transaccionales ───────────────────────────────────────────────────────
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
      id:          'getBalance',
      name:        'Consultar Saldo',
      method:      'POST',
      url:         '/api/billing/balance',
      inputs:      ['clienteId'],
      outputs:     ['saldo', 'vencimiento', 'estadoCuenta'],
      description: 'Consulta el saldo y estado de cuenta del cliente',
    },
    {
      id:          'processPayment',
      name:        'Procesar Pago',
      method:      'POST',
      url:         '/api/payments',
      inputs:      ['clienteId', 'monto', 'referencia'],
      outputs:     ['pagoId', 'estado', 'comprobante'],
      description: 'Registra un pago y devuelve el comprobante',
    },
    {
      id:          'getAppointments',
      name:        'Consultar Citas',
      method:      'GET',
      url:         '/api/appointments',
      inputs:      ['clienteId', 'fecha'],
      outputs:     ['citas', 'total'],
      description: 'Obtiene citas disponibles para una fecha dada',
    },
    {
      id:          'createAppointment',
      name:        'Agendar Cita',
      method:      'POST',
      url:         '/api/appointments',
      inputs:      ['clienteId', 'fecha', 'hora', 'motivo'],
      outputs:     ['citaId', 'confirmacion', 'direccion'],
      description: 'Crea una nueva cita y devuelve la confirmación',
    },
    {
      id:          'createTicket',
      name:        'Crear Ticket de Soporte',
      method:      'POST',
      url:         '/api/tickets',
      inputs:      ['clienteId', 'descripcion', 'prioridad'],
      outputs:     ['ticketId', 'estado', 'agente'],
      description: 'Abre un ticket de soporte y asigna un agente',
    },
    {
      id:          'updateTicketStatus',
      name:        'Actualizar Ticket',
      method:      'PATCH',
      url:         '/api/tickets/:ticketId',
      inputs:      ['ticketId', 'estado', 'comentario'],
      outputs:     ['ok', 'estadoActual'],
      description: 'Actualiza el estado de un ticket existente',
    },
    {
      id:          'updateContactByIdentification',
      name:        'Actualizar Contacto TSE',
      method:      'PATCH',
      url:         '/crm/contacts/by-cedula',
      inputs:      ['identificacion'],
      outputs:     ['ok', 'found', 'contactId', 'tenantId', 'identificacion', 'nombre', 'email', 'empresa', 'cargo', 'phone', 'updatedAt'],
      description: 'Actualiza la informacion del contacto en TSE usando solo la identificacion (cedula) y devuelve campos listos para mapear a variables.',
    },
    {
      id:          'sendNotification',
      name:        'Enviar Notificación',
      method:      'POST',
      url:         '/api/notifications/send',
      inputs:      ['clienteId', 'canal', 'mensaje'],
      outputs:     ['enviado', 'notifId'],
      description: 'Envía una notificación por el canal seleccionado (email, sms, whatsapp)',
    },
    {
      id:          'saveConversation',
      name:        'Guardar Conversación',
      method:      'POST',
      url:         '/events/save-conversation',
      inputs:      ['userKey', 'flowId', 'conversationId', 'flowVersionId', 'nodeRef', 'eventType', 'payload', 'context', 'status'],
      inputDefaults: {
        userKey:        'variables.telefono',
        flowId:         'variables.flow_id',
        conversationId: 'variables.conversation_id',
        flowVersionId:  'variables.flow_version_id',
        nodeRef:        'variables.current_node',
        eventType:      'USER_EVENT',
        payload:        'variables.payload',
        context:        '{}',
        status:         'active',
      },
      outputs:     ['saved', 'conversationId', 'status'],
      description: 'Crea o actualiza una conversación y agrega un evento a su timeline usando x-api-key del tenant.',
    },
  ],
};

function mergeCatalogWithDefaults(catalog) {
  const customEndpoints = Array.isArray(catalog?.endpoints) ? catalog.endpoints : [];
  const defaultById = new Map(DEFAULT_CATALOG.endpoints.map((endpoint) => [endpoint.id, endpoint]));

  const merged = customEndpoints.map((endpoint) => {
    if (!endpoint?.id) return endpoint;
    const base = defaultById.get(endpoint.id);
    if (!base) return endpoint;

    const inputDefaults = {
      ...(base.inputDefaults && typeof base.inputDefaults === 'object' ? base.inputDefaults : {}),
      ...(endpoint.inputDefaults && typeof endpoint.inputDefaults === 'object' ? endpoint.inputDefaults : {}),
    };

    const mergedEndpoint = {
      ...base,
      ...endpoint,
      inputs: Array.isArray(endpoint.inputs) ? endpoint.inputs : base.inputs,
      outputs: Array.isArray(endpoint.outputs) ? endpoint.outputs : base.outputs,
      ...(Object.keys(inputDefaults).length ? { inputDefaults } : {}),
    };

    // Managed endpoints must keep platform contract stable even when tenant
    // catalog contains outdated overrides.
    if (MANAGED_ENDPOINT_IDS.has(endpoint.id)) {
      return {
        ...mergedEndpoint,
        id: base.id,
        name: base.name,
        method: base.method,
        url: base.url,
        inputs: base.inputs,
        outputs: base.outputs,
        description: base.description,
        sessionInit: base.sessionInit,
      };
    }

    return mergedEndpoint;
  });

  const knownIds = new Set(customEndpoints.map((endpoint) => endpoint?.id).filter(Boolean));

  DEFAULT_CATALOG.endpoints.forEach((endpoint) => {
    if (!knownIds.has(endpoint.id)) {
      merged.push(endpoint);
    }
  });

  return { endpoints: merged };
}

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
      return mergeCatalogWithDefaults(config.valor);
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
