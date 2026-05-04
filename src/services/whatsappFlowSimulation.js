'use strict';

function setPath(obj, path, value) {
  const keys = String(path).split('.').filter(Boolean);
  if (keys.length === 0) return;
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

function flattenComponents(children, acc = []) {
  if (!Array.isArray(children)) return acc;
  children.forEach((component) => {
    if (!component || typeof component !== 'object') return;
    acc.push(component);
    if (Array.isArray(component.children)) flattenComponents(component.children, acc);
  });
  return acc;
}

function summarizeCondition(condition) {
  const raw = String(condition || 'always').trim();
  if (!raw || raw === 'always') {
    return { raw: 'always', label: 'Siempre (continuar)' };
  }

  const simpleEq = raw.match(/^([a-zA-Z_][\w.]*)\s*==\s*['"]([^'"]+)['"]$/);
  if (simpleEq) {
    return {
      raw,
      variable: simpleEq[1],
      expectedValue: simpleEq[2],
      label: `${simpleEq[1]} = "${simpleEq[2]}"`,
    };
  }

  return { raw, label: raw };
}

function buildExpectedResponseShape(responseMapping) {
  const mapping = responseMapping && typeof responseMapping === 'object' ? responseMapping : {};
  const example = {};
  Object.keys(mapping).forEach((sourcePath) => {
    setPath(example, sourcePath, '<valor>');
  });
  return example;
}

function normalizeContentLines(content, title) {
  if (typeof content === 'string') return [content];
  if (!content || typeof content !== 'object') return title ? [title] : [];

  const lines = [];
  if (content.text) lines.push(String(content.text));
  if (content.body) lines.push(String(content.body));
  if (content.message) lines.push(String(content.message));
  if (lines.length === 0 && content.label) lines.push(String(content.label));
  if (lines.length === 0 && title) lines.push(String(title));
  return lines;
}

function buildGenericScreenSimulation(screen) {
  const actions = Array.isArray(screen.actions) ? screen.actions : [];
  const lines = normalizeContentLines(screen.content, screen.title);
  const menu = actions.map((action, index) => {
    const cond = summarizeCondition(action.condition);
    return {
      id: `option_${index + 1}`,
      label: cond.expectedValue || `Opcion ${index + 1}`,
      when: cond,
      nextScreen: action.next_screen || null,
    };
  });

  const actionDetails = actions.map((action, index) => {
    const cond = summarizeCondition(action.condition);
    const webhook = action.webhook && typeof action.webhook === 'object'
      ? {
          call: true,
          method: String(action.webhook.method || 'POST').toUpperCase(),
          url: action.webhook.url || null,
          payloadTemplate: action.webhook.payload || {},
          responseMapping: action.webhook.response_mapping || {},
          shouldRespond: {
            status: '2xx',
            contentType: 'application/json',
            bodyExample: buildExpectedResponseShape(action.webhook.response_mapping),
          },
        }
      : { call: false };

    return {
      id: `action_${index + 1}`,
      when: cond,
      nextScreen: action.next_screen || null,
      webhook,
    };
  });

  return {
    id: screen.id,
    title: screen.title || screen.id,
    type: screen.type || 'message',
    terminal: screen.type === 'terminal' || actions.length === 0,
    userView: {
      bubbles: lines,
      input: screen.input || null,
      menu,
    },
    actions: actionDetails,
  };
}

function buildMetaScreenSimulation(screen) {
  const flat = flattenComponents(screen.layout?.children || []);
  const bubbles = flat
    .filter((component) => ['TextHeading', 'TextSubheading', 'TextBody'].includes(component.type))
    .map((component) => String(component.text || '').trim())
    .filter(Boolean);

  const menu = [];
  const input = [];

  flat.forEach((component) => {
    if (['Dropdown', 'RadioButtonsGroup', 'CheckboxGroup'].includes(component.type)) {
      const ds = Array.isArray(component['data-source']) ? component['data-source'] : [];
      ds.forEach((opt, idx) => {
        menu.push({
          id: opt.id || `${component.type}_${idx + 1}`,
          label: opt.title || opt.id || `Opcion ${idx + 1}`,
          source: component.type,
        });
      });
    }

    if (['TextInput', 'TextArea', 'DatePicker'].includes(component.type)) {
      input.push({
        type: component.type,
        name: component.name || null,
        label: component.label || null,
        required: component.required === true,
      });
    }
  });

  const actions = flat
    .filter((component) => component.type === 'Footer')
    .map((footer, index) => {
      const action = footer['on-click-action'] || {};
      const isDataExchange = action.name === 'data_exchange';
      const responseMapping = screen.data?.response_mapping || {};
      return {
        id: `action_${index + 1}`,
        label: footer.label || `Accion ${index + 1}`,
        nextScreen: action.next?.name || null,
        webhook: isDataExchange
          ? {
              call: true,
              method: 'POST',
              urlHint: '/whatsapp/flows',
              payloadTemplate: {
                screen: screen.id,
                data: '<datos de formulario/seleccion>',
              },
              responseMapping,
              shouldRespond: {
                status: '2xx',
                contentType: 'application/json',
                bodyExample: Object.keys(responseMapping).length > 0
                  ? buildExpectedResponseShape(responseMapping)
                  : { screen: '<NEXT_SCREEN_ID>', data: {} },
              },
            }
          : { call: false },
      };
    });

  return {
    id: screen.id,
    title: screen.title || screen.id,
    type: screen.terminal ? 'terminal' : 'screen',
    terminal: screen.terminal === true,
    userView: {
      bubbles: bubbles.length > 0 ? bubbles : [screen.title || screen.id],
      input,
      menu,
    },
    actions,
  };
}

function inferFormat(flowJson) {
  const screens = Array.isArray(flowJson?.screens) ? flowJson.screens : [];
  if (screens.length === 0) return 'unknown';
  if (screens.some((s) => Array.isArray(s.actions))) return 'generic';
  if (screens.some((s) => s.layout && typeof s.layout === 'object')) return 'meta';
  return 'unknown';
}

function buildWhatsAppSimulation({ flow, flowJson }) {
  const format = inferFormat(flowJson);
  const screens = Array.isArray(flowJson?.screens) ? flowJson.screens : [];

  const items = screens.map((screen) => {
    if (format === 'generic') return buildGenericScreenSimulation(screen);
    if (format === 'meta') return buildMetaScreenSimulation(screen);
    return {
      id: screen.id || 'unknown',
      title: screen.title || screen.id || 'Pantalla',
      type: screen.type || 'screen',
      terminal: Boolean(screen.terminal),
      userView: {
        bubbles: normalizeContentLines(screen.content, screen.title),
        input: null,
        menu: [],
      },
      actions: [],
    };
  });

  const webhookActions = items.flatMap((screen) =>
    (screen.actions || [])
      .filter((action) => action.webhook?.call)
      .map((action) => ({ screenId: screen.id, actionId: action.id, webhook: action.webhook }))
  );

  return {
    flow: {
      id: flow.id,
      nombre: flow.nombre,
      version: flow.version,
      format,
    },
    summary: {
      screens: items.length,
      terminalScreens: items.filter((s) => s.terminal).length,
      actions: items.reduce((sum, s) => sum + (s.actions?.length || 0), 0),
      webhookCalls: webhookActions.length,
    },
    screens: items,
    webhookCalls: webhookActions,
  };
}

module.exports = {
  buildWhatsAppSimulation,
  buildExpectedResponseShape,
  inferFormat,
};