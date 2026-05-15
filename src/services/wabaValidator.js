'use strict';
/**
 * WABA Validator — deterministic + LLM-enhanced rescue engine.
 *
 * Two layers:
 *   1. Rule-based: covers ~80% of Meta WhatsApp Flows JSON errors deterministically
 *      (no LLM needed, instant, 100% confidence on matched rules).
 *   2. LLM-enhanced: for unknown or complex errors, calls the tenant LLM and returns
 *      a suggested fix with lower confidence.
 *
 * WABA Flow JSON expected shape (Meta API v3.x - v7.x):
 * {
 *   "version": "6.1",
 *   "screens": [
 *     {
 *       "id": "SCREEN_ID",
 *       "title": "...",
 *       "layout": { "type": "SingleColumnLayout", "children": [...] }
 *     }
 *   ]
 * }
 */

const { callLlmForJson } = require('./llmService');
const logger = require('../utils/logger');

// ─── Known WABA error codes ────────────────────────────────────────────────────

const WABA_ERROR_CODES = {
  100 : 'Invalid parameter',
  200 : 'Permissions error',
  4   : 'Application request limit reached',
  10  : 'Application does not have permission',
  190 : 'Invalid/expired access token',
  // WhatsApp Flows specific (1xxx range)
  1000: 'Flow validation error',
  1001: 'Flow JSON syntax error',
  1002: 'Flow schema validation error',
  1003: 'Flow screen ID invalid',
  1004: 'Flow component type invalid',
  1005: 'Flow required field missing',
  1006: 'Flow version not supported',
  1007: 'Flow text length exceeded',
  1008: 'Flow buttons count exceeded',
  1009: 'Flow dropdown options exceeded',
  1010: 'Flow variable reference undefined',
  1011: 'Flow circular navigation detected',
  1012: 'Flow INIT screen missing',
  131009: 'Parameter value is not valid',
};

// ─── Validation rules ─────────────────────────────────────────────────────────

const VALID_SCREEN_ID = /^[A-Z0-9_]+$/;
const VALID_COMPONENT_TYPES = new Set([
  'TextHeading', 'TextSubheading', 'TextBody', 'TextCaption',
  'TextInput', 'TextArea', 'DatePicker', 'CheckboxGroup', 'RadioButtonsGroup',
  'Dropdown', 'Footer', 'Image', 'EmbeddedLink', 'Form', 'OptIn',
  'NavigationList', 'RichText', 'PhotoPicker', 'DocumentPicker',
]);
const VALID_LAYOUT_TYPES = new Set(['SingleColumnLayout']);
const VALID_VERSIONS = new Set(['3.0', '3.1', '4.0', '5.0', '5.1', '6.0', '6.1', '7.0', '7.1']);

const MAX_BUTTONS = 3;
const MAX_DROPDOWN_OPTIONS = 300;
const MAX_TEXT_HEADING = 80;
const MAX_TEXT_BODY = 4096;
const MAX_FOOTER_LABEL = 35;
const MAX_TITLE = 24;
const MAX_SCREENS = 50;

// ─── Structural validator ─────────────────────────────────────────────────────

/**
 * Run deterministic validation on a WABA Flow JSON object.
 * @param {object} flow  Parsed JSON (already an object, not a string)
 * @returns {{ valid: boolean, errors: array, warnings: array }}
 */
