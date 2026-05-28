'use strict';
/**
 * Node Executors — pure, stateless functions per node type.
 *
 * Each executor receives a context object and returns an ExecutorResult:
 *   {
 *     output       : object    // the response payload to send to the user
 *     nextNodeId   : string|null  // resolved next node (may differ from node.next)
 *     updatedVars  : object    // variables to merge into execution.variables
 *     terminal     : boolean   // true = end/handoff, close execution
 *     fallback     : boolean   // true = hand off to human agent
 *   }
 *
 * Executors do NOT write to the DB — that is the responsibility of ContextStore.
 * Executors do NOT call the LLM directly — they receive the llmService as a
 * dependency injection to keep them testable without network calls.
 *
 * Supported node types:
 *   start, message, input, menu, condition, action, task, llm, delay, end, handoff
 */

const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve template strings like "Hola {{name}}" against a variables map.
 * Unknown variables are left as-is.
 */
function readVariableValue(variables, rawPath) {
  const path = String(rawPath ?? '').trim();
  if (!path) return undefined;

  const direct = variables[path];
  if (direct !== undefined) return direct;

  const normalized = path.startsWith('variables.') ? path.slice('variables.'.length) : path;
  if (variables[normalized] !== undefined) return variables[normalized];

  const tryNested = (base, parts) => {
    let cursor = base;
    for (const part of parts) {
      if (!cursor || typeof cursor !== 'object') return undefined;
      cursor = cursor[part];
    }
    return cursor;
  };

  const directNested = tryNested(variables, path.split('.'));
  if (directNested !== undefined) return directNested;

  if (normalized !== path) {
    return tryNested(variables, normalized.split('.'));
  }

  return undefined;
}

function formatTemplateValue(value) {
  if (value === null || value === undefined) return '';

  if (Array.isArray(value)) {
    if (value.length === 0) return '';

    const rendered = value
      .map((item) => {
        if (item === null || item === undefined) return '';
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
          return String(item).trim();
        }
        if (typeof item === 'object') {
          const preferred = [
            item.label,
            item.title,
            item.summary,
            item.horario,
            item.slotLabel,
            item.slot_label,
            item.startTime,
          ].find((v) => typeof v === 'string' && v.trim());

          if (preferred) return String(preferred).trim();

          try {
            return JSON.stringify(item);
          } catch (_err) {
            return String(item);
          }
        }
        return String(item).trim();
      })
      .filter(Boolean);

    if (rendered.length === 0) return '';
    return rendered.map((entry, index) => `${index + 1}. ${entry}`).join('\n');
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (_err) {
      return String(value);
    }
  }

  return String(value);
}

function resolveTemplate(template, variables) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const value = readVariableValue(variables, key);
    return value !== undefined ? formatTemplateValue(value) : match;
  });
}

/**
 * Resolve all string values inside a (potentially nested) config object.
 */
function resolveConfig(config, variables) {
  if (typeof config === 'string') return resolveTemplate(config, variables);
  if (Array.isArray(config)) return config.map((item) => resolveConfig(item, variables));
  if (config && typeof config === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(config)) {
      result[k] = resolveConfig(v, variables);
    }
    return result;
  }
  return config;
}

function _normalizeMenuInput(value) {
  return String(value ?? '').trim();
}

