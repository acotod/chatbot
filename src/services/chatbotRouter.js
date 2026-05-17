'use strict';
/**
 * Chatbot Router — Hybrid engine per tenant.
 *
 * Strategy (tenant config key "motor_config"):
 *   { "engine": "flow_engine" }  → use DB-backed node/edge flow (default)
 *   { "engine": "off" }          → chatbot disabled for this tenant
 *
 * Flow engine returns { nodeId, content } where content is a JSON object:
 *   { type: "text",    text: "Message" }
 *   { type: "buttons", text: "Choose:", buttons: [{id, title}, ...] }  ← max 3
 *   { type: "list",    text: "Choose:", sections: [{title, rows: [{id, title}]}] }
 *   { type: "handoff", text: "Un agente te atenderá." }  → triggers human fallback
 *   { type: "end",     text: "Hasta luego." }            → ends conversation
 */
const { executeStep } = require('./flowEngine');
const db = require('./database');
const logger = require('../utils/logger');

// Default inactivity timeout before restarting the flow (in minutes).
// Can be overridden per tenant via motor_config.inactivity_timeout_minutes.
const DEFAULT_INACTIVITY_TIMEOUT_MINUTES = 30;

/**
 * Route a WhatsApp user input through the active chatbot engine.
 *
 * @param {{ tenantId: string, userId: number, input: string|null, phone?: string, conversationMeta?: object }} opts
 * @returns {Promise<{ response: object|null, fallbackToHuman: boolean }>}
 */
async function routeMessage({ tenantId, userId, input, phone, conversationMeta }) {
  // Check if chatbot is enabled for this tenant
  const motorCfg = await db.getConfig(tenantId, 'motor_config');
  const engine = motorCfg?.valor?.engine ?? 'flow_engine';

  if (engine === 'off') {
    return { response: null, fallbackToHuman: false };
  }

  // Load current conversation context (legacy path still uses currentNodeId)
  let ctx = await db.getConversationContext(tenantId, userId);

  // ── Inactivity timeout: restart flow if context is too old ───────────────
  const timeoutMinutes =
    typeof motorCfg?.valor?.inactivity_timeout_minutes === 'number'
      ? motorCfg.valor.inactivity_timeout_minutes
      : DEFAULT_INACTIVITY_TIMEOUT_MINUTES;

  if (ctx?.updatedAt) {
    const ageMinutes = (Date.now() - new Date(ctx.updatedAt).getTime()) / 60000;
    if (ageMinutes > timeoutMinutes) {
      logger.info('chatbotRouter: session inactive, restarting flow', {
        tenantId,
        userId,
        ageMinutes: Math.round(ageMinutes),
        timeoutMinutes,
      });
      await db.clearConversationContext(tenantId, userId);
      ctx = null;
    }
  }

  const currentNodeId = ctx?.currentNodeId ?? null;

  let result;
  try {
    result = await executeStep({
      tenantId,
      currentNodeId,
      input     : input ?? '',
      userId,
      sessionKey: phone ?? String(userId),
      conversationMeta,
    });
  } catch (err) {
    logger.error('chatbotRouter: flow engine error', {
      tenantId,
      userId,
      message: err.message,
    });
    await db.clearConversationContext(tenantId, userId);
    return { response: null, fallbackToHuman: true };
  }

  if (!result) {
    // No next node — end of flow or no active flow configured
    await db.clearConversationContext(tenantId, userId);
    return { response: null, fallbackToHuman: false };
  }

  const content = result.content ?? {};
  const type = content.type ?? 'text';
  const conversationId = result.conversationId ?? null;

  // Explicit handoff node → human agent (clear context, do NOT persist handoff node)
  if (type === 'handoff') {
    await db.clearConversationContext(tenantId, userId);
    return { response: content, fallbackToHuman: true, conversationId };
  }

  // End node → clear context, no further messages
  if (type === 'end') {
    await db.clearConversationContext(tenantId, userId);
    return { response: content, fallbackToHuman: false, conversationId };
  }

  // For legacy flows only: update ConversationContext.currentNodeId.
  // For versioned flows, ContextStore already saved state inside executeStep.
  if (typeof result.nodeId === 'number') {
    await db.setConversationContext(tenantId, userId, { currentNodeId: result.nodeId });
  }

  return { response: content, fallbackToHuman: false, conversationId };
}

module.exports = { routeMessage };
