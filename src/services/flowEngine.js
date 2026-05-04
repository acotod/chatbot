'use strict';
/**
 * Dynamic flow engine — Hybrid Rules + LLM.
 *
 * Node navigation strategy (evaluated in order):
 *   1. Button / menu selection  → edge where condition === input  (deterministic)
 *   2. Default edge             → edge with no condition           (deterministic)
 *   3. LLM classification       → when node.content.llm_classification is defined
 *                                  and the user typed free text, classify intent
 *                                  and match edge where condition === classified_intent
 *
 * Node content examples:
 *
 *   // Deterministic menu node
 *   { "type": "menu", "text": "¿Cómo te sentís?",
 *     "buttons": [{"id": "estres", "title": "Estresado"},
 *                 {"id": "info",   "title": "Solo información"}] }
 *
 *   // LLM classification node (free text → intent → next node)
 *   { "type": "input", "text": "Contame qué te pasa hoy",
 *     "llm_classification": { "intents": ["crisis", "estres", "info"] } }
 *   Edges from this node should have condition = "crisis" | "estres" | "info"
 *
 *   // LLM generation node (generate a dynamic reply)
 *   { "type": "llm", "system_prompt": "You are a support agent...",
 *     "user_template": "User said: {{input}}" }
 *   The engine will call the LLM, embed the reply in content.text, and advance.
 */
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * Find the active flow for a tenant.
 */
async function getActiveFlow(tenantId) {
  return prisma.flow.findFirst({
    where: { tenantId, activo: true },
    include: {
      nodes: true,
      edges: true,
    },
    orderBy: { version: 'desc' },
  });
}

/**
 * Execute one step of the flow.
 *
 * @param {object} opts
 * @param {string}      opts.tenantId
 * @param {number|null} opts.currentNodeId  - null means "start"
 * @param {string}      opts.input          - user's answer / button id / free text
 * @returns {{ nodeId, content } | null}
 */
async function executeStep({ tenantId, currentNodeId, input }) {
  // Lazy-load to avoid circular dependency (llmService → (nothing) → flowEngine)
  const { classifyIntent, callLlm } = require('./llmService');

  const flow = await getActiveFlow(tenantId);
  if (!flow) {
    logger.warn({ tenantId }, 'flowEngine: no active flow found');
    return null;
  }

  // ── Start: find first node ───────────────────────────────────────────────────
  if (!currentNodeId) {
    const startNode = flow.nodes.find((n) => n.type === 'start') ?? flow.nodes[0];
    if (!startNode) return null;
    return { nodeId: startNode.id, content: startNode.content };
  }

  // ── Current node ─────────────────────────────────────────────────────────────
  const currentNode = flow.nodes.find((n) => n.id === currentNodeId);
  const content     = currentNode?.content ?? {};
  const edges       = flow.edges.filter((e) => e.sourceNodeId === currentNodeId);

  // ── 1. Deterministic: direct condition match ──────────────────────────────────
  let matchedEdge =
    edges.find((e) => e.condition && e.condition === input) ??
    edges.find((e) => !e.condition); // default / unconditional edge

  // ── 2. LLM classification: free text → intent → edge ─────────────────────────
  if (!matchedEdge && content.llm_classification?.intents?.length && input?.trim()) {
    logger.info({ tenantId, currentNodeId, input }, 'flowEngine: routing via LLM classification');

    const intent = await classifyIntent(tenantId, input.trim(), content.llm_classification.intents);

    if (intent) {
      matchedEdge = edges.find((e) => e.condition === intent);
    }

    // Fallback: default edge if intent didn't match any edge condition
    if (!matchedEdge) {
      matchedEdge = edges.find((e) => !e.condition);
      if (intent && !matchedEdge) {
        logger.warn({ tenantId, currentNodeId, intent }, 'flowEngine: LLM intent has no mapped edge — end of flow');
      }
    }
  }

  // ── 3. LLM generation: build dynamic reply inline ────────────────────────────
  if (content.type === 'llm' && content.system_prompt) {
    const userMsg = content.user_template
      ? content.user_template.replace('{{input}}', input ?? '')
      : (input ?? '');

    const llmResult = await callLlm(tenantId, content.system_prompt, userMsg);
    const replyText = llmResult?.text ?? content.fallback_text ?? 'No pude generar una respuesta. Un agente te contactará.';

    // Advance to the next node (default edge) while injecting the generated text
    if (!matchedEdge) {
      matchedEdge = edges.find((e) => !e.condition);
    }
    if (!matchedEdge) return null;

    const nextNode = flow.nodes.find((n) => n.id === matchedEdge.targetNodeId);
    if (!nextNode) return null;

    return {
      nodeId : nextNode.id,
      content: { ...nextNode.content, llm_reply: replyText },
    };
  }

  if (!matchedEdge) return null; // end of flow

  const nextNode = flow.nodes.find((n) => n.id === matchedEdge.targetNodeId);
  if (!nextNode) return null;

  return { nodeId: nextNode.id, content: nextNode.content };
}

module.exports = { getActiveFlow, executeStep };