function _humanizeOptionId(id) {
  const clean = String(id ?? '').trim();
  if (!clean) return '';
  return clean
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function _extractMenuOptions(cfg, branchKeys) {
  const fromConfigOptions = Array.isArray(cfg?.options)
    ? cfg.options.map((opt) => {
        const id = String(opt?.id ?? '').trim();
        const title = String(opt?.title ?? opt?.label ?? '').trim();
        return id ? { id, title: title || id } : null;
      }).filter(Boolean)
    : [];
  const fromButtons = Array.isArray(cfg?.buttons) ? cfg.buttons : [];
  const fromSections = Array.isArray(cfg?.sections)
    ? cfg.sections.flatMap((s) => (Array.isArray(s?.rows) ? s.rows : []))
    : [];

  const source = fromButtons.length ? fromButtons : (fromSections.length ? fromSections : fromConfigOptions);
  if (source.length) return source;

  return branchKeys.map((key) => ({ id: key, title: _humanizeOptionId(key) || key }));
}

function _toHour24(rawHour, rawMeridiem) {
  const hour = Number(rawHour);
  if (!Number.isFinite(hour)) return null;
  const meridiem = String(rawMeridiem ?? '').toLowerCase().replace(/\./g, '');
  if (meridiem === 'am') return hour === 12 ? 0 : hour;
  if (meridiem === 'pm') return hour === 12 ? 12 : hour + 12;
  return hour;
}

function _extractHourFromText(text) {
  const m = String(text ?? '').match(/\b(\d{1,2})(?::\d{2})?\s*([ap]\.?m\.?)?\b/i);
  if (!m) return null;
  return _toHour24(m[1], m[2]);
}

function _coerceBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'si', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

function _buildInputValidation(cfg) {
  const validationType = String(cfg?.validationType ?? '').trim().toLowerCase();
  const customPattern = String(cfg?.validationPattern ?? cfg?.pattern ?? cfg?.regex ?? '').trim();
  const customFlags = String(cfg?.validationFlags ?? '').trim();
  const customMessage = String(cfg?.validationMessage ?? cfg?.invalidMessage ?? '').trim();

  const byType = {
    cedula: {
      regex: /^\d{6,13}$/,
      message: 'Formato invalido. Ingresa solo numeros de cedula (6 a 13 digitos).',
    },
    numeric: {
      regex: /^\d+$/,
      message: 'Formato invalido. Ingresa solo numeros.',
    },
    email: {
      regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      message: 'Formato invalido. Ingresa un correo valido (ej: nombre@dominio.com).',
    },
  };

  if (validationType && validationType !== 'none' && validationType !== 'regex' && byType[validationType]) {
    return {
      isEnabled: true,
      regex: byType[validationType].regex,
      message: customMessage || byType[validationType].message,
    };
  }

  if (validationType === 'regex' || customPattern) {
    try {
      return {
        isEnabled: true,
        regex: new RegExp(customPattern, customFlags || undefined),
        message: customMessage || 'Formato invalido. Intentalo de nuevo.',
      };
    } catch (err) {
      logger.warn({ err: err.message, customPattern, customFlags }, 'nodeExecutors.input: invalid validation regex');
      return {
        isEnabled: false,
      };
    }
  }

  return {
    isEnabled: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual executors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * start — entry point node, just advances to next.
 */
async function executeStart({ node }) {
  return {
    output     : null,
    nextNodeId : node.next,
    updatedVars: {},
    terminal   : false,
    fallback   : false,
  };
}

/**
 * message — sends a text/media/template message to the user.
 */
async function executeMessage({ node, variables }) {
  const cfg = resolveConfig(node.config, variables);
  return {
    output     : { type: 'text', text: cfg.text ?? '' },
    nextNodeId : node.next,
    updatedVars: {},
    terminal   : false,
    fallback   : false,
  };
}

/**
 * menu — sends a button/list menu and waits for selection.
 * Navigation: branches[buttonId] → next node. Falls back to node.next.
 *
 * Two-phase execution:
 *   Phase 1 (show): no branch match → display menu, stay at this node (nextNodeId = node.id)
 *   Phase 2 (select): branch match → output=null, advance to branch (engine auto-advances)
 */
async function executeMenu({ node, input, variables }) {
  const cfg = resolveConfig(node.config, variables);
  const options = _extractMenuOptions(cfg, Object.keys(node.branches ?? {}));
  const derivedBranchesFromOptions = Array.isArray(cfg?.options)
    ? Object.fromEntries(
        cfg.options.flatMap((opt) => {
          const id = String(opt?.id ?? '').trim();
          const next = String(opt?.next ?? '').trim();
          return id && next ? [[id, next]] : [];
        }),
      )
    : {};
  const branches = {
    ...derivedBranchesFromOptions,
    ...(node.branches ?? {}),
  };
  const branchKeys = Object.keys(branches);
  const normalizedInput = _normalizeMenuInput(input);

  // Check if input matches a branch key (button id / list row id)
  let nextFromBranch = normalizedInput ? (branches[normalizedInput] ?? null) : null;

  // Also accept option title text as selection (common in text fallbacks).
  if (!nextFromBranch && normalizedInput && options.length) {
    const exactTitle = options.find(
      (opt) => String(opt?.title ?? '').trim().toLowerCase() === normalizedInput.toLowerCase(),
    );
    if (exactTitle?.id) {
      nextFromBranch = branches[String(exactTitle.id).trim()] ?? null;
    }
  }

  if (!nextFromBranch && normalizedInput) {
    const caseInsensitive = branchKeys.find(
      (k) => k.toLowerCase() === normalizedInput.toLowerCase(),
    );
    if (caseInsensitive) {
      nextFromBranch = branches[caseInsensitive] ?? null;
    }
  }

  if (!nextFromBranch && /^\d{1,2}$/.test(normalizedInput)) {
    const index = Number(normalizedInput) - 1;
    if (index >= 0 && index < branchKeys.length) {
      const key = branchKeys[index];
      nextFromBranch = branches[key] ?? null;
    }
  }

  // Accept hour-like text inputs (e.g. "8:00", "8 am", "14") and match
  // either option IDs or option titles (e.g. "Lunes 2:00 p.m").
  if (!nextFromBranch && normalizedInput && options.length) {
    const hourMatch = normalizedInput.match(/^(\d{1,2})(?::\d{2})?\s*([ap]\.?m\.?)?\b/i);
    if (hourMatch) {
      const inputHour24 = _toHour24(hourMatch[1], hourMatch[2]);
      const inputHourRaw = Number(hourMatch[1]);

      const byId = options.find((opt) => {
        const id = String(opt?.id ?? '').trim();
        if (!/^\d{1,2}$/.test(id)) return false;
        const idHour = Number(id);
        return idHour === inputHourRaw || idHour === inputHour24;
      });

      const byTitle = options.find((opt) => {
        const optionHour24 = _extractHourFromText(opt?.title);
        if (optionHour24 == null || inputHour24 == null) return false;
        return optionHour24 === inputHour24;
      });

      const match = byId ?? byTitle;
      if (match?.id) {
        nextFromBranch = branches[String(match.id).trim()] ?? null;
      }
    }
  }

  if (nextFromBranch) {
    // Phase 2: valid selection — route silently (no output), engine will auto-advance
    return {
      output     : null,
      nextNodeId : nextFromBranch,
      updatedVars: {},
      terminal   : false,
      fallback   : false,
    };
  }

  // Defensive fallback: if a user answered something but this menu has no branch map,
  // continue through node.next instead of looping forever asking to choose an option.
  if (!nextFromBranch && normalizedInput && branchKeys.length === 0 && node.next) {
    return {
      output     : null,
      nextNodeId : node.next,
      updatedVars: {},
      terminal   : false,
      fallback   : false,
    };
  }

  // Guardrail: avoid infinite loops when menu node has no options configured.
  if (!options.length && node.next) {
    return {
      output     : { type: 'text', text: cfg.text ?? 'Continuemos.' },
      nextNodeId : node.next,
      updatedVars: {},
      terminal   : false,
      fallback   : false,
    };
  }

  const sections = Array.isArray(cfg.sections) && cfg.sections.length
    ? cfg.sections
    : (options.length > 3 ? [{ title: 'Opciones', rows: options }] : []);

  // Phase 1: no valid selection → show menu and stay at this node to wait
  return {
    output: {
      type    : options.length <= 3 ? 'buttons' : 'list',
      text    : cfg.text ?? '',
      buttons : options,
      sections,
    },
    nextNodeId : node.id,  // Stay here until user makes a valid selection
    updatedVars: {},
    terminal   : false,
    fallback   : false,
  };
}

/**
 * input — captures user text into a variable.
 * Uses llm_classification if defined and input is free text.
 *
 * Two-phase execution:
 *   Phase 1 (show prompt): variables.__awaiting_input !== node.id
 *     → display prompt, set __awaiting_input=node.id, stay at this node
 *   Phase 2 (capture answer): variables.__awaiting_input === node.id
 *     → capture input into variable, clear __awaiting_input, advance
 */
async function executeInput({ node, input, variables, llmService, tenantId }) {
  const cfg = resolveConfig(node.config, variables);
  const updatedVars = {};
  const crmTouch = {};

  // Phase 2: we already showed the prompt and are now receiving the user's answer
  const isCapturing = variables.__awaiting_input === node.id;

  if (isCapturing && input != null) {
    const capturedInput = String(input).trim();
    const validation = _buildInputValidation(cfg);

    if (validation.isEnabled && !validation.regex.test(capturedInput)) {
      updatedVars.__awaiting_input = node.id;
      return {
        output: {
          type: 'text',
          text: validation.message,
        },
        nextNodeId : node.id,
        updatedVars,
        crmTouch,
        terminal   : false,
        fallback   : false,
      };
    }

    // Capture value into named variable
    if (cfg.variable && input != null) {
      updatedVars[cfg.variable] = capturedInput;
    }

    // Clear the waiting flag
    updatedVars.__awaiting_input = null;

    // Optional mapping from captured input to CRM contact fields.
    if (input != null && typeof cfg.crmField === 'string') {
      const field = cfg.crmField.trim().toLowerCase();
      if (field === 'nombre') {
        const normalized = capturedInput;
        if (normalized) crmTouch.nombre = normalized;
      }
    }

    // LLM classification for free-text routing
    let nextNodeId = node.next;
    if (node.llm_classification?.intents?.length && capturedInput && llmService) {
      try {
        const intent = await llmService.classifyIntent(
          tenantId,
          capturedInput,
          node.llm_classification.intents,
        );
        if (intent && node.branches?.[intent]) {
          nextNodeId = node.branches[intent];
        }
      } catch (err) {
        logger.warn({ tenantId, nodeId: node.id, message: err.message }, 'nodeExecutors.input: classifyIntent failed');
      }
    } else if (capturedInput && node.branches?.[capturedInput]) {
      // Direct branch match (button reply)
      nextNodeId = node.branches[capturedInput];
    }

    return {
      output     : null,  // Don't show prompt again after capturing
      nextNodeId,
      updatedVars,
      crmTouch,
      terminal   : false,
      fallback   : false,
    };
  }

  // Phase 1: show prompt and stay at this node to wait for user reply
  updatedVars.__awaiting_input = node.id;
  const promptText = cfg.prompt ?? cfg.text ?? '';

  return {
    output     : promptText ? { type: 'text', text: promptText } : null,
    nextNodeId : node.id,  // Stay here until user replies
    updatedVars,
    crmTouch,
    terminal   : false,
    fallback   : false,
  };
}

/**
 * condition — evaluates a boolean expression over variables.
 * Supported syntax: "{{var}} == value", "{{var}} > number", "{{var}} != value"
 * Branches: node.branches.true → next if truthy, node.branches.false → next if falsy.
 */
async function executeCondition({ node, variables }) {
  const expr     = String(node.config?.expression ?? '').trim();
  const resolved = expr ? resolveTemplate(expr, variables) : '';
  let   result   = false;

  const readConditionVariableValue = (rawPath) => {
    const path = String(rawPath ?? '').trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
    return readVariableValue(variables, path);
  };

  const evaluateFromFields = () => {
    const variable = String(node.config?.variable ?? '').trim();
    const operator = String(node.config?.operator ?? '').trim().toLowerCase();
    const rawValue = node.config?.value;

    if (!variable || !operator) return null;

    const actualRaw = readConditionVariableValue(variable);
    const actual = typeof actualRaw === 'string' ? _coerce(actualRaw.trim()) : actualRaw;
    const expected = typeof rawValue === 'string' ? _coerce(rawValue.trim()) : rawValue;

    if (operator === 'equals') {
      // eslint-disable-next-line eqeqeq
      return actual == expected;
    }
    if (operator === 'not_equals') {
      // eslint-disable-next-line eqeqeq
      return actual != expected;
    }
    if (operator === 'greater_than') {
      return Number(actual) > Number(expected);
    }
    if (operator === 'less_than') {
      return Number(actual) < Number(expected);
    }
    if (operator === 'contains') {
      return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    }
    if (operator === 'starts_with') {
      return String(actual ?? '').toLowerCase().startsWith(String(expected ?? '').toLowerCase());
    }
    if (operator === 'ends_with') {
      return String(actual ?? '').toLowerCase().endsWith(String(expected ?? '').toLowerCase());
    }
    if (operator === 'is_empty') {
      return actual == null || String(actual).trim() === '';
    }
    if (operator === 'is_not_empty') {
      return !(actual == null || String(actual).trim() === '');
    }

    return null;
  };

  const fieldResult = evaluateFromFields();
  if (typeof fieldResult === 'boolean') {
    result = fieldResult;
  }

  try {
    // Fallback to expression syntax when variable/operator/value is absent.
    if (typeof fieldResult !== 'boolean' && resolved) {
      const match = resolved.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
      if (match) {
        const [, lhs, op, rhs] = match;
        const l = _coerce(lhs.trim());
        const r = _coerce(rhs.trim());
        // eslint-disable-next-line eqeqeq
        if (op === '==')  result = l == r;
        else if (op === '!=')  result = l != r;  // eslint-disable-line eqeqeq
        else if (op === '>')   result = l > r;
        else if (op === '>=')  result = l >= r;
        else if (op === '<')   result = l < r;
        else if (op === '<=')  result = l <= r;
      }
    }
  } catch (err) {
    logger.warn({ nodeId: node.id, expr: resolved || expr, message: err.message }, 'nodeExecutors.condition: eval error');
  }

  const branch   = result ? 'true' : 'false';
  const nextNodeId = node.branches?.[branch] ?? node.next;

  return { output: null, nextNodeId, updatedVars: {}, terminal: false, fallback: false };
}

/** Coerce string to number or boolean when possible. */
function _coerce(val) {
  if (val === 'true')  return true;
  if (val === 'false') return false;
  const n = Number(val);
  return Number.isNaN(n) ? val : n;
}

/**
 * action — calls an external integration (webhook / REST API).
 * node.config.integration_ref → name of Integration record for this tenant.
 * Response fields are merged into variables via response_mapping.
 */
async function executeAction({ node, variables, integrationRunner, tenantId }) {
  const cfg           = resolveConfig(node.config, variables);
  const integrationRef = cfg.integration_ref;

  if (!integrationRef || !integrationRunner) {
    logger.warn({ tenantId, nodeId: node.id }, 'nodeExecutors.action: no integration_ref or runner');
    return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
  }

  let updatedVars = {};
  try {
    const { responseVars } = await integrationRunner.run(tenantId, integrationRef, variables, {
      conversationId: variables.conversation_id ?? null,
      nodeRef: node.id ?? null,
      nodeType: node.type ?? 'action',
      trigger: 'flow_node',
    });
    updatedVars = responseVars ?? {};
  } catch (err) {
    const isTimeoutError = /timed out|timeout/i.test(String(err?.message ?? ''));
    const shouldSoftFailCedulaSync = integrationRef === 'updateContactByIdentification' && isTimeoutError;
    if (shouldSoftFailCedulaSync) {
      logger.warn(
        { tenantId, nodeId: node.id, integrationRef, message: err.message },
        'nodeExecutors.action: cedula sync timed out, continuing flow with soft-fail',
      );
      return {
        output: null,
        nextNodeId: node.next,
        updatedVars: {
          identificacion_sync_status: 'timeout_soft_fail',
          identificacion_sync_timeout: true,
        },
        terminal: false,
        fallback: false,
      };
    }

    logger.error({ tenantId, nodeId: node.id, integrationRef, message: err.message }, 'nodeExecutors.action: integration failed');
    // Route to error branch if defined, otherwise continue
    const nextNodeId = node.branches.error ?? node.next;
    return { output: null, nextNodeId, updatedVars: {}, terminal: false, fallback: false };
  }

  return { output: null, nextNodeId: node.next, updatedVars, terminal: false, fallback: false };
}

/**
 * task — orchestration hook for human-in-the-loop work.
 * Supported actions:
 *   create_task   => asks flowEngine to create/reuse a solicitud
 *   wait_for_task => asks flowEngine to pause until status target is reached
 */
async function executeTask({ node, variables }) {
  const cfg = resolveConfig(node.config, variables);
  const action = String(cfg.action ?? '').trim().toLowerCase();

  if (!action || !['create_task', 'wait_for_task'].includes(action)) {
    return {
      output     : null,
      nextNodeId : node.next,
      updatedVars: {},
      terminal   : false,
      fallback   : false,
    };
  }

  return {
    output     : null,
    nextNodeId : node.next,
    updatedVars: {},
    terminal   : false,
    fallback   : false,
    control    : {
      type: 'task',
      action,
      config: cfg,
    },
  };
}

/**
 * llm — runs one or more LLM prompts per node, stores results in variables,
 * and optionally produces a user-facing text response.
 *
 * Config shape (new multi-prompt):
 *   {
 *     prompts: [
 *       {
 *         id           : string (optional, for audit)
 *         systemPrompt : string  (supports {{var}} templates)
 *         userMessage  : string  (optional override; defaults to user input)
 *         outputMode   : 'text' | 'json'   default 'text'
 *         targetVariable: string (variable name to store result; optional for text)
 *       }
 *     ]
 *     composeMode  : 'sequential' | 'parallel' | 'first_match'  default 'sequential'
 *     fallback_text: string  (shown to user when no text output is produced)
 *     on_error     : 'continue' | 'halt' | 'handoff'            default 'continue'
 *     user_template: string  (optional; overrides raw user input as LLM user message)
 *   }
 *
 * Legacy shape (backward compat):
 *   { prompt: string, system_prompt: string, variable: string }
 *   → mapped automatically to prompts[0] with outputMode 'text'
 */
async function executeLlm({ node, input, variables, llmService, tenantId }) {
  const cfg = resolveConfig(node.config, variables);

  // ── Normalize prompts array ────────────────────────────────────────────────
  let prompts = [];
  if (Array.isArray(cfg.prompts) && cfg.prompts.length > 0) {
    prompts = cfg.prompts;
  } else if (cfg.system_prompt || cfg.prompt) {
    // Legacy single-prompt shape
    prompts = [{
      id            : 'p1',
      systemPrompt  : cfg.system_prompt || cfg.prompt,
      outputMode    : cfg.output_mode || 'text',
      targetVariable: cfg.variable || null,
    }];
  }

  if (!llmService || prompts.length === 0) {
    return {
      output     : cfg.fallback_text ? { type: 'text', text: cfg.fallback_text } : null,
      nextNodeId : node.next,
      updatedVars: {},
      terminal   : false,
      fallback   : false,
    };
  }

  const composeMode = String(cfg.composeMode || cfg.compose_mode || 'sequential').toLowerCase();
  const onError     = String(cfg.onError     || cfg.on_error    || 'continue').toLowerCase();

  // Base user message (may be overridden per-prompt via prompt.userMessage)
  const baseUserMsg = cfg.user_template
    ? resolveTemplate(cfg.user_template, { ...variables, input: input ?? '' })
    : (input ?? '');

  const updatedVars = {};
  let lastTextOutput = null;
  let anyError       = false;

  // ── Run a single prompt ────────────────────────────────────────────────────
  const runPrompt = async (prompt, contextVars) => {
    const sp   = resolveTemplate(String(prompt.systemPrompt || ''), { ...variables, ...contextVars });
    const um   = prompt.userMessage
      ? resolveTemplate(String(prompt.userMessage), { ...variables, ...contextVars, input: input ?? '' })
      : baseUserMsg;
    const mode = String(prompt.outputMode || 'text').toLowerCase();

    try {
      if (mode === 'json') {
        const result = await llmService.callLlmForJson(tenantId, sp, um);
        if (result?.json !== undefined) {
          return { success: true, value: result.json, targetVariable: prompt.targetVariable, mode };
        }
        return { success: false, value: null, targetVariable: prompt.targetVariable, mode };
      } else {
        const result = await llmService.callLlm(tenantId, sp, um);
        const text   = result?.text ?? null;
        return { success: !!text, value: text, targetVariable: prompt.targetVariable, mode };
      }
    } catch (err) {
      logger.error(
        { tenantId, nodeId: node.id, promptId: prompt.id, message: err.message },
        'nodeExecutors.llm: prompt execution failed',
      );
      return { success: false, value: null, targetVariable: prompt.targetVariable, mode, error: err.message };
    }
  };

  // ── Execute prompts per composeMode ───────────────────────────────────────
  if (composeMode === 'parallel') {
    const results = await Promise.all(prompts.map((p) => runPrompt(p, {})));
    for (const r of results) {
      if (r.success) {
        if (r.targetVariable) updatedVars[r.targetVariable] = r.value;
        if (r.mode === 'text' && r.value) lastTextOutput = r.value;
      } else {
        anyError = true;
      }
    }

  } else if (composeMode === 'first_match') {
    for (const prompt of prompts) {
      const r = await runPrompt(prompt, updatedVars);
      if (r.success && r.value != null && r.value !== '') {
        if (r.targetVariable) updatedVars[r.targetVariable] = r.value;
        if (r.mode === 'text') lastTextOutput = r.value;
        break;
      }
    }

  } else {
    // sequential (default): each prompt's results are available to the next
    for (const prompt of prompts) {
      const r = await runPrompt(prompt, updatedVars);
      if (r.success) {
        if (r.targetVariable) updatedVars[r.targetVariable] = r.value;
        if (r.mode === 'text' && r.value) lastTextOutput = r.value;
      } else {
        anyError = true;
        if (onError === 'halt' || onError === 'handoff') break;
      }
    }
  }

  // ── Error routing ─────────────────────────────────────────────────────────
  if (anyError && onError === 'handoff') {
    return {
      output     : { type: 'handoff', text: cfg.fallback_text ?? 'Un agente te atenderá.' },
      nextNodeId : null,
      updatedVars,
      terminal   : true,
      fallback   : true,
    };
  }

  if (anyError && onError === 'halt' && node.branches?.error) {
    return {
      output     : cfg.fallback_text ? { type: 'text', text: cfg.fallback_text } : null,
      nextNodeId : node.branches.error,
      updatedVars,
      terminal   : false,
      fallback   : false,
    };
  }

  // ── Determine user-facing output ──────────────────────────────────────────
  let output = null;
  if (lastTextOutput) {
    output = { type: 'text', text: lastTextOutput };
  } else if (cfg.fallback_text) {
    output = { type: 'text', text: cfg.fallback_text };
  }

  return {
    output,
    nextNodeId : node.next,
    updatedVars,
    terminal   : false,
    fallback   : false,
  };
}

/**
 * delay — introduces a wait before the next node.
 * (In practice a production system would push to a delayed queue;
 *  here we just pass through so the engine remains stateless.)
 */
async function executeDelay({ node }) {
  return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
}

/**
 * end — terminates the flow cleanly.
 */
async function executeEnd({ node, variables }) {
  const cfg = resolveConfig(node.config, variables);
  return {
    output     : { type: 'end', text: cfg.text ?? cfg.message ?? '' },
    nextNodeId : null,
    updatedVars: {},
    terminal   : true,
    fallback   : false,
  };
}

/**
 * handoff — transfers to human agent.
 */
async function executeHandoff({ node, variables }) {
  const cfg = resolveConfig(node.config, variables);

  const transferConversation = _coerceBoolean(
    cfg.transfer_conversation ?? cfg.transfer,
    true,
  );

  const handoffText = cfg.text ?? cfg.message ?? 'Un agente te atendera.';
  const continueWithNextNode = !transferConversation && !!node.next;

  const output = transferConversation
    ? { type: 'handoff', text: handoffText }
    : (continueWithNextNode
      ? { type: 'text', text: handoffText }
      : { type: 'end', text: handoffText });

  return {
    output,
    nextNodeId : continueWithNextNode ? node.next : null,
    updatedVars: {},
    terminal   : !continueWithNextNode,
    fallback   : transferConversation,
    control    : {
      type: 'task',
      action: 'create_task',
      config: {
        ...cfg,
        action: 'create_task',
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor registry
// ─────────────────────────────────────────────────────────────────────────────


/**
 * calendar node executor.
 * Supported actions: show_availability, select_slot, create_appointment,
 * reschedule_appointment, cancel_appointment.
 */
async function executeCalendar({ node, input, variables, tenantId }) {
  const calSvc = require('../services/calendarService');
  const cfg    = resolveConfig(node.config || {}, variables);
  const action = node.action || cfg.action || 'show_availability';

  const resolveCalendarId = async () => {
    if (cfg.calendar_id) return cfg.calendar_id;

    const rawAgenteId = cfg.agente_id
      ?? cfg.agenteId
      ?? variables.agente_id
      ?? variables.agenteId
      ?? variables.assigned_agente_id
      ?? variables.assignedAgenteId
      ?? null;

    const agenteId = rawAgenteId === null || rawAgenteId === undefined || rawAgenteId === ''
      ? null
      : Number(rawAgenteId);

    if (!Number.isInteger(agenteId) || agenteId <= 0) return null;
    return calSvc.getCalendarIdForAgente(tenantId, agenteId);
  };

  const calendarId = await resolveCalendarId();

  if (action === 'show_availability') {
    if (!calendarId) {
      logger.warn({ tenantId, nodeId: node.id }, 'calendar node: missing calendar_id');
      return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
    }
    const slots = await calSvc.getAvailableSlots(calendarId, cfg.range_days || 5);
    if (!slots.length) {
      return {
        output: { type: 'text', text: cfg.no_slots_text || 'No hay horarios disponibles. Un agente te contactara.' },
        nextNodeId: (node.branches && node.branches.no_slots) || node.next,
        updatedVars: {}, terminal: false, fallback: false,
      };
    }
    const buttons = slots.slice(0, 10).map(s => ({ id: s.id, title: _formatSlotLabel(s.startTime) }));
    return {
      output: {
        type    : buttons.length <= 3 ? 'buttons' : 'list',
        text    : cfg.prompt || 'Selecciona una fecha y hora:',
        buttons,
        sections: buttons.length > 3 ? [{ title: 'Horarios disponibles', rows: buttons }] : [],
      },
      nextNodeId: node.id, updatedVars: {}, terminal: false, fallback: false,
    };
  }

  if (action === 'select_slot') {
    if (!input) return executeCalendar({ node: Object.assign({}, node, { action: 'show_availability' }), input: null, variables, tenantId });
    if (!calendarId) {
      return { output: { type: 'text', text: cfg.error_text || 'No pude completar la reserva. Intenta de nuevo.' }, nextNodeId: (node.branches && node.branches.error) || node.next, updatedVars: {}, terminal: false, fallback: false };
    }
    const bookResult = await calSvc.bookSlot({
      calendarId, slotId: input, tenantId,
      userKey: variables.phone || variables.user_key || 'unknown',
      conversationId: variables.conversation_id || null,
      metadata: { user_name: variables.name || null },
    });
    if (bookResult.error) {
      const errText = bookResult.error === 'SLOT_TAKEN'
        ? (cfg.slot_taken_text || 'Ese horario ya fue reservado. Elige otro.')
        : (cfg.error_text || 'No pude completar la reserva. Intenta de nuevo.');
      return { output: { type: 'text', text: errText }, nextNodeId: node.id, updatedVars: {}, terminal: false, fallback: false };
    }
    const a = bookResult.appointment;
    return {
      output: null, nextNodeId: node.next,
      updatedVars: { appointment_id: a.id, appointment_start: a.startTime.toISOString(), appointment_end: a.endTime.toISOString(), appointment_status: 'scheduled' },
      terminal: false, fallback: false,
    };
  }

  if (action === 'create_appointment') {
    const slotId = variables.selected_slot_id || cfg.slot_id;
    if (!slotId || !calendarId) {
      return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
    }
    const bookResult = await calSvc.bookSlot({ calendarId, slotId, tenantId, userKey: variables.phone || 'unknown', conversationId: variables.conversation_id || null, metadata: { user_name: variables.name || null } });
    if (bookResult.error) return { output: null, nextNodeId: (node.branches && node.branches.error) || node.next, updatedVars: {}, terminal: false, fallback: false };
    const a = bookResult.appointment;
    return { output: null, nextNodeId: node.next, updatedVars: { appointment_id: a.id, appointment_start: a.startTime.toISOString(), appointment_end: a.endTime.toISOString(), appointment_status: 'scheduled' }, terminal: false, fallback: false };
  }

  if (action === 'reschedule_appointment') {
    const apptId    = variables.appointment_id;
    const newSlotId = input || variables.new_slot_id;
    if (!apptId || !newSlotId) return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
    const result = await calSvc.rescheduleAppointment(apptId, newSlotId, tenantId);
    if (result.error) return { output: null, nextNodeId: (node.branches && node.branches.error) || node.next, updatedVars: {}, terminal: false, fallback: false };
    const a = result.appointment;
    return { output: null, nextNodeId: node.next, updatedVars: { appointment_id: a.id, appointment_start: a.startTime.toISOString(), appointment_end: a.endTime.toISOString(), appointment_status: 'rescheduled' }, terminal: false, fallback: false };
  }

  if (action === 'cancel_appointment') {
    const apptId = variables.appointment_id || cfg.appointment_id;
    if (!apptId) return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
    const result = await calSvc.cancelAppointment(apptId, tenantId);
    return { output: null, nextNodeId: node.next, updatedVars: result.ok ? { appointment_status: 'cancelled' } : {}, terminal: false, fallback: false };
  }

  logger.warn({ tenantId, nodeId: node.id, action }, 'calendar node: unknown action');
  return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
}

function _formatSlotLabel(date) {
  if (!(date instanceof Date)) date = new Date(date);
  return date.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const EXECUTORS = {
  start    : executeStart,
  message  : executeMessage,
  menu     : executeMenu,
  input    : executeInput,
  condition: executeCondition,
  action   : executeAction,
  task     : executeTask,
  llm      : executeLlm,
  delay    : executeDelay,
  end      : executeEnd,
  handoff  : executeHandoff,
  calendar : executeCalendar,
};

/**
 * Execute a single node.
 *
 * @param {object}  node           - NodeDef from FlowLoader
 * @param {object}  opts
 * @param {string}  opts.input     - Raw user input
 * @param {object}  opts.variables - Current session variables
 * @param {string}  opts.tenantId
 * @param {object}  [opts.llmService]       - injected LLM service
 * @param {object}  [opts.integrationRunner] - injected IntegrationRunner
 * @returns {Promise<ExecutorResult>}
 */
async function executeNode(node, { input, variables, tenantId, llmService, integrationRunner }) {
  const executor = EXECUTORS[node.type];

  if (!executor) {
    logger.warn({ tenantId, nodeType: node.type }, 'nodeExecutors: unknown node type — skipping');
    return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
  }

  return executor({ node, input, variables, tenantId, llmService, integrationRunner });
}

module.exports = { executeNode, resolveTemplate, resolveConfig };
