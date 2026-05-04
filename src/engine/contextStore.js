'use strict';
/**
 * ContextStore — execution state management.
 *
 * Abstracts all DB reads/writes for conversation state so the engine
 * never touches the ORM directly.
 *
 * For versioned (JSONB-based) flows   → reads/writes FlowExecution + appends ExecutionLog.
 * For legacy (node/edge) flows        → reads/writes ConversationContext (backward compat).
 *
 * State shape returned by getState():
 *   {
 *     source          : 'execution' | 'legacy'
 *     executionId     : number | null
 *     currentNodeRef  : string | null    // string id for versioned, null for legacy start
 *     currentNodeId   : number | null    // legacy integer id
 *     variables       : object
 *   }
 */

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load conversation state for a user.
 *
 * @param {string} tenantId
 * @param {number} userId
 * @param {'version'|'legacy'} flowSource - from FlowDefinition.source
 * @param {number} flowId
 * @returns {Promise<State>}
 */
async function getState(tenantId, userId, flowSource, flowId) {
  if (flowSource === 'version') {
    return _getExecutionState(tenantId, userId, flowId);
  }
  return _getLegacyState(tenantId, userId);
}

/**
 * Persist state after a step is processed.
 *
 * @param {string} tenantId
 * @param {number} userId
 * @param {object} opts
 * @param {'execution'|'legacy'} opts.source
 * @param {number|null}  opts.executionId
 * @param {number}       opts.flowId
 * @param {number|null}  opts.flowVersionId
 * @param {string}       opts.sessionKey     - phone or user identifier
 * @param {string|null}  opts.currentNodeRef - new node ref after step
 * @param {number|null}  opts.currentNodeId  - legacy integer id
 * @param {object}       opts.variables
 * @param {boolean}      opts.terminal       - true = close execution
 * @returns {Promise<{executionId: number|null}>}
 */
async function saveState(tenantId, userId, opts) {
  const { source, terminal } = opts;

  if (source === 'execution') {
    return _saveExecutionState(tenantId, userId, opts, terminal);
  }
  return _saveLegacyState(tenantId, userId, opts, terminal);
}

/**
 * Append a per-step log entry (enterprise path only).
 *
 * @param {number}       executionId
 * @param {string}       tenantId
 * @param {object}       entry
 * @param {string}       entry.nodeRef
 * @param {string}       entry.nodeType
 * @param {object|null}  entry.input
 * @param {object|null}  entry.output
 * @param {number|null}  entry.durationMs
 * @param {'ok'|'error'|'skipped'} entry.status
 * @param {string|null}  entry.errorMessage
 */
async function appendLog(executionId, tenantId, entry) {
  if (!executionId) return;
  try {
    await prisma.executionLog.create({
      data: {
        executionId,
        tenantId,
        nodeRef     : entry.nodeRef,
        nodeType    : entry.nodeType,
        input       : entry.input ?? undefined,
        output      : entry.output ?? undefined,
        durationMs  : entry.durationMs ?? undefined,
        status      : entry.status ?? 'ok',
        errorMessage: entry.errorMessage ?? undefined,
      },
    });
  } catch (err) {
    logger.warn({ executionId, message: err.message }, 'contextStore.appendLog: failed');
  }
}

/**
 * Clear all state for a user (used on reset/restart).
 *
 * @param {string} tenantId
 * @param {number} userId
 */
async function clearState(tenantId, userId) {
  try {
    await Promise.all([
      prisma.conversationContext.deleteMany({ where: { tenantId, userId } }),
    ]);
  } catch (err) {
    logger.warn({ tenantId, userId, message: err.message }, 'contextStore.clearState: failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _getExecutionState(tenantId, userId, flowId) {
  try {
    // Look up via ConversationContext → FlowExecution link
    const ctx = await prisma.conversationContext.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });

    if (ctx?.flowExecutionId) {
      const exec = await prisma.flowExecution.findUnique({
        where: { id: ctx.flowExecutionId },
      });
      if (exec && exec.status === 'active') {
        return {
          source        : 'execution',
          executionId   : exec.id,
          currentNodeRef: exec.currentNodeRef,
          currentNodeId : null,
          variables     : (exec.variables ?? {}),
        };
      }
    }

    // No active execution → start fresh
    return { source: 'execution', executionId: null, currentNodeRef: null, currentNodeId: null, variables: {} };
  } catch (err) {
    logger.warn({ tenantId, userId, message: err.message }, 'contextStore._getExecutionState: failed');
    return { source: 'execution', executionId: null, currentNodeRef: null, currentNodeId: null, variables: {} };
  }
}

