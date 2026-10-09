'use strict';
/**
 * scheduleConflictService — single source of truth for "is this agente busy?"
 *
 * Both the booking engine (calendarService.bookSlot) and the admin agenda
 * (manual AgendaEvent creation/assignment) must agree on what counts as a
 * schedule conflict for an agente. Without this shared check, a bot-booked
 * Appointment and a manually-assigned AgendaEvent (or two AgendaEvents) could
 * overlap for the same agente with no warning.
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// AgendaEvent has no "cancelled" estado (see AGENDA_STATES in admin.js), so every
// row occupies time on the agente's schedule unless explicitly excluded by id.
const ACTIVE_APPOINTMENT_STATUSES = ['scheduled', 'rescheduled'];

/**
 * Find AgendaEvent / Appointment rows that overlap [startAt, endAt) for a given agente.
 *
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {number} opts.agenteId
 * @param {Date|string} opts.startAt
 * @param {Date|string} opts.endAt
 * @param {number} [opts.excludeEventId]        AgendaEvent id to ignore (editing itself)
 * @param {string} [opts.excludeAppointmentId]   Appointment id to ignore (rescheduling itself)
 * @returns {Promise<{ hasConflict: boolean, conflicts: Array<{ source: 'agenda_event'|'appointment', id: number|string, titulo: string, startAt: Date, endAt: Date }> }>}
 */
async function checkAgenteScheduleConflict({
  tenantId,
  agenteId,
  startAt,
  endAt,
  excludeEventId = null,
  excludeAppointmentId = null,
}) {
  if (!tenantId || !Number.isInteger(agenteId) || agenteId <= 0) {
    return { hasConflict: false, conflicts: [] };
  }

  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    return { hasConflict: false, conflicts: [] };
  }

  const [events, appointments] = await Promise.all([
    prisma.agendaEvent.findMany({
      where: {
        tenantId,
        startAt: { lt: end },
        endAt: { gt: start },
        assignments: { some: { agenteId } },
        ...(excludeEventId ? { id: { not: excludeEventId } } : {}),
      },
      select: { id: true, titulo: true, startAt: true, endAt: true },
    }),
    prisma.appointment.findMany({
      where: {
        tenantId,
        startTime: { lt: end },
        endTime: { gt: start },
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
        calendar: { is: { agenteId } },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
      select: { id: true, startTime: true, endTime: true, userKey: true },
    }),
  ]);

  const conflicts = [
    ...events.map((e) => ({
      source: 'agenda_event',
      id: e.id,
      titulo: e.titulo,
      startAt: e.startAt,
      endAt: e.endAt,
    })),
    ...appointments.map((a) => ({
      source: 'appointment',
      id: a.id,
      titulo: `Cita - ${a.userKey}`,
      startAt: a.startTime,
      endAt: a.endTime,
    })),
  ];

  return { hasConflict: conflicts.length > 0, conflicts };
}

module.exports = {
  checkAgenteScheduleConflict,
};