function validateWabaJson(flow) {
  const errors   = [];
  const warnings = [];

  if (typeof flow !== 'object' || flow === null || Array.isArray(flow)) {
    errors.push({ code: 'INVALID_ROOT', message: 'Root must be a JSON object', field: '$' });
    return { valid: false, errors, warnings };
  }

  // version
  if (!flow.version) {
    errors.push({ code: 'MISSING_VERSION', message: 'Field "version" is required (e.g. "6.1")', field: 'version', fix: 'Add "version": "6.1"' });
  } else if (!VALID_VERSIONS.has(String(flow.version))) {
    warnings.push({ code: 'UNKNOWN_VERSION', message: `Version "${flow.version}" is not in the known set ${[...VALID_VERSIONS].join(', ')}`, field: 'version' });
  }

  // screens
  if (!Array.isArray(flow.screens) || flow.screens.length === 0) {
    errors.push({ code: 'MISSING_SCREENS', message: '"screens" must be a non-empty array', field: 'screens', fix: 'Add at least one screen object inside "screens"' });
    return { valid: false, errors, warnings };
  }

  if (flow.screens.length > MAX_SCREENS) {
    errors.push({ code: 'TOO_MANY_SCREENS', message: `Exceeded max ${MAX_SCREENS} screens`, field: 'screens' });
  }

  // INIT screen check (screen with id "INIT" or the first terminal screen)
  const screenIds = flow.screens.map((s) => s?.id);
  if (!screenIds.includes('INIT') && !screenIds.includes('WELCOME') && !screenIds.includes('START')) {
    warnings.push({ code: 'NO_INIT_SCREEN', message: 'Consider naming your first screen "INIT" for clarity' });
  }

  // routing_model connectivity check
  if (flow.routing_model && typeof flow.routing_model === 'object' && !Array.isArray(flow.routing_model)) {
    const routingKeys = Object.keys(flow.routing_model);
    const entryScreen = screenIds[0]; // first screen is the entry point

    // BFS to find all reachable screens from entry
    const reachable = new Set();
    const queue = entryScreen ? [entryScreen] : [];
    while (queue.length) {
      const current = queue.shift();
      if (reachable.has(current)) continue;
      reachable.add(current);
      const neighbors = flow.routing_model[current];
      if (Array.isArray(neighbors)) {
        neighbors.forEach((n) => { if (!reachable.has(n)) queue.push(n); });
      }
    }

    // Every screen in routing_model must be reachable from entry
    const disconnected = routingKeys.filter((k) => !reachable.has(k));
    if (disconnected.length > 0) {
      disconnected.forEach((screenId) => {
        const idx = screenIds.indexOf(screenId);
        errors.push({
          code: 'DISCONNECTED_SCREEN',
          message: `Screen "${screenId}" is not reachable from the entry screen. All screens must be connected.`,
          field: idx >= 0 ? `screens[${idx}].id` : `routing_model.${screenId}`,
          fix: `Either remove screen "${screenId}" from both "screens" and "routing_model", or add a navigation to it from an existing screen.`,
          disconnected_screens: disconnected,
        });
      });
    }

    // Every screen in the screens array should also be in routing_model
    screenIds.forEach((sid, idx) => {
      if (sid && !Object.prototype.hasOwnProperty.call(flow.routing_model, sid)) {
        warnings.push({
          code: 'SCREEN_NOT_IN_ROUTING_MODEL',
          message: `Screen "${sid}" is present in "screens" but missing from "routing_model"`,
          field: `screens[${idx}].id`,
          fix: `Add "${sid}" as a key in "routing_model" with its list of reachable screens (empty array [] if terminal)`,
        });
      }
    });
  }

  flow.screens.forEach((screen, idx) => {
    const prefix = `screens[${idx}]`;

    // id
    if (!screen.id) {
      errors.push({ code: 'MISSING_SCREEN_ID', message: `Screen at index ${idx} is missing "id"`, field: `${prefix}.id`, fix: 'Add an uppercase string id, e.g. "WELCOME"' });
    } else if (!VALID_SCREEN_ID.test(screen.id)) {
      errors.push({
        code: 'INVALID_SCREEN_ID',
        message: `Screen id "${screen.id}" contains invalid characters. Only uppercase letters, digits and underscores are allowed.`,
        field: `${prefix}.id`,
        fix: `Rename to "${screen.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}"`,
        suggested_value: screen.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      });
    }

    // title
    if (screen.title && screen.title.length > MAX_TITLE) {
      warnings.push({ code: 'TITLE_TOO_LONG', message: `Screen "${screen.id}" title exceeds ${MAX_TITLE} chars (${screen.title.length})`, field: `${prefix}.title`, fix: `Shorten title to max ${MAX_TITLE} chars` });
    }

    // layout
    if (!screen.layout) {
      errors.push({ code: 'MISSING_LAYOUT', message: `Screen "${screen.id}" is missing "layout"`, field: `${prefix}.layout`, fix: 'Add "layout": { "type": "SingleColumnLayout", "children": [] }' });
      return;
    }

    if (!VALID_LAYOUT_TYPES.has(screen.layout.type)) {
      errors.push({ code: 'INVALID_LAYOUT_TYPE', message: `Screen "${screen.id}" layout type "${screen.layout.type}" is invalid`, field: `${prefix}.layout.type`, fix: `Use "SingleColumnLayout"`, suggested_value: 'SingleColumnLayout' });
    }

    if (!Array.isArray(screen.layout.children)) {
      errors.push({ code: 'MISSING_LAYOUT_CHILDREN', message: `Screen "${screen.id}" layout.children must be an array`, field: `${prefix}.layout.children` });
      return;
    }

    // children components
    validateComponents(screen.layout.children, screen.id, `${prefix}.layout.children`, errors, warnings);

    // terminal screens must have a Footer or navigation action
    const hasFooter = flatComponents(screen.layout.children).some((c) => c.type === 'Footer');
    if (!hasFooter && screen.terminal !== true) {
      warnings.push({ code: 'NO_FOOTER', message: `Screen "${screen.id}" has no Footer component — users may not be able to proceed`, field: `${prefix}.layout.children` });
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

function validateComponents(components, screenId, path, errors, warnings) {
  if (!Array.isArray(components)) return;

  components.forEach((comp, idx) => {
    const cPath = `${path}[${idx}]`;
    if (!comp || typeof comp !== 'object') return;

    // type check
    if (!comp.type) {
      errors.push({ code: 'MISSING_COMPONENT_TYPE', message: `Component at ${cPath} in screen "${screenId}" is missing "type"`, field: `${cPath}.type` });
      return;
    }
    if (!VALID_COMPONENT_TYPES.has(comp.type)) {
      errors.push({ code: 'INVALID_COMPONENT_TYPE', message: `Component type "${comp.type}" at ${cPath} is not valid`, field: `${cPath}.type`, fix: `Valid types: ${[...VALID_COMPONENT_TYPES].join(', ')}` });
    }

    // Footer label length
    if (comp.type === 'Footer' && comp.label && comp.label.length > MAX_FOOTER_LABEL) {
      warnings.push({ code: 'FOOTER_LABEL_TOO_LONG', message: `Footer label at ${cPath} exceeds ${MAX_FOOTER_LABEL} chars`, field: `${cPath}.label` });
    }

    // TextHeading length
    if (comp.type === 'TextHeading' && comp.text && comp.text.length > MAX_TEXT_HEADING) {
      warnings.push({ code: 'HEADING_TOO_LONG', message: `TextHeading at ${cPath} exceeds ${MAX_TEXT_HEADING} chars`, field: `${cPath}.text` });
    }

    // Dropdown options count
    if (comp.type === 'Dropdown' && Array.isArray(comp['data-source']) && comp['data-source'].length > MAX_DROPDOWN_OPTIONS) {
      errors.push({ code: 'TOO_MANY_DROPDOWN_OPTIONS', message: `Dropdown at ${cPath} exceeds max ${MAX_DROPDOWN_OPTIONS} options`, field: `${cPath}.data-source` });
    }

    // Recurse into Form children
    if (comp.type === 'Form' && Array.isArray(comp.children)) {
      validateComponents(comp.children, screenId, `${cPath}.children`, errors, warnings);
    }

    // Button count in RadioButtonsGroup / CheckboxGroup
    if ((comp.type === 'RadioButtonsGroup' || comp.type === 'CheckboxGroup') &&
        Array.isArray(comp['data-source']) && comp['data-source'].length > MAX_BUTTONS) {
      warnings.push({ code: 'MANY_RADIO_OPTIONS', message: `${comp.type} at ${cPath} has ${comp['data-source'].length} options (recommended max ${MAX_BUTTONS} for UX)`, field: `${cPath}.data-source` });
    }
  });
}

function flatComponents(children, result = []) {
  if (!Array.isArray(children)) return result;
  children.forEach((c) => {
    if (!c) return;
    result.push(c);
    if (c.type === 'Form' && Array.isArray(c.children)) flatComponents(c.children, result);
  });
  return result;
}

// ─── WABA error parser ────────────────────────────────────────────────────────

/**
 * Parse a raw WABA error (string or object) into a structured diagnosis.
 * @param {string|object} rawError
 * @returns {{ code: number|null, message: string, detail: string|null, blame_fields: string[], severity: 'blocking'|'warning' }}
 */
function parseWabaError(rawError) {
  let parsed = rawError;
  if (typeof rawError === 'string') {
    try { parsed = JSON.parse(rawError); } catch { /* use as message string */ }
  }

  if (typeof parsed === 'string') {
    return { code: null, message: parsed, detail: null, blame_fields: [], severity: 'blocking' };
  }

  // Meta error envelope: { error: { message, type, code, error_data: { details, blame_field_specs } } }
  const err = parsed?.error || parsed;
  const code = err?.code ?? null;
  const message = err?.message || WABA_ERROR_CODES[code] || 'Unknown WABA error';
  const detail = err?.error_data?.details || err?.error_subcode || null;
  const blameRaw = err?.error_data?.blame_field_specs || [];
  const blame_fields = blameRaw.flat ? blameRaw.flat() : blameRaw;

  return {
    code,
    message,
    detail,
    blame_fields,
    severity: 'blocking',
  };
}

// ─── Deterministic fixer ──────────────────────────────────────────────────────

/**
 * Apply deterministic fixes based on known validation errors.
 * Returns { fixedJson, changes } or null if no deterministic fix is applicable.
 */
function applyDeterministicFixes(flow, structuralErrors) {
  if (!structuralErrors.length) return null;

  let fixed = JSON.parse(JSON.stringify(flow)); // deep clone
  const changes = [];

  for (const err of structuralErrors) {
    switch (err.code) {
      case 'MISSING_VERSION':
        fixed.version = '6.1';
        changes.push({ field: 'version', before: undefined, after: '6.1', reason: err.message });
        break;

      case 'INVALID_SCREEN_ID': {
        const screen = fixed.screens?.find((s) => s.id === err.field.match(/screens\[(\d+)\]/)?.[0]?.replace('screens[', '').replace(']', '') !== undefined && s.id && !VALID_SCREEN_ID.test(s.id));
        if (screen && err.suggested_value) {
          const before = screen.id;
          screen.id = err.suggested_value;
          // Also update references in on_click_action targets
          fixed.screens.forEach((s) => {
            flatComponents(s.layout?.children || []).forEach((c) => {
              if (c?.on_click_action?.navigate?.screen === before) {
                c.on_click_action.navigate.screen = err.suggested_value;
              }
            });
          });
          changes.push({ field: err.field, before, after: err.suggested_value, reason: err.message });
        }
        break;
      }

      case 'INVALID_LAYOUT_TYPE': {
        const idx = parseInt(err.field.match(/screens\[(\d+)\]/)?.[1] ?? '-1');
        if (idx >= 0 && fixed.screens[idx]?.layout) {
          const before = fixed.screens[idx].layout.type;
          fixed.screens[idx].layout.type = 'SingleColumnLayout';
          changes.push({ field: err.field, before, after: 'SingleColumnLayout', reason: err.message });
        }
        break;
      }

      case 'DISCONNECTED_SCREEN': {
        // Remove all disconnected screens from both screens[] and routing_model
        const toRemove = new Set(err.disconnected_screens || []);
        if (toRemove.size > 0) {
          const before = fixed.screens.map((s) => s.id);
          fixed.screens = fixed.screens.filter((s) => !toRemove.has(s.id));
          toRemove.forEach((sid) => {
            if (fixed.routing_model) delete fixed.routing_model[sid];
          });
          changes.push({
            field: 'screens + routing_model',
            before: before.join(', '),
            after: fixed.screens.map((s) => s.id).join(', '),
            reason: `Removed disconnected screens: ${[...toRemove].join(', ')}`,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return changes.length ? { fixedJson: fixed, changes } : null;
}

// ─── LLM system prompt ────────────────────────────────────────────────────────

const LLM_SYSTEM_PROMPT = `You are an expert in Meta WhatsApp Flows JSON validation and repair.
Your task is to analyze a WABA Flow JSON and a WABA error, then return a corrected JSON.

Rules:
- Return ONLY the corrected JSON object, no explanation, no markdown fences.
- Apply the minimal patch needed to fix the error.
- Preserve all business logic and flow intent.
- Do not invent fields or components not present in the original.
- Ensure all screen IDs are UPPERCASE_UNDERSCORE (A-Z, 0-9, _ only).
- "version" must be a string like "6.1".
- "screens" must be a non-empty array.
- Each screen must have "id", "title" and "layout" with "type": "SingleColumnLayout".
- layout.children must be a valid array of components.`;

// ─── Main rescue pipeline ─────────────────────────────────────────────────────

/**
 * Full rescue pipeline: validate → deterministic fix → LLM fix → score.
 *
 * @param {object} opts
 * @param {object|string} opts.originalJson   Raw flow JSON (string or object)
 * @param {object|string} opts.wabaError      Raw WABA error (string or object)
 * @param {string}        opts.tenantId
 * @returns {Promise<RescueResult>}
 *
 * @typedef {object} RescueResult
 * @property {boolean}       success
 * @property {object}        diagnosis
 * @property {object|null}   fixedJson
 * @property {object[]}      changes
 * @property {number}        confidenceScore   0-100
 * @property {boolean}       llmUsed
 * @property {string[]}      residualRisks
 * @property {string|null}   probableNextError
 * @property {string}        status           'fixed'|'partial'|'failed'|'manual_review'
 */
async function rescueFlow({ originalJson, wabaError, tenantId }) {
  // 1. Parse input JSON
  let flow;
  if (typeof originalJson === 'string') {
    try {
      flow = JSON.parse(originalJson);
    } catch (parseErr) {
      const diagnosis = {
        root_cause: 'JSON syntax error — the input is not valid JSON',
        error_code : null,
        blame_fields: [],
        structural_errors: [{ code: 'JSON_PARSE_ERROR', message: parseErr.message, fix: 'Fix JSON syntax: check for missing commas, unclosed brackets or unescaped strings' }],
        waba_error: parseWabaError(wabaError),
      };
      return {
        success: false, diagnosis, fixedJson: null, changes: [], confidenceScore: 0,
        llmUsed: false, residualRisks: ['JSON must be repaired manually before any automated fix'], probableNextError: null, status: 'failed',
      };
    }
  } else {
    flow = originalJson;
  }

  // 2. Parse WABA error
  const parsedError = parseWabaError(wabaError);

  // 3. Run structural validation
  const { errors: structuralErrors, warnings } = validateWabaJson(flow);

  const diagnosis = {
    root_cause   : parsedError.message,
    error_code   : parsedError.code,
    blame_fields : parsedError.blame_fields,
    detail       : parsedError.detail,
    structural_errors: structuralErrors,
    warnings,
    waba_error   : parsedError,
  };

  // 4. Deterministic fix
  const deterministicResult = applyDeterministicFixes(flow, structuralErrors);
  let fixedJson = deterministicResult?.fixedJson ?? null;
  let changes   = deterministicResult?.changes   ?? [];
  let llmUsed   = false;

  // Compute base confidence (deterministic)
  const totalIssues   = structuralErrors.length;
  const fixedIssues   = changes.length;
  let confidenceScore = totalIssues === 0 ? 95 : Math.round((fixedIssues / totalIssues) * 90);

  // 5. LLM enhancement — call when: issues remain unfixed OR error is unknown/complex
  const hasUnfixedIssues = totalIssues > fixedIssues;
  const isUnknownError   = !parsedError.code || !WABA_ERROR_CODES[parsedError.code];

  if (hasUnfixedIssues || isUnknownError) {
    const userPrompt = buildLlmUserPrompt(fixedJson ?? flow, wabaError, diagnosis);

    try {
      const llmResult = await callLlmForJson(tenantId, LLM_SYSTEM_PROMPT, userPrompt);
      if (llmResult) {
        const llmChanges = buildChangeDiff(fixedJson ?? flow, llmResult.json);
        fixedJson = llmResult.json;
        changes   = [...changes, ...llmChanges];
        llmUsed   = true;
        confidenceScore = Math.min(85, confidenceScore + 35);
        logger.info({ tenantId, provider: llmResult.provider, model: llmResult.model }, 'llmService: rescue enhanced by LLM');
      }
    } catch (err) {
      logger.warn({ tenantId, err: err.message }, 'llmService: LLM call failed, proceeding with deterministic result');
    }
  }

  // 6. Residual risk assessment
  const residualRisks = [];
  if (!llmUsed && hasUnfixedIssues) {
    residualRisks.push(`${totalIssues - fixedIssues} issue(s) could not be fixed automatically — manual review required`);
  }
  if (warnings.length > 0) {
    residualRisks.push(`${warnings.length} warning(s) detected that may cause UX issues`);
  }
  if (!fixedJson) {
    residualRisks.push('No corrected JSON was produced — original has critical structural problems');
  }

  // 7. Final validation of the fixed JSON
  let probableNextError = null;
  if (fixedJson) {
    const { errors: postErrors } = validateWabaJson(fixedJson);
    if (postErrors.length > 0) {
      probableNextError = postErrors[0].message;
      confidenceScore = Math.max(0, confidenceScore - 15);
    } else {
      confidenceScore = Math.min(100, confidenceScore + 5);
    }
  }

  const status = !fixedJson
    ? 'failed'
    : (probableNextError ? 'partial' : (residualRisks.length > 0 ? 'manual_review' : 'fixed'));

  return {
    success: status === 'fixed' || status === 'partial',
    diagnosis,
    fixedJson,
    changes,
    confidenceScore,
    llmUsed,
    residualRisks,
    probableNextError,
    status,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildLlmUserPrompt(flow, wabaError, diagnosis) {
  return [
    '## WABA Error',
    typeof wabaError === 'string' ? wabaError : JSON.stringify(wabaError, null, 2),
    '',
    '## Structural Issues Found',
    JSON.stringify(diagnosis.structural_errors, null, 2),
    '',
    '## Original Flow JSON',
    JSON.stringify(flow, null, 2),
  ].join('\n');
}

function buildChangeDiff(original, fixed) {
  if (!original || !fixed) return [];
  const changes = [];
  // Screen-level diff
  const origScreens = original.screens || [];
  const fixedScreens = fixed.screens || [];

  fixedScreens.forEach((fs, i) => {
    const os = origScreens[i];
    if (!os) { changes.push({ field: `screens[${i}]`, before: null, after: fs.id, reason: 'Screen added by LLM' }); return; }
    if (fs.id !== os.id) changes.push({ field: `screens[${i}].id`, before: os.id, after: fs.id, reason: 'Screen ID corrected' });
    if (fs.title !== os.title) changes.push({ field: `screens[${i}].title`, before: os.title, after: fs.title, reason: 'Title corrected' });
    if (fs.layout?.type !== os.layout?.type) changes.push({ field: `screens[${i}].layout.type`, before: os.layout?.type, after: fs.layout?.type, reason: 'Layout type corrected' });
  });

  if (original.version !== fixed.version) {
    changes.push({ field: 'version', before: original.version, after: fixed.version, reason: 'Version corrected by LLM' });
  }

  return changes;
}

module.exports = { validateWabaJson, parseWabaError, rescueFlow };
