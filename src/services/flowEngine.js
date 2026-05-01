'use strict';
/**
 * Dynamic flow engine.
 * Evaluates a flow given a currentScreen + input data,
 * returns the next node content to send to the user.
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
 * @param {object} opts
 * @param {string}  opts.tenantId
 * @param {number|null} opts.currentNodeId  - null means "start"
 * @param {string}  opts.input              - user's answer / screen name
 * @returns {{ node, content } | null}
 */
async function executeStep({ tenantId, currentNodeId, input }) {
  const flow = await getActiveFlow(tenantId);
  if (!flow) {
    logger.warn({ tenantId }, 'No active flow found');
    return null;
  }

  // Find starting node if no current node
  if (!currentNodeId) {
    const startNode = flow.nodes.find((n) => n.type === 'start') ?? flow.nodes[0];
    if (!startNode) return null;
    return { nodeId: startNode.id, content: startNode.content };
  }

  // Find outgoing edges from current node
  const edges = flow.edges.filter((e) => e.sourceNodeId === currentNodeId);

  // Find matching edge by condition or default (no condition)
  const matchedEdge =
    edges.find((e) => e.condition && e.condition === input) ??
    edges.find((e) => !e.condition);

  if (!matchedEdge) return null; // end of flow

  const nextNode = flow.nodes.find((n) => n.id === matchedEdge.targetNodeId);
  if (!nextNode) return null;

  return { nodeId: nextNode.id, content: nextNode.content };
}

module.exports = { getActiveFlow, executeStep };
