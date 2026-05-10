/**
 * Canonical node/edge types for the WhatsApp Flow Builder.
 * These types are used across the visual builder (ReactFlow),
 * the transformation engine (UI ↔ Meta JSON), and validation layer.
 */

// ─── Node types ───────────────────────────────────────────────────────────────

export type CanonicalNodeType =
  | 'start'
  | 'screen'
  | 'input'
  | 'condition'
  | 'webhook'
  | 'end';

/** Legacy types still valid in the engine — mapped transparently */
export type LegacyNodeType = 'message' | 'question' | 'action';

export type NodeType = CanonicalNodeType | LegacyNodeType;

// ─── Per-type content schemas ─────────────────────────────────────────────────

export interface StartContent {
  label: string;
}

export interface ScreenContent {
  label: string;
  title: string;
  /** Screen ID must be UPPERCASE_UNDERSCORE (Meta requirement) */
  screenId: string;
  /** Components rendered inside the screen */
  components: MetaComponent[];
  terminal?: boolean;
}

export interface InputContent {
  label: string;
  screenId: string;
  title: string;
  inputType: 'text' | 'number' | 'email' | 'phone' | 'select' | 'date';
  name: string;
  placeholder?: string;
  required?: boolean;
  /** For select type: available options */
  options?: Array<{ id: string; title: string; next?: string }>;
  /** Variable name where the answer is stored: {{user.NAME}} */
  variableName?: string;
}

export interface ConditionContent {
  label: string;
  /** Variable to evaluate, e.g. {{webhook.response.estatus}} */
  variable: string;
  /** Truthy branch label */
  trueLabel?: string;
  /** Falsy/else branch label */
  falseLabel?: string;
}

export interface EndpointMapping {
  /** endpoint id from catalog */
  endpointId: string;
  /** body mapping: { endpointParam: "{{user.variable}}" } */
  body: Record<string, string>;
  /** response mapping: { localVar: "response.field" } */
  responseMapping: Record<string, string>;
}

export interface WebhookContent {
  label: string;
  screenId?: string;
  endpoint: EndpointMapping | null;
  /** Fallback screen ID when webhook fails */
  fallbackScreenId?: string;
}

export interface EndContent {
  label: string;
  message?: string;
}

// Legacy backwards-compat types
export interface LegacyWebhookConfig {
  enabled: boolean;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

export interface LegacyContent {
  label: string;
  body?: string;
  webhook?: LegacyWebhookConfig;
}

export type NodeContent =
  | StartContent
  | ScreenContent
  | InputContent
  | ConditionContent
  | WebhookContent
  | EndContent
  | LegacyContent;

// ─── Edge ─────────────────────────────────────────────────────────────────────

export interface FlowEdgeData {
  condition?: string;
  /** 'true' | 'false' for condition nodes */
  branch?: 'true' | 'false';
  label?: string;
}

// ─── Meta component types (screens) ──────────────────────────────────────────

export interface MetaComponent {
  type: string;
  [key: string]: unknown;
}

export interface MetaScreen {
  id: string;
  title: string;
  terminal?: boolean;
  layout: {
    type: 'SingleColumnLayout';
    children: MetaComponent[];
  };
  /** Data that this screen sends to next action */
  data?: Record<string, unknown>;
}

// ─── Meta Flow JSON (export/import contract) ─────────────────────────────────

export interface MetaFlowJson {
  version: '7.1';
  data_api_version: '3.0';
  /** Maps screen id to list of next screen ids (routing) */
  routing_model: Record<string, string[]>;
  screens: MetaScreen[];
  /** Optional per-screen endpoint config */
  data_channel_uri?: string;
}

// ─── Endpoint catalog ─────────────────────────────────────────────────────────

export interface EndpointDef {
  id: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  inputs: string[];
  outputs: string[];
  description?: string;
  /** If true, this endpoint is called automatically at the start of every conversation to populate session variables */
  sessionInit?: boolean;
}

export interface EndpointCatalog {
  endpoints: EndpointDef[];
}

// ─── Motor response types ─────────────────────────────────────────────────────

export type MotorAction =
  | 'parse_flow'
  | 'add_node'
  | 'add_webhook'
  | 'export_json'
  | 'validate';

export interface ParseFlowResult {
  action: 'parse_flow';
  nodes: import('reactflow').Node[];
  edges: import('reactflow').Edge[];
  startNodeId?: string;
  explanation: string;
  diagnostics: FlowDiagnostic[];
}

export interface ExportFlowResult {
  action: 'export_json';
  json: MetaFlowJson;
  validation: {
    errors: FlowDiagnostic[];
    warnings: FlowDiagnostic[];
  };
  explanation: string;
}

export interface FlowDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  nodeId?: string;
  field?: string;
  fix?: string;
}

// ─── Node visual metadata (colors, icons) ────────────────────────────────────

export const NODE_META: Record<CanonicalNodeType, { color: string; bg: string; label: string }> = {
  start:     { color: '#16a34a', bg: '#dcfce7', label: 'Inicio' },
  screen:    { color: '#2563eb', bg: '#dbeafe', label: 'Pantalla' },
  input:     { color: '#7c3aed', bg: '#ede9fe', label: 'Entrada' },
  condition: { color: '#d97706', bg: '#fef3c7', label: 'Condición' },
  webhook:   { color: '#0891b2', bg: '#cffafe', label: 'Webhook' },
  end:       { color: '#dc2626', bg: '#fee2e2', label: 'Fin' },
};

/** Map legacy node types to their canonical equivalent for rendering */
export const LEGACY_TYPE_MAP: Record<LegacyNodeType, CanonicalNodeType> = {
  message:  'screen',
  question: 'input',
  action:   'webhook',
};

export function resolveNodeType(type: NodeType): CanonicalNodeType {
  if (type in LEGACY_TYPE_MAP) return LEGACY_TYPE_MAP[type as LegacyNodeType];
  return type as CanonicalNodeType;
}

// ─── Canvas position data ─────────────────────────────────────────────────────

export interface Position {
  x: number;
  y: number;
}

export type PositionMap = Record<string, Position>;

// ─── Flow definition (internal format) ────────────────────────────────────────

export interface NodeDef {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next?: string | null;
  branches?: Record<string, string>;
  parentId?: string | null;
  children?: NodeDef[];
  ui?: {
    collapsed?: boolean;
  };
}

export interface FlowDefinition {
  version?: string;
  entry_point: string;
  nodes: NodeDef[];
  /** Node positions for canvas rendering (x, y coordinates) */
  nodePositions?: PositionMap;
  variables?: Record<string, unknown>;
  integrations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ─── ReactFlow node & edge types ──────────────────────────────────────────────

export interface NodeData {
  id: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  next?: string | null;
  branches?: Record<string, string>;
  parentId?: string | null;
  hierarchy?: {
    depth: number;
    childCount: number;
    isParent: boolean;
    isChild: boolean;
  };
}

/**
 * Extended ReactFlow types for better type safety.
 * Re-export from reactflow with our custom data types.
 */
export type FlowNode = import('reactflow').Node<NodeData>;
export type FlowEdge = import('reactflow').Edge<FlowEdgeData>;
