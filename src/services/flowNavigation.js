/**
 * Flow navigation logic for WhatsApp Flows.
 * No database dependencies — pure screen/option mapping.
 */

const NAVIGATION = {
  INICIO: {
    opcion_inicio: {
      hablar_alguien: 'HABLAR_ALGUIEN',
      estres: 'ESTRES',
      informacion: 'INFORMACION',
      urgencia: 'URGENCIA',
    },
  },
  HABLAR_ALGUIEN: {
    opcion: {
      agendar: 'SOLICITUD_ESPACIO',
      ver_horarios: 'HORARIOS',
    },
  },
  ESTRES: {
    opcion: {
      si_un_poco: 'CIERRE',
      necesito_hablar: 'HABLAR_ALGUIEN',
      ver_horarios: 'HORARIOS',
    },
  },
  INFORMACION: {
    opcion: {
      agendar: 'SOLICITUD_ESPACIO',
      salir: 'CIERRE',
    },
  },
};

/**
 * Determine the next screen based on the current screen and request data.
 * @param {string} screen - Current screen name
 * @param {object} data   - Request data payload
 * @returns {string|null} Next screen name, or null if not found
 */
function getNextScreen(screen, data) {
  const screenConfig = NAVIGATION[screen];
  if (!screenConfig) return null;

  for (const field of Object.keys(screenConfig)) {
    const value = data[field];
    if (value !== undefined) {
      const next = screenConfig[field][value];
      return next !== undefined ? next : null;
    }
  }

  return null;
}

module.exports = { getNextScreen };
