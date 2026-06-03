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
const CEDULA_SYNC_TIMEOUT_MS = Number.isFinite(Number(process.env.CEDULA_SYNC_TIMEOUT_MS))
  ? Number(process.env.CEDULA_SYNC_TIMEOUT_MS)
  : 45000;

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

  const normalizeToken = (value) => String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const pickByLooseKey = (source, keyPath) => {
    if (!source || typeof source !== 'object') return undefined;

    const exactKey = Object.keys(source).find((candidate) => String(candidate).toLowerCase() === String(keyPath).toLowerCase());
    if (exactKey && source[exactKey] !== undefined) return source[exactKey];

    const normalizedPath = normalizeToken(keyPath);
    if (!normalizedPath) return undefined;

    const fuzzyKey = Object.keys(source).find((candidate) => normalizeToken(candidate) === normalizedPath);
    if (fuzzyKey && source[fuzzyKey] !== undefined) return source[fuzzyKey];

    return undefined;
  };

  const direct = variables[path];
  if (direct !== undefined) return direct;

  const normalized = path.startsWith('variables.') ? path.slice('variables.'.length) : path;
  if (variables[normalized] !== undefined) return variables[normalized];

  const directLoose = pickByLooseKey(variables, path);
  if (directLoose !== undefined) return directLoose;

  const normalizedLoose = pickByLooseKey(variables, normalized);
  if (normalizedLoose !== undefined) return normalizedLoose;

  const scopedVariables = variables && typeof variables === 'object' ? variables.variables : undefined;
  const scopedDirect = pickByLooseKey(scopedVariables, path);
  if (scopedDirect !== undefined) return scopedDirect;

  const scopedNormalized = pickByLooseKey(scopedVariables, normalized);
  if (scopedNormalized !== undefined) return scopedNormalized;

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
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}|\{\s*([^{}]+?)\s*\}/g, (match, doubleKey, singleKey) => {
    const key = String(doubleKey ?? singleKey ?? '').trim();
    if (!key) return match;
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

function _buildCalendarNoSlotsText(cfg = {}, slotDurationMin = null) {
  const parsedSlotDurationMin = Number.isFinite(Number(slotDurationMin)) && Number(slotDurationMin) > 0
    ? Math.trunc(Number(slotDurationMin))
    : null;
  const fallbackTemplate = parsedSlotDurationMin
    ? 'No hay horarios disponibles de {{slot_duration_min}} minutos por el momento. Si quieres, podemos continuar sin agendar por ahora.'
    : 'No hay horarios disponibles por el momento. Si quieres, podemos continuar sin agendar por ahora.';
  const template = _pickFirstNonEmpty(cfg.no_slots_text, fallbackTemplate);
  return resolveTemplate(template, {
    slot_duration_min: parsedSlotDurationMin ?? '',
    appointment_duration_min: parsedSlotDurationMin ?? '',
  });
}

function _buildCalendarAvailabilityPrompt(cfg = {}, slotDurationMin = null) {
  const parsedSlotDurationMin = Number.isFinite(Number(slotDurationMin)) && Number(slotDurationMin) > 0
    ? Math.trunc(Number(slotDurationMin))
    : null;
  const template = _pickFirstNonEmpty(cfg.prompt, 'Selecciona una fecha y hora:');
  return resolveTemplate(template, {
    slot_duration_min: parsedSlotDurationMin ?? '',
    appointment_duration_min: parsedSlotDurationMin ?? '',
  });
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

function _normalizeUuid(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return /^[0-9a-fA-F-]{36}$/.test(raw) ? raw : null;
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
async function executeInput({ node, input, variables, llmService, integrationRunner, tenantId }) {
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

    // Optional integration call for input nodes (e.g. lookup by cedula).
    // Uses current variables + captured value so body mappings can resolve.
    if (cfg.integration_ref && integrationRunner) {
      try {
        const integrationVars = {
          ...variables,
          ...updatedVars,
        };
        const isCedulaSync = String(cfg.integration_ref).trim() === 'updateContactByIdentification';

        const { responseVars } = await integrationRunner.run(tenantId, cfg.integration_ref, integrationVars, {
          conversationId: variables.conversation_id ?? null,
          nodeRef: node.id ?? null,
          nodeType: node.type ?? 'input',
          trigger: 'flow_node',
          ...(isCedulaSync ? { timeoutMs: CEDULA_SYNC_TIMEOUT_MS } : {}),
        });

        Object.assign(updatedVars, responseVars ?? {});
      } catch (err) {
        logger.warn(
          { tenantId, nodeId: node.id, integrationRef: cfg.integration_ref, message: err.message },
          'nodeExecutors.input: integration failed',
        );
      }
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
async function executeCalendar({ node, input, variables, tenantId, llmService }) {
  const calSvc = require('../services/calendarService');
  const cfg    = resolveConfig(node.config || {}, variables);
  const action = node.action || cfg.action || 'show_availability';
  const calendarVarName = String(cfg.calendar_variable || 'selected_calendar_id').trim() || 'selected_calendar_id';
  const availabilityVarName = String(cfg.availability_variable || 'agenda_horarios_disponibles').trim() || 'agenda_horarios_disponibles';
  const availabilityItemsVarName = `${availabilityVarName}_items`;
  const availabilityStructuredVarName = `${availabilityVarName}_structured`;
  const availabilitySummaryVarName = `${availabilityVarName}_summary`;
  const availabilityLlmVarName = `${availabilityVarName}_llm`;
  const selectionStrategy = String(
    cfg.assignment_strategy
    ?? cfg.calendar_selection_strategy
    ?? cfg.strategy
    ?? 'random'
  ).trim().toLowerCase();
  const selectedCalendarFromVars = String(variables?.[calendarVarName] ?? '').trim();
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

  const rawPuestoId = cfg.agente_puesto_id
    ?? cfg.puesto_id
    ?? cfg.agentePuestoId
    ?? cfg.puestoId
    ?? variables.agente_puesto_id
    ?? variables.puesto_id
    ?? variables.agentePuestoId
    ?? variables.puestoId
    ?? null;

  const puestoId = rawPuestoId === null || rawPuestoId === undefined || rawPuestoId === ''
    ? null
    : Number(rawPuestoId);

  const puestoNombre = String(
    cfg.agente_puesto_nombre
    ?? cfg.puesto_nombre
    ?? cfg.agentePuestoNombre
    ?? cfg.puestoNombre
    ?? variables.agente_puesto_nombre
    ?? variables.puesto_nombre
    ?? variables.agentePuestoNombre
    ?? variables.puestoNombre
    ?? ''
  ).trim();

  const usePuestoResolution = Number.isInteger(puestoId) && puestoId > 0
    || Boolean(puestoNombre);
  const requestedSlotDurationMin = _parseSlotDurationMin(
    cfg.slot_duration_min
    ?? cfg.slotDurationMin
    ?? cfg.appointment_duration_min
    ?? cfg.duration_min
    ?? null,
  );

  const buildBookingTaskPayload = async ({ appointment, selectedCalendarId }) => {
    const shouldCreateTask = _coerceBoolean(
      cfg.create_task_on_booking ?? cfg.auto_create_task ?? cfg.create_task ?? true,
      true,
    );
    if (!shouldCreateTask) return null;

    const calendarCtx = await calSvc.getCalendarAssignmentContext(selectedCalendarId, tenantId);
    const agreedStartIso = appointment?.startTime?.toISOString?.() ?? null;
    const agreedEndIso = appointment?.endTime?.toISOString?.() ?? null;
    const agreedStartLabel = agreedStartIso ? _formatSlotLabel(agreedStartIso) : '';

    const customerName = String(
      variables.nombre
      ?? variables.name
      ?? variables.user_name
      ?? variables.full_name
      ?? variables.nombre_completo
      ?? variables.cliente_nombre
      ?? variables.clienteNombre
      ?? ''
    ).trim();

    const customerCedula = String(
      variables.cedula
      ?? variables.cliente_cedula
      ?? variables.clienteCedula
      ?? variables.identificacion
      ?? variables.identificacion_cliente
      ?? variables.identification
      ?? variables.numero_cedula
      ?? ''
    ).trim();

    const agenteNombre = String(calendarCtx?.agenteNombre || '').trim();
    const taskTitle = String(
      cfg.task_title
      || `Cita acordada${customerName ? ` - ${customerName}` : ''}${agreedStartLabel ? ` (${agreedStartLabel})` : ''}`
    ).trim();

    const summaryParts = [
      agreedStartLabel ? `Horario acordado: ${agreedStartLabel}` : '',
      agenteNombre ? `Agente: ${agenteNombre}` : '',
      customerName ? `Nombre: ${customerName}` : '',
      customerCedula ? `Cedula: ${customerCedula}` : '',
    ].filter(Boolean);

    return {
      control: {
        type: 'task',
        action: 'create_task',
        config: {
          action: 'create_task',
          title: taskTitle,
          assignment_mode: calendarCtx?.agenteId ? 'fixed' : 'none',
          assign_to: calendarCtx?.agenteId ?? null,
          priority: cfg.task_priority || 'normal',
          status: cfg.task_status || 'open',
        },
      },
      vars: {
        appointment_calendar_id: calendarCtx?.calendarId ?? selectedCalendarId ?? null,
        appointment_calendar_name: calendarCtx?.calendarName ?? null,
        appointment_agente_id: calendarCtx?.agenteId ?? null,
        appointment_agente_nombre: calendarCtx?.agenteNombre ?? null,
        appointment_customer_name: customerName || null,
        appointment_customer_cedula: customerCedula || null,
        appointment_notes_summary: summaryParts.join(' | ') || null,
        appointment_start: agreedStartIso,
        appointment_end: agreedEndIso,
      },
    };
  };

  const resolveCalendarId = async () => {
    if (selectedCalendarFromVars) return selectedCalendarFromVars;

    if (Number.isInteger(agenteId) && agenteId > 0) {
      return calSvc.getCalendarIdForAgente(tenantId, agenteId);
    }

    if (usePuestoResolution) {
      return calSvc.getCalendarIdForPuesto(tenantId, {
        puestoId: Number.isInteger(puestoId) && puestoId > 0 ? puestoId : null,
        puestoNombre: puestoNombre || null,
        strategy: selectionStrategy,
      });
    }

    if (cfg.calendar_id) return cfg.calendar_id;

    return null;
  };

  if (action === 'show_availability') {
    const calendarId = usePuestoResolution && !selectedCalendarFromVars
      ? null
      : await resolveCalendarId();
    const rangeDays = Number.isFinite(Number(cfg.range_days)) ? Number(cfg.range_days) : 5;
    const calendarCandidates = await _resolveCalendarAvailabilityCandidates({
      calendarService: calSvc,
      tenantId,
      calendarId,
      selectedCalendarFromVars,
      agenteId,
      puestoId,
      puestoNombre,
      usePuestoResolution,
    });

    if (!calendarCandidates.length) {
      logger.warn({ tenantId, nodeId: node.id }, 'calendar node: missing calendar_id');
      return {
        output: null,
        nextNodeId: node.next,
        updatedVars: {
          [availabilityVarName]: [],
          [availabilityItemsVarName]: [],
          [availabilityStructuredVarName]: [],
          [availabilitySummaryVarName]: '',
          [availabilityLlmVarName]: null,
        },
        terminal: false,
        fallback: false,
      };
    }

    const availabilityEntries = await _collectAvailabilityEntries({
      calendarService: calSvc,
      calendarCandidates,
      rangeDays,
      slotDurationMin: requestedSlotDurationMin,
    });

    if (!availabilityEntries.length) {
      const noSlotsText = _buildCalendarNoSlotsText(cfg, requestedSlotDurationMin);
      return {
        output: { type: 'text', text: noSlotsText },
        nextNodeId: (node.branches && node.branches.no_slots) || node.next,
        updatedVars: {
          [availabilityVarName]: [],
          [availabilityItemsVarName]: [],
          [availabilityStructuredVarName]: [],
          [availabilitySummaryVarName]: '',
          [availabilityLlmVarName]: null,
        }, terminal: false, fallback: false,
      };
    }

    const topEntries = availabilityEntries.slice(0, 10);
    const buttons = topEntries.map((entry) => ({
      id: entry.slotId,
      title: entry.slotLabel,
    }));
    const availabilityLabels = buttons.map((slot) => slot.title);
    const structuredAvailability = _groupAvailabilityEntries(availabilityEntries);
    const llmAvailability = await _buildAvailabilityLlmExtraction({
      tenantId,
      llmService,
      cfg,
      entries: availabilityEntries,
      puestoId,
      puestoNombre,
    });
    const summaryText = llmAvailability?.resumen || _buildAvailabilityDeterministicSummary(structuredAvailability);

    return {
      output: {
        type    : buttons.length <= 3 ? 'buttons' : 'list',
        text    : _buildCalendarAvailabilityPrompt(cfg, requestedSlotDurationMin),
        buttons,
        sections: buttons.length > 3 ? [{ title: 'Horarios disponibles', rows: buttons }] : [],
      },
      nextNodeId: node.id,
      updatedVars: {
        [calendarVarName]: topEntries[0]?.calendarId ?? calendarId ?? null,
        [availabilityVarName]: availabilityLabels,
        [availabilityItemsVarName]: topEntries,
        [availabilityStructuredVarName]: structuredAvailability,
        [availabilitySummaryVarName]: summaryText,
        [availabilityLlmVarName]: llmAvailability,
        ...(requestedSlotDurationMin ? { appointment_duration_min: requestedSlotDurationMin } : {}),
      },
      terminal: false,
      fallback: false,
    };
  }

  const calendarId = await resolveCalendarId();

  if (action === 'select_slot') {
    if (!input) return executeCalendar({ node: Object.assign({}, node, { action: 'show_availability' }), input: null, variables, tenantId });
    if (_looksLikeCalendarSelectionCancelled(input)) {
      return {
        output: cfg.cancel_text
          ? { type: 'text', text: cfg.cancel_text }
          : null,
        nextNodeId: (node.branches && (node.branches.cancel || node.branches.cancelled || node.branches.decline || node.branches.rejected)) || node.next,
        updatedVars: {
          selected_slot_id: null,
          appointment_status: 'cancelled_by_user',
        },
        terminal: false,
        fallback: false,
      };
    }
    if (!calendarId) {
      return { output: { type: 'text', text: cfg.error_text || 'No pude completar la reserva. Intenta de nuevo.' }, nextNodeId: (node.branches && node.branches.error) || node.next, updatedVars: {}, terminal: false, fallback: false };
    }

    const resolveSlotIdFromInput = async () => {
      const rawInput = String(input ?? '').trim();
      if (!rawInput) return null;

      const asUuid = _normalizeUuid(rawInput);
      if (asUuid) {
        const cachedEntryByUuid = Array.isArray(variables?.[availabilityItemsVarName])
          ? variables[availabilityItemsVarName].find((entry) => String(entry?.slotId || '') === asUuid)
          : null;
        return {
          slotId: asUuid,
          calendarId: String(cachedEntryByUuid?.calendarId || calendarId || '').trim() || null,
          durationMin: Number(cachedEntryByUuid?.durationMin ?? cachedEntryByUuid?.duration_min) || null,
        };
      }

      const cachedEntries = Array.isArray(variables?.[availabilityItemsVarName])
        ? variables[availabilityItemsVarName]
            .map((entry) => _normalizeAvailabilityEntry(entry))
            .filter(Boolean)
        : [];

      let topSlots = cachedEntries;

      if (!topSlots.length) {
        const rangeDays = Number.isFinite(Number(cfg.range_days)) ? Number(cfg.range_days) : 5;
        let slots = [];
        try {
          slots = await calSvc.getAvailableSlots(calendarId, rangeDays);
        } catch (_) {
          slots = [];
        }
        const filteredSlots = Array.isArray(slots)
          ? slots.filter((slot) => _slotMatchesDuration(slot, requestedSlotDurationMin))
          : [];
        if (filteredSlots.length === 0) return null;

        topSlots = filteredSlots.slice(0, 10).map((slot) => ({
          slotId: slot.id,
          calendarId,
          slotLabel: _formatSlotLabel(slot?.startTime, slot?.timezone),
          hourLabel: _formatSlotHour(slot?.startTime, slot?.timezone),
          durationMin: _calcSlotDurationMin(slot?.startTime, slot?.endTime),
        }));
      }

      const normalizedInput = rawInput.toLowerCase();

      const byExactId = topSlots.find((slot) => String(slot?.slotId || slot?.id || '') === rawInput);
      if (byExactId?.slotId || byExactId?.id) {
        return {
          slotId: byExactId?.slotId ?? byExactId?.id ?? null,
          calendarId: byExactId?.calendarId ?? calendarId,
          durationMin: Number(byExactId?.durationMin ?? byExactId?.duration_min) || null,
        };
      }

      const byExactLabel = topSlots.find(
        (slot) => String(slot?.slotLabel || _formatSlotLabel(slot?.startTime, slot?.timezone)).toLowerCase() === normalizedInput,
      );
      if (byExactLabel?.slotId || byExactLabel?.id) {
        return {
          slotId: byExactLabel?.slotId ?? byExactLabel?.id ?? null,
          calendarId: byExactLabel?.calendarId ?? calendarId,
          durationMin: Number(byExactLabel?.durationMin ?? byExactLabel?.duration_min) || null,
        };
      }

      const asIndex = Number.parseInt(rawInput, 10);
      if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= topSlots.length) {
        return {
          slotId: topSlots[asIndex - 1]?.slotId ?? topSlots[asIndex - 1]?.id ?? null,
          calendarId: topSlots[asIndex - 1]?.calendarId ?? calendarId,
          durationMin: Number(topSlots[asIndex - 1]?.durationMin ?? topSlots[asIndex - 1]?.duration_min) || null,
        };
      }

      const targetHour = _extractHourFromText(rawInput);
      if (targetHour !== null) {
        const byHour = topSlots.find(
          (slot) => _extractHourFromText(String(slot?.slotLabel || _formatSlotLabel(slot?.startTime, slot?.timezone))) === targetHour,
        );
        if (byHour?.slotId || byHour?.id) {
          return {
            slotId: byHour?.slotId ?? byHour?.id ?? null,
            calendarId: byHour?.calendarId ?? calendarId,
            durationMin: Number(byHour?.durationMin ?? byHour?.duration_min) || null,
          };
        }
      }

      const allowFuzzyContains = /[a-zA-Z]/.test(rawInput) && normalizedInput.length >= 4;
      if (!allowFuzzyContains) return null;

      const byContainsLabel = topSlots.find((slot) => {
        const label = String(slot?.slotLabel || _formatSlotLabel(slot?.startTime, slot?.timezone)).toLowerCase();
        return label.includes(normalizedInput) || normalizedInput.includes(label);
      });
      if (byContainsLabel?.slotId || byContainsLabel?.id) {
        return {
          slotId: byContainsLabel?.slotId ?? byContainsLabel?.id ?? null,
          calendarId: byContainsLabel?.calendarId ?? calendarId,
          durationMin: Number(byContainsLabel?.durationMin ?? byContainsLabel?.duration_min) || null,
        };
      }

      const llmMatch = await _resolveAvailabilitySelectionWithLlm({
        tenantId,
        llmService,
        cfg,
        userInput: rawInput,
        entries: topSlots,
        fallbackCalendarId: calendarId,
      });
      if (llmMatch?.slotId) return llmMatch;

      return null;
    };

    const resolvedSelection = await resolveSlotIdFromInput();
    if (!resolvedSelection?.slotId) {
      const retryAvailability = await executeCalendar({
        node: Object.assign({}, node, {
          action: 'show_availability',
          config: Object.assign({}, node.config || {}, {
            action: 'show_availability',
            prompt: [
              cfg.retry_text || cfg.error_text || 'No identifique un horario valido. Elige una de estas opciones.',
              String(variables?.[availabilitySummaryVarName] || '').trim(),
            ].filter(Boolean).join('\n\n'),
          }),
        }),
        input: null,
        variables,
        tenantId,
        llmService,
      });
      return {
        output: retryAvailability.output || { type: 'text', text: cfg.error_text || 'La opcion no es valida. Selecciona un horario de la lista.' },
        nextNodeId: retryAvailability.nextNodeId || node.id,
        updatedVars: retryAvailability.updatedVars || {},
        terminal: false,
        fallback: false,
      };
    }

    const appointmentMetadata = await _buildAppointmentMetadata({
      tenantId,
      llmService,
      variables,
      cfg,
    });

    const bookResult = await calSvc.bookSlot({
      calendarId: resolvedSelection.calendarId || calendarId,
      slotId: resolvedSelection.slotId,
      tenantId,
      userKey: variables.phone || variables.user_key || 'unknown',
      conversationId: variables.conversation_id || null,
      metadata: appointmentMetadata,
    });
    if (bookResult.error) {
      const errText = bookResult.error === 'SLOT_TAKEN'
        ? (cfg.slot_taken_text || 'Ese horario ya fue reservado. Elige otro.')
        : (cfg.error_text || 'No pude completar la reserva. Intenta de nuevo.');
      return { output: { type: 'text', text: errText }, nextNodeId: node.id, updatedVars: {}, terminal: false, fallback: false };
    }
    const a = bookResult.appointment;
    const selectedCalendarId = resolvedSelection.calendarId || calendarId;
    const taskPayload = await buildBookingTaskPayload({ appointment: a, selectedCalendarId });
    return {
      output: null, nextNodeId: node.next,
      updatedVars: {
        [calendarVarName]: selectedCalendarId,
        appointment_id: a.id,
        appointment_start: a.startTime.toISOString(),
        appointment_end: a.endTime.toISOString(),
        appointment_status: 'scheduled',
        ...(resolvedSelection?.durationMin
          ? { appointment_duration_min: resolvedSelection.durationMin }
          : requestedSlotDurationMin
            ? { appointment_duration_min: requestedSlotDurationMin }
            : {}),
        ...(taskPayload?.vars ?? {}),
      },
      ...(taskPayload?.control ? { control: taskPayload.control } : {}),
      terminal: false, fallback: false,
    };
  }

  if (action === 'create_appointment') {
    const slotId = variables.selected_slot_id || cfg.slot_id;
    if (!slotId || !calendarId) {
      return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
    }
    const appointmentMetadata = await _buildAppointmentMetadata({
      tenantId,
      llmService,
      variables,
      cfg,
    });
    const bookResult = await calSvc.bookSlot({
      calendarId,
      slotId,
      tenantId,
      userKey: variables.phone || 'unknown',
      conversationId: variables.conversation_id || null,
      metadata: appointmentMetadata,
    });
    if (bookResult.error) return { output: null, nextNodeId: (node.branches && node.branches.error) || node.next, updatedVars: {}, terminal: false, fallback: false };
    const a = bookResult.appointment;
    const taskPayload = await buildBookingTaskPayload({ appointment: a, selectedCalendarId: calendarId });
    return {
      output: null,
      nextNodeId: node.next,
      updatedVars: {
        appointment_id: a.id,
        appointment_start: a.startTime.toISOString(),
        appointment_end: a.endTime.toISOString(),
        appointment_status: 'scheduled',
        ...(taskPayload?.vars ?? {}),
      },
      ...(taskPayload?.control ? { control: taskPayload.control } : {}),
      terminal: false,
      fallback: false,
    };
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

async function _resolveCalendarAvailabilityCandidates({
  calendarService,
  tenantId,
  calendarId,
  selectedCalendarFromVars,
  agenteId,
  puestoId,
  puestoNombre,
  usePuestoResolution,
}) {
  if (selectedCalendarFromVars) {
    const ctx = await calendarService.getCalendarAssignmentContext(selectedCalendarFromVars, tenantId);
    return [{
      id: selectedCalendarFromVars,
      name: ctx?.calendarName ?? null,
      agenteId: ctx?.agenteId ?? null,
      agenteNombre: ctx?.agenteNombre ?? null,
    }];
  }

  if (Number.isInteger(agenteId) && agenteId > 0 && calendarId) {
    const ctx = await calendarService.getCalendarAssignmentContext(calendarId, tenantId);
    return [{
      id: calendarId,
      name: ctx?.calendarName ?? null,
      agenteId: ctx?.agenteId ?? agenteId,
      agenteNombre: ctx?.agenteNombre ?? null,
    }];
  }

  if (usePuestoResolution) {
    return calendarService.getCalendarsForPuesto(tenantId, { puestoId, puestoNombre });
  }

  if (!calendarId) return [];

  const ctx = await calendarService.getCalendarAssignmentContext(calendarId, tenantId);
  return [{
    id: calendarId,
    name: ctx?.calendarName ?? null,
    agenteId: ctx?.agenteId ?? null,
    agenteNombre: ctx?.agenteNombre ?? null,
  }];
}

async function _collectAvailabilityEntries({ calendarService, calendarCandidates, rangeDays, slotDurationMin = null }) {
  const availabilityByCalendar = await Promise.all(
    calendarCandidates.map(async (candidate) => {
      const slots = await calendarService.getAvailableSlots(candidate.id, rangeDays);
      const filteredSlots = Array.isArray(slots)
        ? slots.filter((slot) => _slotMatchesDuration(slot, slotDurationMin))
        : [];
      const effectiveSlots = filteredSlots.length > 0 || !slotDurationMin
        ? filteredSlots
        : (Array.isArray(slots) ? slots : []);
      return effectiveSlots.map((slot) => ({
        slotId: slot.id,
        calendarId: candidate.id,
        calendarName: candidate.name ?? null,
        agenteId: candidate.agenteId ?? null,
        agenteNombre: candidate.agenteNombre ?? null,
        startTime: _toIsoOrNull(slot.startTime),
        endTime: _toIsoOrNull(slot.endTime),
        timezone: slot.timezone ?? null,
        slotLabel: _formatSlotLabel(slot.startTime, slot.timezone),
        dayLabel: _formatSlotDay(slot.startTime, slot.timezone),
        hourLabel: _formatSlotHour(slot.startTime, slot.timezone),
        durationMin: _calcSlotDurationMin(slot.startTime, slot.endTime),
      }));
    }),
  );

  return availabilityByCalendar
    .flat()
    .sort((left, right) => new Date(left.startTime).getTime() - new Date(right.startTime).getTime());
}

function _groupAvailabilityEntries(entries) {
  const grouped = new Map();

  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    const entry = _normalizeAvailabilityEntry(rawEntry);
    if (!entry) continue;

    const agentKey = entry.agenteNombre || entry.calendarName || entry.calendarId;
    if (!grouped.has(agentKey)) {
      grouped.set(agentKey, {
        agente: entry.agenteNombre || null,
        calendarId: entry.calendarId,
        calendarName: entry.calendarName || null,
        dias: [],
      });
    }

    const agentBucket = grouped.get(agentKey);
    let dayBucket = agentBucket.dias.find((day) => day.fecha === entry.dateKey);
    if (!dayBucket) {
      dayBucket = {
        fecha: entry.dateKey,
        dia: entry.dayLabel,
        horas: [],
      };
      agentBucket.dias.push(dayBucket);
    }

    dayBucket.horas.push({
      hora: entry.hourLabel,
      slotId: entry.slotId,
      calendarId: entry.calendarId,
      slotLabel: entry.slotLabel,
      startTime: entry.startTime,
    });
  }

  return Array.from(grouped.values()).map((agentBucket) => ({
    ...agentBucket,
    dias: agentBucket.dias.map((day) => ({
      ...day,
      horas: day.horas.sort((left, right) => new Date(left.startTime).getTime() - new Date(right.startTime).getTime()),
    })),
  }));
}

function _buildAvailabilityDeterministicSummary(groupedAvailability) {
  if (!Array.isArray(groupedAvailability) || groupedAvailability.length === 0) return '';

  return groupedAvailability
    .slice(0, 3)
    .map((agentBucket) => {
      const firstDays = Array.isArray(agentBucket.dias) ? agentBucket.dias.slice(0, 2) : [];
      const dayText = firstDays
        .map((day) => {
          const hours = Array.isArray(day.horas)
            ? day.horas.slice(0, 4).map((hour) => hour.hora).filter(Boolean).join(', ')
            : '';
          return hours ? `${day.dia}: ${hours}` : day.dia;
        })
        .filter(Boolean)
        .join(' | ');

      return [agentBucket.agente || agentBucket.calendarName || 'Agenda', dayText]
        .filter(Boolean)
        .join(': ');
    })
    .filter(Boolean)
    .join(' || ');
}

async function _buildAvailabilityLlmExtraction({ tenantId, llmService, cfg, entries, puestoId, puestoNombre }) {
  const useLlm = _coerceBoolean(
    cfg.llm_extract_availability ?? cfg.use_llm_for_availability ?? cfg.availability_llm_extract ?? true,
    true,
  );

  if (!useLlm || !llmService || !tenantId || !Array.isArray(entries) || entries.length === 0) return null;

  const sample = entries.slice(0, 20).map((entry) => ({
    agente: entry.agenteNombre || null,
    calendar: entry.calendarName || null,
    fecha: entry.dayLabel,
    hora: entry.hourLabel,
    slot_label: entry.slotLabel,
    start_time: entry.startTime,
  }));

  const systemPrompt = [
    'Eres un asistente de agenda clinica.',
    'Analiza disponibilidad de agentes de psicologia.',
    'Extrae los dias mas proximos y las horas disponibles por agente sin inventar datos.',
    'Devuelve SOLO JSON valido con esta estructura:',
    '{"resumen":"string","dias_mas_proximos":[{"fecha":"string","dia":"string","horas":["string"],"agentes":["string"]}],"agentes":[{"agente":"string","primer_dia":"string","horas":["string"]}]}',
  ].join('\n');

  const userPrompt = JSON.stringify({
    puesto_id: Number.isInteger(puestoId) ? puestoId : null,
    puesto_nombre: puestoNombre || null,
    disponibilidad: sample,
  });

  try {
    const result = await llmService.callLlmForJson(tenantId, systemPrompt, userPrompt);
    const json = result?.json;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

    const diasMasProximos = Array.isArray(json.dias_mas_proximos)
      ? json.dias_mas_proximos.slice(0, 5).map((item) => ({
          fecha: _truncateText(item?.fecha, 40),
          dia: _truncateText(item?.dia, 80),
          horas: _sanitizeTextArray(item?.horas, 6, 40),
          agentes: _sanitizeTextArray(item?.agentes, 6, 120),
        }))
      : [];

    const agentes = Array.isArray(json.agentes)
      ? json.agentes.slice(0, 8).map((item) => ({
          agente: _truncateText(item?.agente, 120),
          primer_dia: _truncateText(item?.primer_dia, 80),
          horas: _sanitizeTextArray(item?.horas, 6, 40),
        }))
      : [];

    return {
      resumen: _truncateText(json.resumen, 1200),
      dias_mas_proximos: diasMasProximos,
      agentes,
    };
  } catch (err) {
    logger.warn(
      { tenantId, message: err.message },
      'calendar node: failed to extract availability with llm'
    );
    return null;
  }
}

function _normalizeAvailabilityEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const slotId = String(entry.slotId ?? entry.id ?? '').trim();
  const calendarId = String(entry.calendarId ?? '').trim();
  const startValue = entry.startTime ?? entry.start_time ?? null;
  const startDate = startValue ? new Date(startValue) : null;
  const timezone = entry.timezone ?? null;
  const slotLabel = String(entry.slotLabel ?? entry.slot_label ?? '').trim()
    || (startDate ? _formatSlotLabel(startDate, timezone) : '');
  const dayLabel = String(entry.dayLabel ?? entry.day_label ?? '').trim()
    || (startDate ? _formatSlotDay(startDate, timezone) : '');
  const hourLabel = String(entry.hourLabel ?? entry.hour_label ?? '').trim()
    || (startDate ? _formatSlotHour(startDate, timezone) : '');
  const dateKey = startDate && !Number.isNaN(startDate.getTime())
    ? startDate.toISOString().slice(0, 10)
    : String(entry.dateKey ?? entry.fecha ?? '').trim();
  const durationMin = Number(entry.durationMin ?? entry.duration_min)
    || _calcSlotDurationMin(startValue, entry.endTime ?? entry.end_time ?? null)
    || null;

  if (!slotId) return null;

  return {
    slotId,
    calendarId: calendarId || null,
    calendarName: String(entry.calendarName ?? entry.calendar_name ?? '').trim() || null,
    agenteId: Number(entry.agenteId ?? entry.agente_id ?? 0) || null,
    agenteNombre: String(entry.agenteNombre ?? entry.agente_nombre ?? '').trim() || null,
    startTime: startDate && !Number.isNaN(startDate.getTime()) ? startDate.toISOString() : null,
    slotLabel,
    dayLabel,
    hourLabel,
    dateKey,
    durationMin,
  };
}

function _toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function _parseSlotDurationMin(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function _calcSlotDurationMin(startValue, endValue) {
  if (!startValue || !endValue) return null;
  const start = startValue instanceof Date ? startValue : new Date(startValue);
  const end = endValue instanceof Date ? endValue : new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const diff = end.getTime() - start.getTime();
  if (diff <= 0) return null;
  return Math.round(diff / 60000);
}

function _slotMatchesDuration(slot, requestedDurationMin) {
  if (!requestedDurationMin) return true;
  const durationMin = _calcSlotDurationMin(slot?.startTime, slot?.endTime);
  if (!durationMin) return true;
  return durationMin === requestedDurationMin;
}

async function _resolveAvailabilitySelectionWithLlm({ tenantId, llmService, cfg, userInput, entries, fallbackCalendarId = null }) {
  const useLlm = _coerceBoolean(
    cfg.llm_select_slot ?? cfg.use_llm_for_slot_selection ?? cfg.select_slot_with_llm ?? true,
    true,
  );

  if (!useLlm || !llmService || !tenantId) return null;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const normalizedEntries = entries
    .map((entry) => _normalizeAvailabilityEntry(entry))
    .filter(Boolean)
    .slice(0, 10);
  if (!normalizedEntries.length) return null;

  const systemPrompt = [
    'Eres un asistente que selecciona un horario exacto para reservar una cita.',
    'Debes elegir SOLO entre las opciones disponibles entregadas.',
    'Si el mensaje del usuario no confirma claramente una opcion, devuelve matched=false.',
    'Devuelve SOLO JSON valido con esta estructura:',
    '{"matched":true|false,"slot_id":"string|null","calendar_id":"string|null","reason":"string"}',
  ].join('\n');

  const userPrompt = JSON.stringify({
    user_input: String(userInput || ''),
    opciones: normalizedEntries.map((entry, index) => ({
      index: index + 1,
      slot_id: entry.slotId,
      calendar_id: entry.calendarId,
      agente: entry.agenteNombre,
      agenda: entry.calendarName,
      fecha: entry.dayLabel,
      hora: entry.hourLabel,
      slot_label: entry.slotLabel,
    })),
  });

  try {
    const result = await llmService.callLlmForJson(tenantId, systemPrompt, userPrompt);
    const json = result?.json;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    if (!_coerceBoolean(json.matched, false)) return null;

    const slotId = String(json.slot_id ?? '').trim();
    if (!slotId) return null;

    const matchedEntry = normalizedEntries.find((entry) => entry.slotId === slotId);
    if (!matchedEntry) return null;

    return {
      slotId: matchedEntry.slotId,
      calendarId: matchedEntry.calendarId || String(json.calendar_id ?? '').trim() || fallbackCalendarId || null,
    };
  } catch (err) {
    logger.warn(
      { tenantId, message: err.message },
      'calendar node: failed to resolve slot selection with llm'
    );
    return null;
  }
}

function _looksLikeCalendarSelectionCancelled(input) {
  const normalized = String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  if (!normalized) return false;

  return [
    'ya no',
    'ya no quiero',
    'no lo quiero',
    'no quiero',
    'no deseo',
    'cancelar',
    'cancela',
    'dejalo asi',
    'mejor no',
    'ninguno',
    'ninguna',
    'no gracias',
  ].some((token) => normalized.includes(token));
}

function _formatSlotLabel(date, timeZone = null) {
  if (!(date instanceof Date)) date = new Date(date);
  const options = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  };
  if (timeZone) options.timeZone = String(timeZone);
  return date.toLocaleDateString('es-MX', options);
}

function _formatSlotDay(date, timeZone = null) {
  if (!(date instanceof Date)) date = new Date(date);
  const options = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  };
  if (timeZone) options.timeZone = String(timeZone);
  return date.toLocaleDateString('es-MX', options);
}

function _formatSlotHour(date, timeZone = null) {
  if (!(date instanceof Date)) date = new Date(date);
  const options = {
    hour: '2-digit',
    minute: '2-digit',
  };
  if (timeZone) options.timeZone = String(timeZone);
  return date.toLocaleTimeString('es-MX', options);
}

function _pickFirstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function _truncateText(value, maxLen = 400) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function _sanitizeTextArray(values, maxItems = 8, maxLen = 220) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => _truncateText(value, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function _collectAppointmentCustomerData(variables, cfg = {}) {
  const nombre = _pickFirstNonEmpty(
    variables.nombre,
    variables.name,
    variables.user_name,
    variables.full_name,
    variables.nombre_completo,
    variables.cliente_nombre,
    variables.clienteNombre,
    variables.customer_name,
    variables.customerName,
    cfg.customer_name,
  );

  const cedula = _pickFirstNonEmpty(
    variables.cedula,
    variables.cliente_cedula,
    variables.clienteCedula,
    variables.identificacion,
    variables.identificacion_cliente,
    variables.identification,
    variables.numero_cedula,
    variables.documento,
    cfg.customer_cedula,
  );

  const telefono = _pickFirstNonEmpty(
    variables.telefono,
    variables.phone,
    variables.user_phone,
    variables.cliente_telefono,
    variables.clienteTelefono,
    variables.telefono_contacto,
    variables.telefonoContacto,
    variables.user_key,
    cfg.customer_phone,
  );

  const email = _pickFirstNonEmpty(
    variables.email,
    variables.correo,
    variables.customer_email,
    variables.cliente_email,
    cfg.customer_email,
  );

  const motivo = _pickFirstNonEmpty(
    variables.motivo,
    variables.reason,
    variables.tipo_necesidad,
    variables.subject,
    variables.asunto,
    variables.appointment_reason,
    variables.customer_reason,
  );

  const comentarios = _pickFirstNonEmpty(
    variables.customer_notes,
    variables.notes,
    variables.note,
    variables.comentarios,
    variables.comentario,
    variables.observaciones,
    variables.detalle,
    variables.detalles,
    variables.appointment_notes_summary,
    cfg.customer_notes,
    cfg.notes,
  );

  const direccion = _pickFirstNonEmpty(
    variables.direccion,
    variables.address,
    variables.customer_address,
    variables.cliente_direccion,
  );

  const customerIndications = {
    nombre,
    cedula,
    telefono,
    email,
    motivo,
    comentarios,
    direccion,
  };

  const summaryParts = [
    nombre ? `Nombre: ${nombre}` : '',
    cedula ? `Cedula: ${cedula}` : '',
    telefono ? `Telefono: ${telefono}` : '',
    email ? `Email: ${email}` : '',
    motivo ? `Motivo: ${motivo}` : '',
    comentarios ? `Comentarios: ${comentarios}` : '',
    direccion ? `Direccion: ${direccion}` : '',
  ].filter(Boolean);

  const contextParts = [
    variables.last_user_message,
    variables.last_user_input,
    variables.user_message,
    variables.latest_message,
    variables.resumen,
    variables.summary,
    variables.descripcion,
    variables.description,
    variables.observaciones,
  ]
    .map((value) => _truncateText(value, 600))
    .filter(Boolean);

  return {
    customerIndications,
    appointmentNotesSummary: _truncateText(summaryParts.join(' | '), 1000),
    contextText: _truncateText(contextParts.join(' || '), 1200),
  };
}

async function _buildAppointmentLlmEnhancement({ tenantId, llmService, payload }) {
  if (!llmService || !tenantId || !payload) return null;

  const hasBaseSignal = String(payload?.appointmentNotesSummary || '').trim().length > 0
    || String(payload?.contextText || '').trim().length > 0;
  if (!hasBaseSignal) return null;

  const systemPrompt = [
    'Eres un asistente de calidad para agendas medicas/comerciales.',
    'Resume TODO lo indicado por el cliente para una cita.',
    'Devuelve SOLO JSON valido con estructura:',
    '{"resumen":"string","detalles_relevantes":["..."],"faltantes":["..."]}',
    'No inventes datos.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    customer_indications: payload.customerIndications,
    appointment_notes_summary: payload.appointmentNotesSummary,
    extra_context: payload.contextText,
  });

  try {
    const result = await llmService.callLlmForJson(tenantId, systemPrompt, userPrompt);
    const json = result?.json;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

    const summary = _truncateText(json.resumen, 1200);
    const relevant = _sanitizeTextArray(json.detalles_relevantes, 10, 240);
    const missing = _sanitizeTextArray(json.faltantes, 10, 180);

    return {
      appointment_llm_summary: summary || null,
      appointment_llm_relevant_details: relevant,
      appointment_llm_missing_data: missing,
    };
  } catch (err) {
    logger.warn(
      { tenantId, message: err.message },
      'calendar node: failed to enrich appointment metadata with llm'
    );
    return null;
  }
}

async function _buildAppointmentMetadata({ tenantId, llmService, variables, cfg }) {
  const collected = _collectAppointmentCustomerData(variables, cfg);
  const baseMetadata = {
    user_name: collected.customerIndications.nombre || null,
    appointment_customer_cedula: collected.customerIndications.cedula || null,
    user_phone: collected.customerIndications.telefono || null,
    user_email: collected.customerIndications.email || null,
    customer_reason: collected.customerIndications.motivo || null,
    customer_notes: collected.customerIndications.comentarios || null,
    customer_address: collected.customerIndications.direccion || null,
    appointment_notes_summary: collected.appointmentNotesSummary || null,
    customer_indications: collected.customerIndications,
  };

  const useLlm = _coerceBoolean(
    cfg.llm_enhance_metadata ?? cfg.use_llm_for_appointment_metadata ?? true,
    true,
  );

  if (!useLlm) return baseMetadata;

  const llmEnhancement = await _buildAppointmentLlmEnhancement({
    tenantId,
    llmService,
    payload: collected,
  });

  if (!llmEnhancement) return baseMetadata;
  return { ...baseMetadata, ...llmEnhancement };
}

// ─────────────────────────────────────────────────────────────────────────────
// waba_flow — send a native Meta WhatsApp Flow interactive message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * executeWabaFlow
 *
 * Node config shape:
 *   {
 *     meta_flow_id    : string  — Meta-assigned numeric Flow ID (required)
 *     flow_cta        : string  — CTA button label (max 20 chars)
 *     body_text       : string  — Message body shown above the button
 *     header_text     : string  — Optional header text
 *     footer_text     : string  — Optional footer text
 *     initial_screen  : string  — Screen name to open (default: "INIT")
 *   }
 *
 * Emits content:
 *   { type: 'waba_flow', flow_id, flow_cta, body_text, header_text, footer_text, initial_screen }
 */
async function executeWabaFlow({ node, variables }) {
  const cfg = node.config ?? node.data ?? {};
  const resolved = resolveConfig(cfg, variables);

  const flowId = String(resolved.meta_flow_id ?? resolved.flow_id ?? '').trim();
  if (!flowId) {
    logger.warn({ nodeId: node.id }, 'nodeExecutors.waba_flow: meta_flow_id is missing — skipping node');
    return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
  }

  const output = {
    type: 'waba_flow',
    flow_id:        flowId,
    flow_cta:       String(resolved.flow_cta     ?? 'Abrir').trim().slice(0, 20) || 'Abrir',
    body_text:      String(resolved.body_text    ?? resolved.text ?? ' ').trim() || ' ',
    header_text:    resolved.header_text   ? String(resolved.header_text).trim()  : undefined,
    footer_text:    resolved.footer_text   ? String(resolved.footer_text).trim()  : undefined,
    initial_screen: resolved.initial_screen ? String(resolved.initial_screen).trim() : undefined,
  };

  return {
    output,
    nextNodeId: node.next,
    updatedVars: {},
    terminal: false,
    fallback: false,
  };
}

const EXECUTORS = {
  start      : executeStart,
  message    : executeMessage,
  menu       : executeMenu,
  input      : executeInput,
  condition  : executeCondition,
  action     : executeAction,
  task       : executeTask,
  llm        : executeLlm,
  delay      : executeDelay,
  end        : executeEnd,
  handoff    : executeHandoff,
  calendar   : executeCalendar,
  waba_flow  : executeWabaFlow,
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
