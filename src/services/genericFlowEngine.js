'use strict';

/**
 * Generic flow engine using the JSON structure:
 * {
 *   flow_name: string,
 *   screens: [{ id, type, title, content, input?, actions: [{ condition, next_screen, webhook? }] }]
 * }
 */

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  const keys = String(path).split('.');
  let cursor = obj;
  for (const key of keys) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

function parseLiteral(raw, variables) {
  const value = String(raw).trim();
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);

  const quoted = value.match(/^'(.*)'$|^"(.*)"$/);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';

  return getPath(variables, value);
}

function evaluateAtomic(condition, variables) {
  const expr = String(condition || '').trim();
  if (!expr || expr === 'always') return true;

  const binary = expr.match(/^([a-zA-Z_][\w.]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (binary) {
    const [, leftPath, op, rightRaw] = binary;
    const left = getPath(variables, leftPath);
    const right = parseLiteral(rightRaw, variables);

    switch (op) {
      case '==': return left === right;
      case '!=': return left !== right;
      case '>': return Number(left) > Number(right);
      case '<': return Number(left) < Number(right);
      case '>=': return Number(left) >= Number(right);
      case '<=': return Number(left) <= Number(right);
      default: return false;
    }
  }

  const varValue = getPath(variables, expr);
  return Boolean(varValue);
}

function evaluateCondition(condition, variables) {
  const expr = String(condition || 'always').trim();
  if (!expr || expr === 'always') return true;

  // Support basic OR/AND expressions used in flow actions.
  const orParts = expr.split(/\s*\|\|\s*/);
  return orParts.some((orPart) => {
    const andParts = orPart.split(/\s*&&\s*/);
    return andParts.every((andPart) => evaluateAtomic(andPart, variables));
  });
}

function resolveTemplateString(input, variables) {
  return String(input).replace(/{{\s*([\w.]+)\s*}}/g, (_m, path) => {
    const value = getPath(variables, path);
    return value == null ? '' : String(value);
  });
}

function resolveTemplates(value, variables) {
  if (typeof value === 'string') return resolveTemplateString(value, variables);
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, variables));
  if (value && typeof value === 'object') {
    const next = {};
    for (const [k, v] of Object.entries(value)) next[k] = resolveTemplates(v, variables);
    return next;
  }
  return value;
}

async function executeWebhook(webhook, variables, fetchImpl) {
  const method = String(webhook.method || 'POST').toUpperCase();
  const payload = resolveTemplates(webhook.payload || {}, variables);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let response;
  try {
    response = await fetchImpl(webhook.url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const contentType = response.headers.get('content-type') || '';
  const rawBody = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : { raw: await response.text().catch(() => '') };

  if (!response.ok) {
    const err = new Error(`Webhook failed with status ${response.status}`);
    err.status = response.status;
    err.body = rawBody;
    throw err;
  }

  const mapped = { ...variables };
  for (const [sourcePath, targetPath] of Object.entries(webhook.response_mapping || {})) {
    const sourceValue = getPath(rawBody, sourcePath);
    setPath(mapped, targetPath, sourceValue);
  }

  return { variables: mapped, payload, responseBody: rawBody };
}

async function executeGenericStep({
  flowJson,
  currentScreenId,
  input,
  variables = {},
  businessContext = {},
  fetchImpl = fetch,
}) {
  const screens = Array.isArray(flowJson?.screens) ? flowJson.screens : [];
  if (screens.length === 0) {
    throw new Error('Invalid generic flow: screens[] is required');
  }

  const startScreen = screens[0];
  const screen = screens.find((s) => s.id === currentScreenId) || startScreen;
  const runtimeVars = {
    ...variables,
    business: businessContext,
  };

  if (screen.input?.variable_name && input != null) {
    setPath(runtimeVars, screen.input.variable_name, input);
  }

  const actions = Array.isArray(screen.actions) ? screen.actions : [];
  let selectedAction = null;
  let webhookResult = null;
  let runtimeAfterWebhook = runtimeVars;

  for (const action of actions) {
    if (!evaluateCondition(action.condition || 'always', runtimeAfterWebhook)) continue;

    selectedAction = action;
    if (action.webhook?.url) {
      webhookResult = await executeWebhook(action.webhook, runtimeAfterWebhook, fetchImpl);
      runtimeAfterWebhook = webhookResult.variables;
    }
    break;
  }

  const nextScreenId = selectedAction?.next_screen || null;
  const nextScreen = screens.find((s) => s.id === nextScreenId) || null;
  const terminal = (nextScreen?.type === 'terminal') || !nextScreenId;

  return {
    currentScreenId: screen.id,
    nextScreenId,
    nextScreen,
    matchedCondition: selectedAction?.condition || null,
    variables: runtimeAfterWebhook,
    webhookResult,
    terminal,
  };
}

module.exports = {
  evaluateCondition,
  executeGenericStep,
  resolveTemplates,
};
