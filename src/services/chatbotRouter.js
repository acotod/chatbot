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

/**
 * Route a WhatsApp user input through the active chatbot engine.
 *
 * @param {{ tenantId: string, userId: number, input: string|null, phone?: string }} opts
 * @returns {Promise<{ response: object|null, fallbackToHuman: boolean }>}
 */
async function routeMessage({ tenantId, userId, input, phone }) {
  // Check if chatbot is enabled for this tenant
  const motorCfg = await db.getConfig(tenantId, 'motor_config');
  const engine = motorCfg?.valor?.engine ?? 'flow_engine';

  if (engine === 'off') {
    return { response: null, fallbackToHuman: false };
  }

  // Load current conversation context (legacy path still uses currentNodeId)
  const ctx = await db.getConversationContext(tenantId, userId);
  const currentNodeId = ctx?.currentNodeId ?? null;

  let result;
  try {
    result = await executeStep({
      tenantId,
      currentNodeId,
      input     : input ?? '',
      userId,
      sessionKey: phone ?? String(userId),
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

  // Explicit handoff node → human agent (clear context, do NOT persist handoff node)
  if (type === 'handoff') {
    await db.clearConversationContext(tenantId, userId);
    return { response: content, fallbackToHuman: true };
  }

  // End node → clear context, no further messages
  if (type === 'end') {
    await db.clearConversationContext(tenantId, userId);
    return { response: content, fallbackToHuman: false };
  }

  // For legacy flows only: update ConversationContext.currentNodeId.
  // For versioned flows, ContextStore already saved state inside executeStep.
  if (typeof result.nodeId === 'number') {
    await db.setConversationContext(tenantId, userId, { currentNodeId: result.nodeId });
  }

  return { response: content, fallbackToHuman: false };
}

module.exports = { routeMessage };
