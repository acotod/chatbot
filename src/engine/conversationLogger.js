'use strict';
/**
 * Conversation Logger — append-only event sourcing for conversations.
 *
 * Provides a thin, non-blocking layer over the `conversations` and
 * `conversation_events` tables.  All writes are best-effort (errors are
 * logged but never thrown to the caller) so that a logger failure NEVER
 * breaks the conversational flow.
 *
 * Usage from flowEngine:
 *
 *   const convId = await conversationLogger.getOrCreate(tenantId, userKey, flowId, versionId);
 *   await conversationLogger.log(convId, tenantId, 'node_1', EVENT.MESSAGE_SENT, { text: '...' });
 *   await conversationLogger.end(convId, 'completed', finalVars);
 *
 * Event types (see EVENT constant below):
 *   flow_start | message_sent | user_input | menu_selection | condition_eval
 *   api_call   | api_response | llm_call   | variable_set   | flow_end
 *   flow_handoff | flow_error | task_created | task_waiting | task_completed
 */

const { PrismaClient } = require('@prisma/client');
const logger           = require('../utils/logger');

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// Event type constants (source of truth — import this anywhere you log events)
// ─────────────────────────────────────────────────────────────────────────────
const EVENT = Object.freeze({
  FLOW_START     : 'flow_start',
  MESSAGE_SENT   : 'message_sent',
  USER_INPUT     : 'user_input',
  MENU_SELECTION : 'menu_selection',
  CONDITION_EVAL : 'condition_eval',
  API_CALL       : 'api_call',
  API_RESPONSE   : 'api_response',
  LLM_CALL       : 'llm_call',
  VARIABLE_SET   : 'variable_set',
  FLOW_END       : 'flow_end',
  FLOW_HANDOFF   : 'flow_handoff',
  FLOW_ERROR     : 'flow_error',
  TASK_CREATED              : 'task_created',
  TASK_WAITING              : 'task_waiting',
  TASK_COMPLETED            : 'task_completed',
  CALENDAR_AVAILABILITY_SHOWN: 'calendar_availability_shown',
  CALENDAR_SLOT_SELECTED    : 'calendar_slot_selected',
  APPOINTMENT_CREATED       : 'appointment_created',
  APPOINTMENT_RESCHEDULED   : 'appointment_rescheduled',
  APPOINTMENT_CANCELLED     : 'appointment_cancelled',
});

// ─────────────────────────────────────────────────────────────────────────────
// getOrCreate
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns the id of the current active conversation for this user+flow,
 * or creates a new one if none exists.
 *
 * "Active" = status='active' AND no ended_at.
 *
 * @param {string}  tenantId
 * @param {string}  userKey        - phone number or other session identifier
 * @param {number}  flowId
 * @param {number|null} flowVersionId
 * @returns {Promise<string|null>}  UUID of the conversation, or null on error
 */
async function getOrCreate(tenantId, userKey, flowId, flowVersionId = null) {
  try {
    // Look for the most recent active conversation for this user+flow
    const existing = await prisma.conversation.findFirst({
      where: {
        tenantId,
        userKey,
        flowId,
        status  : 'active',
        endedAt : null,
      },
      orderBy: { startedAt: 'desc' },
      select : { id: true },
    });

    if (existing) return existing.id;

    // Create a fresh conversation
    const created = await prisma.conversation.create({
      data: {
        tenantId,
        userKey,
        flowId,
        flowVersionId : flowVersionId ?? null,
        status        : 'active',
        context       : {},
      },
      select: { id: true },
    });

    return created.id;
  } catch (err) {
    logger.error({ tenantId, userKey, flowId, message: err.message },
      'conversationLogger.getOrCreate failed');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// log  (append-only — never update/delete)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Append one event to the conversation timeline.
 *
 * @param {string}      conversationId  UUID
 * @param {string}      tenantId        UUID
 * @param {string|null} nodeRef         node identifier (e.g. "node_1")
 * @param {string}      eventType       one of EVENT.*
 * @param {object}      payload         event-specific JSONB
 * @returns {Promise<void>}
 */
async function log(conversationId, tenantId, nodeRef, eventType, payload = {}) {
  if (!conversationId) return;          // safety: if getOrCreate returned null
  try {
    await prisma.conversationEvent.create({
      data: {
        conversationId,
        tenantId,
        nodeRef  : nodeRef ?? null,
        eventType,
        payload,
      },
    });
  } catch (err) {
    logger.error(
      { conversationId, tenantId, nodeRef, eventType, message: err.message },
      'conversationLogger.log failed',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateContext  (snapshot of live variables for active conversations)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Update the mutable context snapshot on the conversations row.
 * Only called while the conversation is active; cleared on end().
 *
 * @param {string} conversationId
 * @param {object} context  e.g. { current_node: 'node_3', variables: { name: 'Juan' } }
 */
async function updateContext(conversationId, context) {
  if (!conversationId) return;
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data : { context },
    });
  } catch (err) {
    logger.error({ conversationId, message: err.message },
      'conversationLogger.updateContext failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// end
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Mark the conversation as ended.
 *
 * @param {string} conversationId  UUID
 * @param {string} [status]        'completed' | 'abandoned' | 'error' (default: 'completed')
 * @param {object} [finalContext]  snapshot of final variables
 */
async function end(conversationId, status = 'completed', finalContext = {}) {
  if (!conversationId) return;
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data : {
        status,
        endedAt: new Date(),
        context: finalContext,
      },
    });
  } catch (err) {
    logger.error({ conversationId, status, message: err.message },
      'conversationLogger.end failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  EVENT,
  getOrCreate,
  log,
  updateContext,
  end,
};
