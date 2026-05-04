'use strict';
/**
 * FlowLoader — decoupled from the execution engine.
 *
 * Responsibility: given a tenantId, return the active flow definition
 * as a normalized plain-JS object that the engine can process without
 * any further DB access.
 *
 * Load strategy (in order):
 *   1. Published FlowVersion with the highest version_number → "versioned" path.
 *      The definition JSONB is the single source of truth for nodes/edges/variables.
 *   2. If no published version exists → fall back to the legacy node/edge tables
 *      and build an equivalent definition object on the fly.
 *
 * The returned `FlowDefinition` is always the same shape regardless of source:
 *   {
 *     source       : 'version' | 'legacy'
 *     flowId       : number
 *     versionId    : number | null
 *     entryPoint   : string          // node id of the first node
 *     nodesMap     : { [nodeId]: NodeDef }
 *     variables    : { [name]: VariableDef }
 *     metadata     : object
 *   }
 *
 * NodeDef (for both sources):
 *   {
 *     id           : string
 *     type         : 'message'|'input'|'menu'|'condition'|'action'|'delay'|'end'|'handoff'|'llm'|'start'
 *     config       : object          // node-specific config (text, buttons, expression, integration_ref, …)
 *     next         : string | null   // default next node id
 *     branches     : { [condition]: string }  // conditional branches (condition → nodeId)
 *     llm_classification : object | null
 *   }
 */

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the active flow definition for a tenant.
 * Returns null if no active flow is configured.
 *
 * @param {string} tenantId
 * @returns {Promise<FlowDefinition|null>}
 */
async function loadFlowDefinition(tenantId) {
  // ── 1. Try published FlowVersion ─────────────────────────────────────────
  try {
    const flowVersion = await prisma.flowVersion.findFirst({
      where: {
        published: true,
        flow: { tenantId, activo: true },
      },
      orderBy: { versionNumber: 'desc' },
      include: { flow: { select: { id: true } } },
    });

    if (flowVersion) {
      logger.debug({ tenantId, versionId: flowVersion.id }, 'flowLoader: using published version');
      return _buildFromVersion(flowVersion);
    }
  } catch (err) {
    logger.warn({ tenantId, message: err.message }, 'flowLoader: FlowVersion query failed, trying legacy');
  }

  // ── 2. Fallback: legacy node/edge tables ──────────────────────────────────
  try {
    const flow = await prisma.flow.findFirst({
      where: { tenantId, activo: true },
      include: { nodes: true, edges: true },
      orderBy: { version: 'desc' },
    });

    if (!flow) return null;

    logger.debug({ tenantId, flowId: flow.id }, 'flowLoader: using legacy node/edge model');
    return _buildFromLegacy(flow);
  } catch (err) {
    logger.error({ tenantId, message: err.message }, 'flowLoader: legacy query failed');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _buildFromVersion(flowVersion) {
  const def = flowVersion.definition;

  if (!def || !Array.isArray(def.nodes)) {
    logger.warn({ versionId: flowVersion.id }, 'flowLoader: version definition has no nodes array');
    return null;
  }

  const nodesMap = {};
  for (const node of def.nodes) {
    nodesMap[node.id] = {
      id                : node.id,
      type              : node.type ?? 'message',
      config            : node.config ?? {},
      next              : node.next ?? null,
      branches          : node.branches ?? {},
      llm_classification: node.llm_classification ?? null,
    };
  }

  return {
    source    : 'version',
    flowId    : flowVersion.flow.id,
    versionId : flowVersion.id,
    entryPoint: def.entry_point ?? Object.keys(nodesMap)[0] ?? null,
    nodesMap,
    variables : def.variables ?? {},
    metadata  : def.metadata  ?? {},
  };
}

function _buildFromLegacy(flow) {
  if (!flow.nodes?.length) return null;

  const nodesMap = {};

  // Build a lookup: sourceNodeId → [edges]
  const edgesBySource = {};
  for (const edge of (flow.edges ?? [])) {
    if (!edgesBySource[edge.sourceNodeId]) edgesBySource[edge.sourceNodeId] = [];
    edgesBySource[edge.sourceNodeId].push(edge);
  }

  for (const node of flow.nodes) {
    const nodeEdges  = edgesBySource[node.id] ?? [];
    const defaultEdge = nodeEdges.find((e) => !e.condition);
    const branches   = {};
    for (const e of nodeEdges) {
      if (e.condition) branches[e.condition] = String(e.targetNodeId);
    }

    const content = node.content ?? {};
    nodesMap[String(node.id)] = {
      id                : String(node.id),
      type              : node.type ?? content.type ?? 'message',
      config            : content,
      next              : defaultEdge ? String(defaultEdge.targetNodeId) : null,
      branches,
      llm_classification: content.llm_classification ?? null,
    };
  }

  const startNode = flow.nodes.find((n) => n.type === 'start') ?? flow.nodes[0];

  return {
    source    : 'legacy',
    flowId    : flow.id,
    versionId : null,
    entryPoint: String(startNode.id),
    nodesMap,
    variables : {},
    metadata  : {},
  };
}

module.exports = { loadFlowDefinition };
