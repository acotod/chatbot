'use strict';
/**
 * CRM Auto-Sync Service
 *
 * Automatically enriches CRM contact profiles from all system interactions.
 *
 * Called from:
 *   - /whatsapp incoming message handler (_handleIncomingMessage)
 *   - /webhook (Meta Flows data_exchange)
 *   - database.saveSolicitud
 *
 * What it does on each touch:
 *   1. Sets `ultimoContacto` to now
 *   2. Sets `canalOrigen` (only if null — first-touch attribution)
 *   3. Extracts name from WhatsApp contact profile if available and `nombre` is null
 *   4. Recalculates `leadScore` from actual activity counts (messages, solicitudes, deals, agenda)
 */

const logger = require('../utils/logger');

// How much each activity is worth in the lead score formula
const SCORE_WEIGHTS = {
  mensajesPerPoint:    2,   // +1 point per N messages (avoids gaming)
  solicitudPoints:    15,   // flat points per solicitud
  dealPoints:         20,   // flat points per deal
  agendaPoints:       10,   // flat points per appointment
};
const SCORE_CAP = 100;

/**
 * Touch a contact — update CRM fields from an interaction.
 *
 * @param {object} opts
 * @param {number}        opts.userId      - User.id (required)
 * @param {object}        opts.prisma      - PrismaClient instance (required)
 * @param {string}        [opts.canal]     - Channel name for first-touch (e.g. 'whatsapp', 'flows', 'manual')
 * @param {string|null}   [opts.nombre]    - Display name from platform (e.g. WhatsApp profile name)
 */
async function touch({ userId, prisma, canal, nombre }) {
  if (!userId || !prisma) return;

  try {
    // Load current contact + counts in a single query
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        nombre:      true,
        canalOrigen: true,
        _count: {
          select: {
            mensajes:   true,
            solicitudes: true,
            deals:       true,
            // agendaItems is only present if that relation exists
          },
        },
      },
    });

    if (!user) return;

    // ── Compute lead score ──────────────────────────────────────────────────
    const msgScore      = Math.min(Math.floor(user._count.mensajes / SCORE_WEIGHTS.mensajesPerPoint), 40);
    const solScore      = Math.min(user._count.solicitudes * SCORE_WEIGHTS.solicitudPoints, 30);
    const dealScore     = Math.min(user._count.deals * SCORE_WEIGHTS.dealPoints, 20);
    const leadScore     = Math.min(msgScore + solScore + dealScore, SCORE_CAP);

    // ── Build update payload ────────────────────────────────────────────────
    const data = {
      ultimoContacto: new Date(),
      updatedAt:      new Date(),
      leadScore,
    };

    // First-touch canal attribution
    if (!user.canalOrigen && canal) {
      data.canalOrigen = canal;
    }

    // Enrich name only if not yet set
    if (!user.nombre && nombre) {
      data.nombre = nombre;
    }

    await prisma.user.update({ where: { id: userId }, data });
  } catch (err) {
    // Non-fatal: CRM sync should never break the main flow
    logger.warn('crmSync.touch failed', { userId, message: err.message });
  }
}

module.exports = { touch };
