/**
 * Flow navigation logic for WhatsApp Flows.
 * No database dependencies — pure screen/option mapping.
 * Pass a custom `navigationOverride` (from tenant's configuraciones) to use
 * per-tenant routing; falls back to DEFAULT_NAVIGATION.
 */

const DEFAULT_NAVIGATION = {
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
  // After submitting this screen, continue to closing screen.
  SOLICITUD_ESPACIO: {
    __next: 'CIERRE',
  },
};

function mergeNavigation(override) {
  if (!override || typeof override !== 'object') return DEFAULT_NAVIGATION;

  const merged = { ...DEFAULT_NAVIGATION };
  for (const [screen, screenCfg] of Object.entries(override)) {
    if (screenCfg && typeof screenCfg === 'object' && !Array.isArray(screenCfg)) {
      merged[screen] = {
        ...(DEFAULT_NAVIGATION[screen] || {}),
        ...screenCfg,
      };
    } else {
      merged[screen] = screenCfg;
    }
  }
  return merged;
}

/**
 * Determine the next screen based on the current screen and request data.
 * @param {string} screen              - Current screen name
 * @param {object} data                - Request data payload
 * @param {object} [navigationOverride] - Tenant-specific navigation config (optional)
 * @returns {string|null} Next screen name, or null if not found
 */
function getNextScreen(screen, data, navigationOverride) {
  const navigation = mergeNavigation(navigationOverride);
  const screenConfig = navigation[screen];
  if (!screenConfig) return null;

  if (screenConfig.__next) return screenConfig.__next;

  for (const field of Object.keys(screenConfig)) {
    if (field === '__next') continue;
    const value = data[field];
    if (value !== undefined) {
      const next = screenConfig[field][value];
      return next !== undefined ? next : null;
    }
  }

  return null;
}

module.exports = { getNextScreen, DEFAULT_NAVIGATION };