async function _getLegacyState(tenantId, userId) {
  try {
    const ctx = await prisma.conversationContext.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    return {
      source        : 'legacy',
      executionId   : null,
      currentNodeRef: null,
      currentNodeId : ctx?.currentNodeId ?? null,
      variables     : (ctx?.variables ?? {}),
    };
  } catch (err) {
    logger.warn({ tenantId, userId, message: err.message }, 'contextStore._getLegacyState: failed');
    return { source: 'legacy', executionId: null, currentNodeRef: null, currentNodeId: null, variables: {} };
  }
}

async function _saveExecutionState(tenantId, userId, opts, terminal) {
  const { flowId, flowVersionId, sessionKey, currentNodeRef, variables, executionId } = opts;
  const status = terminal ? 'completed' : 'active';

  try {
    let execId = executionId;

    if (execId) {
      // Update existing execution
      await prisma.flowExecution.update({
        where: { id: execId },
        data : {
          currentNodeRef: terminal ? null : currentNodeRef,
          variables     : variables ?? {},
          status,
          completedAt   : terminal ? new Date() : undefined,
        },
      });
    } else {
      // Create new execution record
      const exec = await prisma.flowExecution.upsert({
        where : { tenantId_flowId_sessionKey: { tenantId, flowId, sessionKey } },
        update: {
          currentNodeRef: terminal ? null : currentNodeRef,
          variables     : variables ?? {},
          status,
          completedAt   : terminal ? new Date() : undefined,
        },
        create: {
          tenantId,
          flowId,
          flowVersionId : flowVersionId ?? undefined,
          sessionKey,
          currentNodeRef: terminal ? null : currentNodeRef,
          variables     : variables ?? {},
          status,
          completedAt   : terminal ? new Date() : undefined,
        },
      });
      execId = exec.id;
    }

    // Keep ConversationContext in sync for backward compat
    await prisma.conversationContext.upsert({
      where : { tenantId_userId: { tenantId, userId } },
      update: {
        currentNodeRef : terminal ? null : currentNodeRef,
        currentNodeId  : null,
        flowExecutionId: terminal ? null : execId,
        variables      : variables ?? {},
      },
      create: {
        tenantId,
        userId,
        currentNodeRef : terminal ? null : currentNodeRef,
        currentNodeId  : null,
        flowExecutionId: terminal ? null : execId,
        engine         : 'flow_engine',
        variables      : variables ?? {},
      },
    });

    if (terminal) {
      // Clear ctx link when done
      await prisma.conversationContext.updateMany({
        where: { tenantId, userId },
        data : { flowExecutionId: null, currentNodeRef: null },
      });
    }

    return { executionId: execId };
  } catch (err) {
    logger.error({ tenantId, userId, message: err.message }, 'contextStore._saveExecutionState: failed');
    return { executionId: null };
  }
}

async function _saveLegacyState(tenantId, userId, opts, terminal) {
  const { currentNodeId, variables } = opts;

  if (terminal) {
    try {
      await prisma.conversationContext.deleteMany({ where: { tenantId, userId } });
    } catch (err) {
      logger.warn({ tenantId, userId, message: err.message }, 'contextStore._saveLegacyState: delete failed');
    }
    return { executionId: null };
  }

  try {
    await prisma.conversationContext.upsert({
      where : { tenantId_userId: { tenantId, userId } },
      update: { currentNodeId: currentNodeId ?? null, variables: variables ?? {} },
      create: { tenantId, userId, currentNodeId: currentNodeId ?? null, engine: 'flow_engine', variables: variables ?? {} },
    });
    return { executionId: null };
  } catch (err) {
    logger.warn({ tenantId, userId, message: err.message }, 'contextStore._saveLegacyState: upsert failed');
    return { executionId: null };
  }
}

module.exports = { getState, saveState, appendLog, clearState };
