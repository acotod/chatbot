"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Upload,
  Download,
  Plus,
  Trash2,
  Edit3,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Play,
  History,
  Webhook,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileJson,
  Layers,
  RotateCcw,
  Send,
  Eye,
  X,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Zap,
} from "lucide-react";
import { wabaFlowsApi, integrationsApi, variablesApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import MenuOptionsEditor from "@/components/flujos/MenuOptionsEditor";
import CanvasEditor from "@/components/FlowBuilder/CanvasEditor";
import { layoutAsHierarchy } from "@/lib/autoLayout";
import { useTranslations } from "next-intl";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface FlowVersion {
  id: number;
  versionNumber: number;
  published: boolean;
  publishedAt?: string;
  changelog?: string;
  wabaValidationStatus: "draft" | "valid" | "invalid" | "exported";
  wabaValidatedAt?: string;
  wabaValidationErrors?: unknown[];
  createdAt: string;
  _count?: { executions: number };
}

interface WabaFlow {
  id: number;
  nombre: string;
  version: number;
  activo: boolean;
  metaJson?: unknown;
  createdAt: string;
  updatedAt: string;
  flowVersions?: FlowVersion[];
  _count?: { flowVersions: number; executions: number };
}

interface NodeDef {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next?: string | null;
  branches?: Record<string, string>;
  parentId?: string | null;
  children?: NodeDef[];
  _waba_screen_id?: string;
  ui?: {
    collapsed?: boolean;
  };
}

interface FlowDefinition {
  version?: string;
  entry_point: string;
  nodes: NodeDef[];
  nodePositions?: Record<string, { x: number; y: number }>;
  variables?: Record<string, unknown>;
  integrations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function flattenNodes(nodes: NodeDef[]): NodeDef[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children || [])]);
}

function upsertNode(nodes: NodeDef[], nextNode: NodeDef): { nodes: NodeDef[]; updated: boolean } {
  let updated = false;

  const mapped = nodes.map((node) => {
    if (node.id === nextNode.id) {
      updated = true;
      return {
        ...node,
        ...nextNode,
        parentId: nextNode.parentId ?? node.parentId,
        children: nextNode.children ?? node.children,
        ui: nextNode.ui ?? node.ui,
      };
    }

    if (!node.children?.length) {
      return node;
    }

    const childResult = upsertNode(node.children, nextNode);
    if (!childResult.updated) {
      return node;
    }

    updated = true;
    return {
      ...node,
      children: childResult.nodes,
    };
  });

  return { nodes: mapped, updated };
}

function removeNode(nodes: NodeDef[], nodeId: string): NodeDef[] {
  return nodes.flatMap((node) => {
    if (node.id === nodeId) {
      return [];
    }

    const childNodes = node.children ? removeNode(node.children, nodeId) : undefined;
    return [
      {
        ...node,
        children: childNodes && childNodes.length > 0 ? childNodes : undefined,
      },
    ];
  });
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractValidationErrorMessages(rawErrors: unknown): string[] {
  if (!Array.isArray(rawErrors)) return [];

  return rawErrors
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (entry && typeof entry === "object") {
        const message = (entry as { message?: unknown }).message;
        if (typeof message === "string") return message.trim();
      }
      return "";
    })
    .filter(Boolean);
}

function getDataSource(component: unknown): unknown[] {
  const record = asObjectRecord(component);
  return asArray(record?.data_source ?? record?.["data-source"]);
}

function getActionConfig(component: unknown): Record<string, unknown> | null {
  const record = asObjectRecord(component);
  if (!record) return null;

  return asObjectRecord(record.on_click_action) ?? asObjectRecord(record["on-click-action"]);
}

function flattenWabaChildren(children: unknown): Record<string, unknown>[] {
  return asArray(children).flatMap((child) => {
    const record = asObjectRecord(child);
    if (!record) return [];

    return [record, ...flattenWabaChildren(record.children)];
  });
}

function resolveWabaTarget(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  const record = asObjectRecord(value);
  if (!record) return null;

  const screen = typeof record.screen === "string" ? record.screen.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return screen || name || null;
}

function getScreenTargetFromAction(actionConfig: unknown): string | null {
  const record = asObjectRecord(actionConfig);
  if (!record) return null;

  return resolveWabaTarget(record.navigate) ?? resolveWabaTarget(record.next);
}

function getFooterTargetFromScreen(screen: unknown): string | null {
  const screenRecord = asObjectRecord(screen);
  const layout = asObjectRecord(screenRecord?.layout);
  const children = flattenWabaChildren(layout?.children);
  const footer = children.find((child) => child.type === "Footer");

  return getScreenTargetFromAction(getActionConfig(footer));
}

function buildScreenIdToNodeIdMap(nodes: NodeDef[]): Map<string, string> {
  return new Map(
    nodes.flatMap((node) => {
      const entries: Array<[string, string]> = [];
      const screenId = typeof node._waba_screen_id === "string" ? node._waba_screen_id.trim() : "";
      const embeddedScreen = asObjectRecord(node.config?._waba_screen);
      const embeddedScreenId = typeof embeddedScreen?.id === "string" ? embeddedScreen.id.trim() : "";

      if (screenId) entries.push([screenId, node.id]);
      if (embeddedScreenId) entries.push([embeddedScreenId, node.id]);

      return entries;
    })
  );
}

function getNodeScreenId(node: NodeDef): string | null {
  const explicit = typeof node._waba_screen_id === "string" ? node._waba_screen_id.trim() : "";
  if (explicit) return explicit;

  const embedded = asObjectRecord(node.config?._waba_screen);
  const embeddedId = typeof embedded?.id === "string" ? embedded.id.trim() : "";
  return embeddedId || null;
}

function resolveNodeTarget(
  target: unknown,
  nodeIds: Set<string>,
  screenIdToNodeId: Map<string, string>
): string | null {
  const normalizedTarget = typeof target === "string" ? target.trim() : "";
  if (!normalizedTarget) return null;
  if (nodeIds.has(normalizedTarget)) return normalizedTarget;

  const mappedTarget = screenIdToNodeId.get(normalizedTarget);
  return mappedTarget && nodeIds.has(mappedTarget) ? mappedTarget : null;
}

function normalizeBranchTargets(
  branches: unknown,
  nodeIds: Set<string>,
  screenIdToNodeId: Map<string, string>
): Record<string, string> {
  const branchRecord = asObjectRecord(branches);
  if (!branchRecord) return {};

  return Object.fromEntries(
    Object.entries(branchRecord).flatMap(([branchKey, target]) => {
      const resolvedTarget = resolveNodeTarget(target, nodeIds, screenIdToNodeId);
      return branchKey && resolvedTarget ? [[branchKey, resolvedTarget]] : [];
    })
  );
}

function buildMenuBranchesFromOptions(
  options: unknown,
  nodeIds: Set<string>,
  screenIdToNodeId: Map<string, string>
): Record<string, string> {
  if (!Array.isArray(options)) return {};

  return Object.fromEntries(
    options.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const optionId = typeof (option as { id?: unknown }).id === "string"
        ? (option as { id: string }).id.trim()
        : "";
      const nextNodeId = resolveNodeTarget((option as { next?: unknown }).next, nodeIds, screenIdToNodeId) ?? "";

      return optionId && nextNodeId ? [[optionId, nextNodeId]] : [];
    })
  );
}

function buildMenuBranchesFromRouteTargets(
  options: unknown,
  routeTargets: string[],
  nodeIds: Set<string>,
  screenIdToNodeId: Map<string, string>
): Record<string, string> {
  const optionRecords = asArray(options)
    .map(asObjectRecord)
    .filter((option): option is Record<string, unknown> => Boolean(option));
  if (optionRecords.length === 0 || routeTargets.length === 0) return {};

  const mappedRouteTargets = routeTargets
    .map((target) => resolveNodeTarget(target, nodeIds, screenIdToNodeId))
    .filter((target): target is string => Boolean(target));

  if (mappedRouteTargets.length === 0) return {};

  const result: Record<string, string> = {};

  // Direct mapping when option id already points to a known node or screen id.
  optionRecords.forEach((option) => {
    const optionId = typeof option.id === "string" ? option.id.trim() : "";
    if (!optionId) return;

    const directTarget = resolveNodeTarget(optionId, nodeIds, screenIdToNodeId);
    if (directTarget) {
      result[optionId] = directTarget;
    }
  });

  // If routing has a single destination, map every unmapped option to that same target.
  if (mappedRouteTargets.length === 1) {
    const sharedTarget = mappedRouteTargets[0];
    optionRecords.forEach((option) => {
      const optionId = typeof option.id === "string" ? option.id.trim() : "";
      if (!optionId || result[optionId]) return;
      result[optionId] = sharedTarget;
    });
    return result;
  }

  // Ordered fallback: option[0] -> routeTargets[0], etc.
  optionRecords.forEach((option, index) => {
    const optionId = typeof option.id === "string" ? option.id.trim() : "";
    if (!optionId || result[optionId]) return;

    const orderedTarget = mappedRouteTargets[index] ?? mappedRouteTargets[mappedRouteTargets.length - 1];
    if (orderedTarget) {
      result[optionId] = orderedTarget;
    }
  });

  return result;
}

function withMissingNodePositions(definition: FlowDefinition, flatNodes: NodeDef[]): FlowDefinition {
  const currentPositions = definition.nodePositions ?? {};
  const existingKeys = Object.keys(currentPositions);
  if (existingKeys.length === 0) return definition;

  const missingNodeIds = flatNodes
    .map((node) => node.id)
    .filter((nodeId) => !currentPositions[nodeId]);

  if (missingNodeIds.length === 0) return definition;

  const occupied = new Set(
    Object.values(currentPositions).map((p) => `${Math.round(p.x)}:${Math.round(p.y)}`)
  );

  const existingValues = Object.values(currentPositions);
  const maxX = existingValues.length ? Math.max(...existingValues.map((p) => p.x)) : 50;
  const minY = existingValues.length ? Math.min(...existingValues.map((p) => p.y)) : 50;

  const spacingX = 360;
  const spacingY = 240;
  const startX = maxX + spacingX;
  const startY = minY;
  const cols = 3;

  const nextPositions: Record<string, { x: number; y: number }> = { ...currentPositions };

  missingNodeIds.forEach((nodeId, index) => {
    let candidateIndex = index;
    while (true) {
      const col = candidateIndex % cols;
      const row = Math.floor(candidateIndex / cols);
      const x = startX + (col * spacingX);
      const y = startY + (row * spacingY);
      const key = `${Math.round(x)}:${Math.round(y)}`;

      if (!occupied.has(key)) {
        nextPositions[nodeId] = { x, y };
        occupied.add(key);
        break;
      }

      candidateIndex += 1;
    }
  });

  return {
    ...definition,
    nodePositions: nextPositions,
  };
}

function withUniqueNodePositions(definition: FlowDefinition, flatNodes: NodeDef[]): FlowDefinition {
  const currentPositions = definition.nodePositions ?? {};
  if (Object.keys(currentPositions).length === 0) return definition;

  const occupied = new Set<string>();
  const dedupedPositions: Record<string, { x: number; y: number }> = { ...currentPositions };
  let changed = false;

  for (const node of flatNodes) {
    const original = dedupedPositions[node.id];
    if (!original) continue;

    let x = Number(original.x) || 0;
    let y = Number(original.y) || 0;
    let key = `${Math.round(x)}:${Math.round(y)}`;

    // If another node already uses this exact coordinate, shift until free.
    while (occupied.has(key)) {
      x += 40;
      y += 40;
      key = `${Math.round(x)}:${Math.round(y)}`;
      changed = true;
    }

    dedupedPositions[node.id] = { x, y };
    occupied.add(key);
  }

  if (!changed) return definition;

  return {
    ...definition,
    nodePositions: dedupedPositions,
  };
}

function normalizeFlowDefinition(definition: FlowDefinition): FlowDefinition {
  const flatNodes = flattenNodes(definition.nodes);
  const nodeIds = new Set(flatNodes.map((node) => node.id));
  const screenIdToNodeId = buildScreenIdToNodeIdMap(flatNodes);
  const metadata = asObjectRecord(definition.metadata);
  const routingModel = metadata?.routing_model;
  const normalizedNodes = definition.nodes.map(function normalizeNode(node): NodeDef {
    const normalizedChildren = node.children?.map(normalizeNode);
    if (node.type === "end") {
      return {
        ...node,
        next: null,
        branches: undefined,
        children: normalizedChildren && normalizedChildren.length > 0 ? normalizedChildren : undefined,
      };
    }

    const nodeScreenId = getNodeScreenId(node) ?? "";
    const routeTargets = nodeScreenId ? resolveRouteTargets(routingModel, nodeScreenId) : [];

    // Normalize explicit branches and options-based branches.
    // Do NOT infer branches from routing_model index — that mapping is not semantically
    // correct (WABA routing_model lists reachable screens, not per-option routes).
    const branchesFromDefinition = normalizeBranchTargets(node.branches, nodeIds, screenIdToNodeId);
    const branchesFromOptions = node.type === "menu"
      ? buildMenuBranchesFromOptions(node.config?.options, nodeIds, screenIdToNodeId)
      : {};

    const finalBranches = {
      ...branchesFromOptions,
      ...branchesFromDefinition,
    };

    const footerTarget = getFooterTargetFromScreen(node.config?._waba_screen);
    // Resolve node.next: try direct resolution, then footer action, then single routing target.
    // Critically, always fall back to the original node.next if it's already a valid node ID
    // so we never accidentally overwrite a good value with null.
    const resolvedNext =
      resolveNodeTarget(node.next, nodeIds, screenIdToNodeId) ??
      resolveNodeTarget(footerTarget, nodeIds, screenIdToNodeId) ??
      (routeTargets.length === 1 ? resolveNodeTarget(routeTargets[0], nodeIds, screenIdToNodeId) : null) ??
      (typeof node.next === "string" && nodeIds.has(node.next) ? node.next : null);

    return {
      ...node,
      next: resolvedNext,
      branches: Object.keys(finalBranches).length > 0 ? finalBranches : undefined,
      children: normalizedChildren && normalizedChildren.length > 0 ? normalizedChildren : undefined,
    };
  });

  const normalizedDefinition: FlowDefinition = {
    ...definition,
    nodes: normalizedNodes,
  };

  const withFilledPositions = withMissingNodePositions(normalizedDefinition, flatNodes);
  const withDedupedPositions = withUniqueNodePositions(withFilledPositions, flatNodes);
  const filledPositionCount = Object.keys(withDedupedPositions.nodePositions || {}).length;
  if (filledPositionCount >= flatNodes.length && flatNodes.length > 0) {
    return withDedupedPositions;
  }

  const positionCount = Object.keys(withDedupedPositions.nodePositions || {}).length;
  if (positionCount >= flatNodes.length && flatNodes.length > 0) {
    return withDedupedPositions;
  }

  const withAutoLayout = layoutAsHierarchy(withDedupedPositions as never) as unknown as FlowDefinition;
  return withUniqueNodePositions(withAutoLayout, flatNodes);
}

function parseJsonLenient(raw: string): unknown {
  const base = raw.trim();
  if (!base) throw new Error("empty");

  const normalizedQuotes = base
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  const unwrapped =
    normalizedQuotes.startsWith("(") && normalizedQuotes.endsWith(")")
      ? normalizedQuotes.slice(1, -1).trim()
      : normalizedQuotes;

  const stripTrailingCommas = (value: string) => value.replace(/,\s*([}\]])/g, "$1");

  const candidates = [base, normalizedQuotes, unwrapped, stripTrailingCommas(unwrapped)];
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("invalid_json");
}

function isFlowDefinitionShape(value: unknown): value is FlowDefinition {
  const record = asObjectRecord(value);
  return Boolean(record && Array.isArray(record.nodes) && typeof record.entry_point === "string");
}

function resolveRouteTargets(routingModel: unknown, screenId: string): string[] {
  const routing = asObjectRecord(routingModel);
  return asArray(routing?.[screenId]).flatMap((target) => {
    if (typeof target !== "string") return [];
    const normalized = target.trim();
    return normalized ? [normalized] : [];
  });
}

function convertWabaJsonToFlowDefinition(value: unknown): FlowDefinition {
  const waba = asObjectRecord(value);
  const screens = asArray(waba?.screens).map(asObjectRecord).filter((screen): screen is Record<string, unknown> => Boolean(screen));
  if (screens.length === 0) {
    throw new Error("waba_without_screens");
  }

  const screenToNodeId = new Map<string, string>();
  screens.forEach((screen, index) => {
    const screenId = typeof screen.id === "string" && screen.id.trim() ? screen.id.trim() : `SCREEN_${index + 1}`;
    screenToNodeId.set(screenId, `node_${index + 1}`);
  });

  const nodes: NodeDef[] = screens.map((screen, index) => {
    const nodeId = `node_${index + 1}`;
    const screenId = typeof screen.id === "string" && screen.id.trim() ? screen.id.trim() : `SCREEN_${index + 1}`;
    const children = flattenWabaChildren(asObjectRecord(screen.layout)?.children);
    const routeTargets = resolveRouteTargets(waba?.routing_model, screenId);

    const hasMenu = children.some((component) => ["Dropdown", "RadioButtonsGroup", "CheckboxGroup"].includes(String(component.type ?? "")));
    const hasInput = children.some((component) => ["TextInput", "TextArea", "DatePicker", "OptIn"].includes(String(component.type ?? "")));
    const isTerminal = screen.terminal === true || index === screens.length - 1;

    let nodeType = "message";
    if (isTerminal) nodeType = "end";
    else if (hasMenu) nodeType = "menu";
    else if (hasInput) nodeType = "input";

    const textComponent = children.find((component) => ["TextHeading", "TextBody", "TextCaption"].includes(String(component.type ?? "")));
    const text = typeof textComponent?.text === "string"
      ? textComponent.text
      : (typeof screen.title === "string" ? screen.title : `Screen ${index + 1}`);

    const menuComponent = children.find((component) => ["Dropdown", "RadioButtonsGroup", "CheckboxGroup"].includes(String(component.type ?? "")));
    const options = getDataSource(menuComponent).map((option, optionIndex) => {
      const record = asObjectRecord(option);
      const id = typeof record?.id === "string" && record.id.trim()
        ? record.id.trim()
        : String(record?.value ?? `option_${index + 1}_${optionIndex + 1}`);
      const title = typeof record?.title === "string" && record.title.trim()
        ? record.title.trim()
        : String(record?.label ?? id);

      const actionTarget = getScreenTargetFromAction(getActionConfig(record));
      const nextTarget = actionTarget || (typeof record?.next === "string" ? record.next.trim() : "");
      return nextTarget ? { id, title, next: nextTarget } : { id, title };
    });

    const footerTarget = getFooterTargetFromScreen(screen);
    const resolvedNextScreen = footerTarget || (routeTargets.length === 1 ? routeTargets[0] : "");
    const next = resolvedNextScreen && screenToNodeId.has(resolvedNextScreen)
      ? screenToNodeId.get(resolvedNextScreen) ?? null
      : null;

    // Only create per-option branches when the option carries an EXPLICIT navigate action.
    // Routing-model index assignment is semantically wrong: in standard WABA Flows the Footer
    // drives navigation, not individual radio/dropdown options.
    const branches = nodeType === "menu"
      ? Object.fromEntries(
          options.flatMap((option) => {
            const explicitTarget = typeof option.next === "string" ? option.next.trim() : "";
            if (!explicitTarget) return [];
            const mappedExplicit = screenToNodeId.get(explicitTarget);
            return mappedExplicit ? [[option.id, mappedExplicit]] : [];
          })
        )
      : {};

    const normalizedNext = nodeType === "end" ? null : next;
    const normalizedBranches = nodeType === "end" ? {} : branches;

    return {
      id: nodeId,
      type: nodeType,
      config: {
        text,
        ...(nodeType === "menu" ? { options } : {}),
        _waba_screen: screen,
      },
      next: normalizedNext,
      branches: normalizedBranches,
      _waba_screen_id: screenId,
    } as NodeDef;
  });

  const entryPoint = nodes[0]?.id ?? "node_1";
  return {
    version: typeof waba?.version === "string" ? waba.version : "7.1",
    entry_point: entryPoint,
    nodes,
    metadata: {
      source: "waba_json",
      routing_model: waba?.routing_model,
    },
  };
}

function coerceToFlowDefinition(value: unknown): FlowDefinition {
  if (isFlowDefinitionShape(value)) {
    return value;
  }

  const record = asObjectRecord(value);
  if (isFlowDefinitionShape(record?.definition)) {
    return record.definition;
  }

  if (record && Array.isArray(record.screens)) {
    return convertWabaJsonToFlowDefinition(record);
  }

  if (record && asObjectRecord(record.wabaJson) && Array.isArray(asObjectRecord(record.wabaJson)?.screens)) {
    return convertWabaJsonToFlowDefinition(record.wabaJson);
  }

  throw new Error("unsupported_json_shape");
}

interface LlmPromptItem {
  id: string;
  systemPrompt: string;
  outputMode: "text" | "json";
  targetVariable: string;
}

interface SimulationStep {
  nodeId?: string;
  nodeType?: string;
  input?: string;
  output?: Record<string, unknown>;
  error?: string;
  waiting_for_input?: boolean;
  selected?: string;
  llm_intent?: string;
  variable_captured?: Record<string, unknown>;
}

interface SimulationPath {
  pathId: string;
  trace: SimulationStep[];
  finalVariables?: Record<string, unknown>;
  stepCount?: number;
  endedBy?: string;
}

interface SimulationVerdict {
  status: "pass" | "warn" | "fail";
  summary: string;
  highlights: string[];
  metrics?: {
    pathCount: number;
    completedPathCount: number;
    endNodeCount: number;
    errorPathCount: number;
    maxStepPathCount: number;
    waitingPathCount: number;
    truncated: boolean;
  };
  llm?: {
    summary?: string | null;
    risks?: string[];
    recommendedStatus?: string | null;
    provider?: string;
    model?: string;
  } | null;
}

interface SimulationResult {
  mode?: "single" | "exhaustive";
  strategy?: string;
  trace?: SimulationStep[];
  paths?: SimulationPath[];
  conversationIds?: string[];
  verdict?: SimulationVerdict;
  stepCount?: number;
  pathCount?: number;
  truncated?: boolean;
  finalVariables?: Record<string, unknown>;
}

interface CatalogEndpoint {
  id: string;
  name: string;
  method: string;
  url: string;
  inputs: string[];
  outputs: string[];
  description?: string;
  sessionInit?: boolean;
  inputDefaults?: Record<string, string>;
}

type TabKey = "list" | "builder" | "versions" | "simulate" | "import-logs";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_BADGE: Record<string, string> = {
  draft:    "bg-slate-100 text-slate-600",
  valid:    "bg-green-100 text-green-700",
  invalid:  "bg-red-100 text-red-700",
  exported: "bg-blue-100 text-blue-700",
};

const NODE_TYPE_COLOR: Record<string, string> = {
  message:   "border-blue-300 bg-blue-50",
  input:     "border-amber-300 bg-amber-50",
  menu:      "border-purple-300 bg-purple-50",
  condition: "border-orange-300 bg-orange-50",
  action:    "border-green-300 bg-green-50",
  task:      "border-emerald-300 bg-emerald-50",
  delay:     "border-slate-300 bg-slate-50",
  end:       "border-rose-300 bg-rose-50",
  start:     "border-teal-300 bg-teal-50",
  handoff:   "border-indigo-300 bg-indigo-50",
  llm:       "border-violet-300 bg-violet-50",
};

function fmtDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-MX", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: ImportModal
// ─────────────────────────────────────────────────────────────────────────────
function ImportModal({ onClose, onImported, tenantSlug }: { onClose: () => void; onImported: () => void; tenantSlug: string }) {
  const t = useTranslations("wabaFlows");
  const [json, setJson]     = useState("");
  const [nombre, setNombre] = useState("");
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult]  = useState<Record<string, unknown> | null>(null);

  async function handleImport() {
    setError("");
    if (!tenantSlug) {
      setError(t("importModal.missingTenant"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonLenient(json);
    } catch {
      setError(t("importModal.invalidJson"));
      return;
    }
    setLoading(true);
    try {
      const { data } = await wabaFlowsApi.import({ wabaJson: parsed, nombre: nombre || undefined, tenantSlug });
      setResult(data);
      onImported();
    } catch (e: unknown) {
      const responseData = (e as { response?: { data?: { error?: string; validation?: { errors?: string[] } } } })?.response?.data;
      const validationErrors = Array.isArray(responseData?.validation?.errors) ? responseData.validation.errors : [];
      const msg = responseData?.error;
      setError(validationErrors.length > 0 ? `${msg ?? t("importModal.importError")} ${validationErrors.join(" | ")}` : (msg ?? t("importModal.importError")));
    } finally {
      setLoading(false);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setJson(ev.target?.result as string);
    reader.readAsText(file);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-blue-600" />
            <h2 className="font-semibold text-slate-800">{t("importModal.title")}</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
          {result ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-700 bg-green-50 rounded-xl px-4 py-3">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-medium">{t("importModal.success")}</span>
              </div>
              <div className="rounded-xl border border-slate-200 p-4 bg-slate-50 text-xs font-mono overflow-auto max-h-60">
                {JSON.stringify(result, null, 2)}
              </div>
              <button onClick={onClose} className="w-full btn-primary py-2.5">{t("importModal.close")}</button>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("importModal.flowNameOptional")}</label>
                <input
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  placeholder={t("importModal.flowNamePlaceholder")}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("importModal.uploadFile")}</label>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={handleFileUpload}
                  className="block text-sm text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("importModal.pasteJson")}</label>
                <textarea
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  rows={10}
                  placeholder='{"version": "7.1", "screens": [...]}'
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 text-red-700 bg-red-50 rounded-xl px-4 py-3 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {!result && (
          <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">{t("importModal.cancel")}</button>
            <button
              onClick={handleImport}
              disabled={loading || !json.trim()}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {t("importModal.import")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: CreateFlowModal
// ─────────────────────────────────────────────────────────────────────────────
function CreateFlowModal({ onClose, onCreated, tenantSlug }: { onClose: () => void; onCreated: () => void; tenantSlug: string }) {
  const t = useTranslations("wabaFlows");
  const [nombre, setNombre] = useState("");
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!nombre.trim()) { setError(t("createModal.nameRequired")); return; }
    if (!tenantSlug) { setError(t("createModal.missingTenant")); return; }
    setError("");
    setLoading(true);
    try {
      await wabaFlowsApi.create({ nombre, tenantSlug });
      onCreated();
      onClose();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? t("createModal.createError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Plus className="w-5 h-5 text-blue-600" />
            <h2 className="font-semibold text-slate-800">{t("createModal.title")}</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("createModal.flowName")}</label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder={t("createModal.flowNamePlaceholder")}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">{t("createModal.cancel")}</button>
          <button
            onClick={handleCreate}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {t("createModal.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: NodeEditor (inline block editor)
// ─────────────────────────────────────────────────────────────────────────────
function NodeCard({
  node,
  isEntry,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: {
  node: NodeDef;
  isEntry: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onEdit: (node: NodeDef) => void;
  onDelete: (id: string) => void;
}) {
  const colorClass = NODE_TYPE_COLOR[node.type] ?? "border-slate-200 bg-white";
  return (
    <div className={`relative rounded-xl border-2 ${colorClass} p-4 group`}>
      {isEntry && (
        <span className="absolute -top-2.5 left-3 text-xs font-bold bg-teal-500 text-white px-2 py-0.5 rounded-full">
          ENTRY
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-slate-500">{node.id}</span>
            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-md ${STATUS_BADGE.valid}`}>
              {node.type}
            </span>
          </div>
          {!!node.config?.text && (
            <p className="text-sm text-slate-700 truncate">{String(node.config.text)}</p>
          )}
          {node.type === "menu" && Array.isArray(node.config?.options) && (
            <p className="text-xs text-slate-500 mt-1">
              {(node.config.options as { title: string }[]).map((o) => o.title).join(", ")}
            </p>
          )}
          {node.type === "action" && (
            <p className="text-xs text-slate-500 mt-1 font-mono">
              {String(node.config?.integration_ref ?? node.config?.endpoint ?? "—")}
            </p>
          )}
          {node.next && (
            <div className="flex items-center gap-1 mt-2 text-xs text-slate-400">
              <ArrowRight className="w-3 h-3" />
              <span>{node.next}</span>
            </div>
          )}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onMoveUp(node.id)}
            disabled={!canMoveUp}
            className="p-1.5 rounded-lg hover:bg-white/80 text-slate-500 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onMoveDown(node.id)}
            disabled={!canMoveDown}
            className="p-1.5 rounded-lg hover:bg-white/80 text-slate-500 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onEdit(node)}
            className="p-1.5 rounded-lg hover:bg-white/80 text-slate-500 hover:text-blue-600"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(node.id)}
            className="p-1.5 rounded-lg hover:bg-white/80 text-slate-500 hover:text-red-600"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: NodeEditModal
// ─────────────────────────────────────────────────────────────────────────────
const NODE_TYPES = ["message", "input", "menu", "condition", "action", "task", "delay", "end", "handoff", "llm"];
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const CONDITION_OPS = ["equals", "not_equals", "contains", "starts_with", "ends_with", "greater_than", "less_than", "is_empty", "is_not_empty"];
const CONDITION_TRUE_ALIASES = ["true", "si", "sí", "yes"];
const CONDITION_FALSE_ALIASES = ["false", "no", "else", "default", "otherwise", "fallback"];
const MENU_VARIABLE_PRESETS = [
  "variables.opcion_menu",
  "variables.menu_seleccion",
  "variables.menu_opcion_id",
  "variables.menu_opcion_titulo",
];

function parseConditionExpression(expression: string): { variable: string; operator: string; value: string } | null {
  const expr = String(expression ?? "").trim();
  if (!expr) return null;

  const binary = expr.match(/^\s*\{\{\s*([^}]+)\s*\}\}\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (!binary) return null;

  const rawVar = binary[1].trim();
  const symbol = binary[2];
  const rawVal = binary[3].trim();

  const opMap: Record<string, string> = {
    "==": "equals",
    "!=": "not_equals",
    ">": "greater_than",
    "<": "less_than",
  };

  const value = rawVal.replace(/^['\"](.*)['\"]$/, "$1");
  return {
    variable: rawVar,
    operator: opMap[symbol] ?? "equals",
    value,
  };
}

function buildConditionExpression(variable: string, operator: string, value: string): string {
  const rawVar = variable.trim();
  if (!rawVar) return "";

  const wrappedVar = rawVar.startsWith("{{") && rawVar.endsWith("}}")
    ? rawVar
    : `{{${rawVar}}}`;

  const normalizedOp = operator.trim();
  const trimmedVal = value.trim();

  switch (normalizedOp) {
    case "equals":
      return `${wrappedVar} == ${trimmedVal}`;
    case "not_equals":
      return `${wrappedVar} != ${trimmedVal}`;
    case "greater_than":
      return `${wrappedVar} > ${trimmedVal}`;
    case "less_than":
      return `${wrappedVar} < ${trimmedVal}`;
    case "is_empty":
      return `${wrappedVar} == ""`;
    case "is_not_empty":
      return `${wrappedVar} != ""`;
    default:
      return `${wrappedVar} == ${trimmedVal}`;
  }
}

// ─── VarComboInput ────────────────────────────────────────────────────────────
// Input with a click-to-open dropdown showing available flow variables.
// Uses fixed positioning to escape overflow-hidden/auto parent containers.
function VarComboInput({
  value,
  onChange,
  placeholder,
  suggestions,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  suggestions: string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = suggestions.filter((s) =>
    !value.trim() || s.toLowerCase().includes(value.toLowerCase())
  );

  function handleFocus() {
    if (inputRef.current) {
      const rect = inputRef.current.getBoundingClientRect();
      setDropdownStyle({ top: rect.bottom + window.scrollY + 2, left: rect.left + window.scrollX, width: rect.width });
    }
    setOpen(true);
  }

  return (
    <div className="flex-1 min-w-0">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={handleFocus}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className={className}
      />
      {open && filtered.length > 0 && (
        <div
          style={{ position: "fixed", top: dropdownStyle.top, left: dropdownStyle.left, width: dropdownStyle.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl max-h-48 overflow-y-auto"
        >
          {filtered.map((v) => (
            <button
              key={v}
              type="button"
              onMouseDown={() => { onChange(v); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-blue-50 hover:text-blue-700 text-slate-700"
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NodeEditModal({
  node,
  allNodeIds,
  allNodes,
  catalogEndpoints,
  flowVariables,
  integrations,
  onSave,
  onClose,
}: {
  node: Partial<NodeDef>;
  allNodeIds: string[];
  allNodes?: NodeDef[];
  catalogEndpoints: CatalogEndpoint[];
  flowVariables: string[];
  integrations: { id: number; nombre: string; tipo: string }[];
  onSave: (n: NodeDef) => void;
  onClose: () => void;
}) {
  const t = useTranslations("wabaFlows");
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const initialBranches = (node.branches ?? {}) as Record<string, string>;
  const parsedCondition = parseConditionExpression(String(cfg.expression ?? ""));

  function pickConditionBranchTarget(branches: Record<string, string>, aliases: string[]): string {
    const target = Object.entries(branches).find(([key]) => aliases.includes(key.trim().toLowerCase()));
    return target?.[1] ?? "";
  }

  function nodeLabel(nid: string): string {
    const found = allNodes?.find((n) => n.id === nid);
    if (!found) return nid;
    const text = typeof found.config?.text === "string" && found.config.text.trim()
      ? found.config.text.trim()
      : typeof found.config?.label === "string" && found.config.label.trim()
      ? found.config.label.trim()
      : typeof found.config?.title === "string" && found.config.title.trim()
      ? found.config.title.trim()
      : "";
    return text ? `${nid} · ${text.slice(0, 40)}` : nid;
  }

  function buildBranchesFromOptions(options: { id: string; title: string; next: string }[]): Record<string, string> {
    return options.reduce<Record<string, string>>((acc, option) => {
      const key = option.id.trim();
      const target = option.next.trim();
      if (key && target) acc[key] = target;
      return acc;
    }, {});
  }

  function parseBranchesSafely(raw: string): Record<string, string> | null {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      Object.entries(parsed as Record<string, unknown>).forEach(([k, v]) => {
        if (typeof v === "string") out[k] = v;
      });
      return out;
    } catch {
      return null;
    }
  }

  const [id, setId]     = useState(node.id ?? "");
  const [type, setType] = useState(node.type ?? "message");
  const [next, setNext] = useState(node.next ?? "");
  const [branchesJson, setBranchesJson] = useState(JSON.stringify(initialBranches, null, 2));
  const [err, setErr]   = useState("");
  const [showJson, setShowJson] = useState(false);
  const [rawJson, setRawJson]   = useState(JSON.stringify(cfg, null, 2));

  // per-type state
  const [text, setText]               = useState(String(cfg.text ?? ""));
  const [inputText, setInputText]     = useState(String(cfg.text ?? ""));
  const [inputVar, setInputVar]       = useState(String(cfg.variable ?? ""));
  const [inputValidationType, setInputValidationType] = useState(
    String(cfg.validationType ?? ((cfg.validationPattern ?? cfg.regex ?? cfg.pattern) ? "regex" : "none"))
  );
  const [inputValidationPattern, setInputValidationPattern] = useState(String(cfg.validationPattern ?? cfg.regex ?? cfg.pattern ?? ""));
  const [inputValidationFlags, setInputValidationFlags] = useState(String(cfg.validationFlags ?? ""));
  const [inputValidationMessage, setInputValidationMessage] = useState(String(cfg.validationMessage ?? cfg.invalidMessage ?? ""));
  const [menuText, setMenuText]       = useState(String(cfg.text ?? ""));
  const [menuVar, setMenuVar]         = useState(String(cfg.variable ?? "variables.opcion_menu"));
  const [menuOptions, setMenuOptions] = useState<{ id: string; title: string; next: string }[]>(
    Array.isArray(cfg.options)
      ? (cfg.options as Array<{ id?: string; title?: string; next?: string }>).map((option, index) => {
          const optionId = String(option.id ?? `opt_${index + 1}`);
          return {
            id: optionId,
            title: String(option.title ?? ""),
            next: String(option.next ?? initialBranches[optionId] ?? ""),
          };
        })
      : []
  );
  const [condVar, setCondVar]         = useState(String(cfg.variable ?? parsedCondition?.variable ?? ""));
  const [condOp, setCondOp]           = useState(String(cfg.operator ?? parsedCondition?.operator ?? "equals"));
  const [condVal, setCondVal]         = useState(String(cfg.value ?? parsedCondition?.value ?? ""));
  const [condTrueNext, setCondTrueNext] = useState(pickConditionBranchTarget(initialBranches, CONDITION_TRUE_ALIASES));
  const [condFalseNext, setCondFalseNext] = useState(pickConditionBranchTarget(initialBranches, CONDITION_FALSE_ALIASES));
  const [delaySeconds, setDelaySeconds] = useState(Number(cfg.seconds ?? 3));
  const [endMsg, setEndMsg]           = useState(String(cfg.text ?? cfg.message ?? ""));
  const [handoffDept, setHandoffDept] = useState(String(cfg.department ?? ""));
  const [handoffMsg, setHandoffMsg]   = useState(String(cfg.text ?? cfg.message ?? ""));
  const handoffDepartmentSuggestions = Array.from(new Set([
    "soporte_tecnico",
    "soporte",
    "ventas",
    "facturacion",
    ...(allNodes ?? []).flatMap((n) => {
      if (String(n.type ?? "").trim().toLowerCase() !== "handoff") return [];
      const department = typeof n.config?.department === "string" ? n.config.department.trim() : "";
      return department ? [department] : [];
    }),
  ]));
  const [taskAction, setTaskAction] = useState(String(cfg.action ?? "create_task"));
  const [taskTitle, setTaskTitle] = useState(String(cfg.title ?? ""));
  const [taskPriority, setTaskPriority] = useState(String(cfg.priority ?? "normal"));
  const [taskStatus, setTaskStatus] = useState(String(cfg.status ?? "open"));
  const [taskUserMessage, setTaskUserMessage] = useState(String(cfg.user_message ?? ""));
  const [taskWaitMessage, setTaskWaitMessage] = useState(String(cfg.wait_message ?? ""));
  const [taskIdVar, setTaskIdVar] = useState(String(cfg.task_id_var ?? "task_id"));
  const [taskNodeRef, setTaskNodeRef] = useState(String(cfg.task_node_ref ?? ""));
  const [taskAssignMode, setTaskAssignMode] = useState(
    String(
      cfg.assignment_mode
      ?? cfg.assign_mode
      ?? ((cfg.assign_to_var ?? "").toString().trim() ? "variable" : ((cfg.assign_to ?? "").toString().trim() ? "fixed" : "none"))
    )
  );
  const [taskAssignTo, setTaskAssignTo] = useState(String(cfg.assign_to ?? ""));
  const [taskAssignVar, setTaskAssignVar] = useState(String(cfg.assign_to_var ?? ""));
  // llm — multi-prompt config
  const [llmPrompts, setLlmPrompts] = useState<LlmPromptItem[]>(() => {
    if (Array.isArray((cfg as Record<string, unknown>).prompts) && ((cfg as Record<string, unknown>).prompts as LlmPromptItem[]).length > 0) {
      return ((cfg as Record<string, unknown>).prompts as LlmPromptItem[]).map((p, i) => ({
        id: p.id || `p${i + 1}`,
        systemPrompt: String(p.systemPrompt ?? ""),
        outputMode: p.outputMode === "json" ? "json" : "text",
        targetVariable: String(p.targetVariable ?? ""),
      }));
    }
    // legacy single-prompt backward compat
    return [{
      id: "p1",
      systemPrompt: String((cfg as Record<string, unknown>).system_prompt ?? (cfg as Record<string, unknown>).prompt ?? ""),
      outputMode: "text",
      targetVariable: String((cfg as Record<string, unknown>).variable ?? ""),
    }];
  });
  const [llmComposeMode, setLlmComposeMode] = useState<"sequential" | "parallel" | "first_match">(
    (["sequential", "parallel", "first_match"].includes(String((cfg as Record<string, unknown>).composeMode ?? ""))
      ? (cfg as Record<string, unknown>).composeMode as "sequential" | "parallel" | "first_match"
      : "sequential")
  );
  const [llmFallbackText, setLlmFallbackText] = useState(String((cfg as Record<string, unknown>).fallback_text ?? ""));
  // action
  const [actionRef, setActionRef]       = useState(String(cfg.integration_ref ?? ""));
  const [actionUrl, setActionUrl]       = useState(String((cfg.endpoint ?? (cfg as Record<string,unknown>).url) ?? ""));
  const [actionMethod, setActionMethod] = useState(String(cfg.method ?? "POST"));
  const [actionBody, setActionBody]     = useState<{ key: string; value: string }[]>(
    Object.entries((cfg.body as Record<string, string>) ?? {}).map(([k, v]) => ({ key: k, value: v }))
  );
  const [actionResponse, setActionResponse] = useState<{ key: string; value: string }[]>(
    Object.entries((cfg.response_mapping as Record<string, string>) ?? {}).map(([k, v]) => ({ key: k, value: v }))
  );

  const selectedEp = catalogEndpoints.find((ep) => ep.id === actionRef);
  const normalizedType = String(type ?? "").trim().toLowerCase();
  const isTerminalNode = normalizedType === "end";
  const supportsEndpointMapping = [
    "action",
    "menu",
    "input",
    "message",
    "text",
    "open_response",
    "condition",
    "end",
    "llm",
    "handoff",
  ].includes(normalizedType) && !isTerminalNode;

  const tenantInputKeySet = new Set([
    "tenant",
    "tenantid",
    "tenant_id",
    "tenantuuid",
    "tenant_uuid",
    "tenantslug",
    "tenant_slug",
  ]);

  function isTenantInputKey(key: string): boolean {
    return tenantInputKeySet.has(String(key ?? "").trim().toLowerCase());
  }

  function pickBestVariableForKey(key: string): string {
    const normalized = String(key ?? "").trim().toLowerCase();
    const vars = flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS;
    const findMatch = (rx: RegExp) => vars.find((v) => rx.test(v));

    if (isTenantInputKey(normalized)) {
      return findMatch(/tenant(_|\.)?slug|slug(_|\.)?tenant/i)
        ?? findMatch(/tenant(_|\.)?id|id(_|\.)?tenant/i)
        ?? "tenant_slug";
    }

    if (/identificacion|cedula|dni|documento|passport/i.test(normalized)) {
      return findMatch(/cedula|identificacion|dni|documento|passport/i) ?? "variables.cedula";
    }

    if (/phone|telefono|tel/i.test(normalized)) {
      return findMatch(/telefono|phone|celular|movil/i) ?? "variables.telefono";
    }

    if (/email|correo|mail/i.test(normalized)) {
      return findMatch(/email|correo|mail/i) ?? "variables.email";
    }

    if (/nombre|name/i.test(normalized)) {
      return findMatch(/nombre|name/i) ?? "variables.nombre";
    }

    return "";
  }

  function endpointNeedsTenant(endpoint?: CatalogEndpoint | null, endpointUrl?: string): boolean {
    if (endpoint?.id === "updateContactByIdentification") return true;

    const inputs = Array.isArray(endpoint?.inputs) ? endpoint.inputs : [];
    if (inputs.some((inputKey) => isTenantInputKey(inputKey))) return true;

    const url = String(endpoint?.url ?? endpointUrl ?? "").toLowerCase();
    return url.startsWith("/crm/") || url.includes("tenant");
  }

  function normalizeTenantBodyForEndpoint(
    rows: { key: string; value: string }[],
    endpoint?: CatalogEndpoint | null
  ): { key: string; value: string }[] {
    if (endpoint?.id !== "updateContactByIdentification") return rows;

    const tenantSlugVar = pickBestVariableForKey("tenantSlug");
    const normalized = [...rows];

    const tenantSlugIndex = normalized.findIndex((row) => row.key.trim().toLowerCase() === "tenantslug");
    if (tenantSlugIndex >= 0) {
      if (!normalized[tenantSlugIndex].value?.trim()) {
        normalized[tenantSlugIndex] = { ...normalized[tenantSlugIndex], value: tenantSlugVar };
      }
    } else {
      normalized.push({ key: "tenantSlug", value: tenantSlugVar });
    }

    return normalized.filter((row) => {
      const key = row.key.trim().toLowerCase();
      return key !== "tenantid" && key !== "tenant_id" && key !== "tenantuuid" && key !== "tenant_uuid";
    });
  }

  function ensureTenantBody(rows: { key: string; value: string }[], endpoint?: CatalogEndpoint | null): { key: string; value: string }[] {
    if (!endpointNeedsTenant(endpoint, actionUrl)) return rows;

    const hasTenant = rows.some((row) => isTenantInputKey(row.key));
    if (hasTenant) return rows;

    return [
      ...rows,
      {
        key: "tenantSlug",
        value: pickBestVariableForKey("tenantSlug"),
      },
    ];
  }

  function autoConfigureEndpoint(endpoint: CatalogEndpoint) {
    setActionRef(endpoint.id);
    setActionUrl(endpoint.url);
    setActionMethod(endpoint.method);

    const nextBody = endpoint.inputs.map((inputKey) => {
      const existing = actionBody.find((b) => b.key === inputKey)?.value;
      const mapped = endpoint.inputDefaults?.[inputKey]
        ?? existing
        ?? pickBestVariableForKey(inputKey);
      return { key: inputKey, value: mapped };
    });

    setActionBody(normalizeTenantBodyForEndpoint(ensureTenantBody(nextBody, endpoint), endpoint));
    setActionResponse(endpoint.outputs.map((f) => ({ key: f, value: actionResponse.find((r) => r.key === f)?.value ?? `variables.${f}` })));
  }

  const selectedEndpointByUrl = catalogEndpoints.find((ep) => ep.url.trim().toLowerCase() === actionUrl.trim().toLowerCase());
  const endpointContext = selectedEp ?? selectedEndpointByUrl ?? null;
  const requiresTenantBody = endpointNeedsTenant(endpointContext, actionUrl);

  const menuValidation = (() => {
    if (type !== "menu") {
      return { duplicateIds: [] as string[], missingIdIndexes: [] as number[], missingNextIndexes: [] as number[] };
    }

    const idCounter = new Map<string, number>();
    menuOptions.forEach((option) => {
      const normalized = option.id.trim();
      if (!normalized) return;
      idCounter.set(normalized, (idCounter.get(normalized) ?? 0) + 1);
    });

    const duplicateIds = Array.from(idCounter.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id);

    const missingIdIndexes: number[] = [];
    const missingNextIndexes: number[] = [];

    menuOptions.forEach((option, index) => {
      if (!option.id.trim()) missingIdIndexes.push(index);
      if (!option.next.trim()) missingNextIndexes.push(index);
    });

    return { duplicateIds, missingIdIndexes, missingNextIndexes };
  })();

  const hasMenuValidationErrors =
    menuValidation.duplicateIds.length > 0 ||
    menuValidation.missingIdIndexes.length > 0;

  useEffect(() => {
    if (type !== "menu") return;
    const parsed = parseBranchesSafely(branchesJson);
    if (!parsed) return;
    setMenuOptions((prev) => prev.map((option) => ({
      ...option,
      next: parsed[option.id] ?? "",
    })));
  }, [branchesJson, type]);

  useEffect(() => {
    if (type !== "condition") return;
    const parsed = parseBranchesSafely(branchesJson);
    if (!parsed) return;
    setCondTrueNext(pickConditionBranchTarget(parsed, CONDITION_TRUE_ALIASES));
    setCondFalseNext(pickConditionBranchTarget(parsed, CONDITION_FALSE_ALIASES));
  }, [branchesJson, type]);

  useEffect(() => {
    if (type !== "condition") return;
    const parsed = parseBranchesSafely(branchesJson) ?? {};
    const nextBranches = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => {
        const normalized = key.trim().toLowerCase();
        return !CONDITION_TRUE_ALIASES.includes(normalized) && !CONDITION_FALSE_ALIASES.includes(normalized);
      })
    );

    if (condTrueNext.trim()) nextBranches.true = condTrueNext.trim();
    if (condFalseNext.trim()) nextBranches.false = condFalseNext.trim();

    const serialized = JSON.stringify(nextBranches, null, 2);
    setBranchesJson((prev) => (prev === serialized ? prev : serialized));
  }, [type, condTrueNext, condFalseNext]);

  function applyEndpoint(ep: CatalogEndpoint) {
    autoConfigureEndpoint(ep);
  }

    function handleActionUrlChange(value: string) {
      setActionUrl(value);

      const matchedEndpoint = catalogEndpoints.find((ep) => ep.url.trim() === value.trim());
      if (matchedEndpoint) {
        applyEndpoint(matchedEndpoint);
        return;
      }

      if (actionRef && selectedEp?.url !== value) {
        setActionRef("");
      }
    }

  function buildConfig(): Record<string, unknown> {
    const body: Record<string, string> = {};
    actionBody.forEach((r) => { if (r.key.trim()) body[r.key.trim()] = r.value; });

    const endpointForValidation = endpointContext;
    if (endpointNeedsTenant(endpointForValidation, actionUrl)) {
      const hasTenantField = Object.keys(body).some((key) => isTenantInputKey(key));
      if (!hasTenantField) {
        body.tenantSlug = pickBestVariableForKey("tenantSlug");
      }
    }

    if (endpointForValidation?.id === "updateContactByIdentification") {
      if (!body.tenantSlug || !String(body.tenantSlug).trim()) {
        body.tenantSlug = pickBestVariableForKey("tenantSlug");
      }
      delete body.tenantId;
      delete body.tenant_id;
      delete body.tenantUuid;
      delete body.tenant_uuid;
    }

    const response_mapping: Record<string, string> = {};
    actionResponse.forEach((r) => { if (r.key.trim()) response_mapping[r.key.trim()] = r.value; });

    const actionFragment: Record<string, unknown> = {
      ...(actionRef ? { integration_ref: actionRef } : {}),
      ...(actionUrl.trim() ? { endpoint: actionUrl.trim() } : {}),
      ...(actionMethod ? { method: actionMethod } : {}),
      ...(Object.keys(body).length ? { body } : {}),
      ...(Object.keys(response_mapping).length ? { response_mapping } : {}),
    };

    switch (type) {
      case "message":
      case "text":      return { text, ...actionFragment };
      case "input":
      case "open_response": {
        const baseConfig: Record<string, unknown> = { text: inputText, variable: inputVar, ...actionFragment };
        const normalizedValidationType = String(inputValidationType ?? "none").trim() || "none";
        if (normalizedValidationType !== "none") {
          baseConfig.validationType = normalizedValidationType;
        }
        if (normalizedValidationType === "regex" && inputValidationPattern.trim()) {
          baseConfig.validationPattern = inputValidationPattern.trim();
        }
        if (normalizedValidationType === "regex" && inputValidationFlags.trim()) {
          baseConfig.validationFlags = inputValidationFlags.trim();
        }
        if (inputValidationMessage.trim()) {
          baseConfig.validationMessage = inputValidationMessage.trim();
        }
        return baseConfig;
      }
      case "menu":      return { text: menuText, options: menuOptions, ...(menuVar.trim() ? { variable: menuVar.trim() } : {}), ...actionFragment };
      case "condition": {
        const expression = buildConditionExpression(condVar, condOp, condVal);
        return {
          variable: condVar,
          operator: condOp,
          value: condVal,
          ...(expression ? { expression } : {}),
          ...actionFragment,
        };
      }
      case "delay":     return { seconds: delaySeconds };
      case "end":       return { text: endMsg, ...(endMsg.trim() ? { message: endMsg } : {}), ...actionFragment };
      case "handoff":   return { department: handoffDept, text: handoffMsg, ...(handoffMsg.trim() ? { message: handoffMsg } : {}), ...actionFragment };
      case "llm":       return { prompts: llmPrompts, composeMode: llmComposeMode, ...(llmFallbackText.trim() ? { fallback_text: llmFallbackText.trim() } : {}), ...actionFragment };
      case "action":    return actionFragment;
      case "task": {
        if (taskAction === "wait_for_task") {
          return {
            action: "wait_for_task",
            status: taskStatus || "completed",
            ...(taskWaitMessage.trim() ? { wait_message: taskWaitMessage.trim() } : {}),
            ...(taskIdVar.trim() ? { task_id_var: taskIdVar.trim() } : {}),
            ...(taskNodeRef.trim() ? { task_node_ref: taskNodeRef.trim() } : {}),
          };
        }

        const createCfg: Record<string, unknown> = {
          action: "create_task",
          ...(taskTitle.trim() ? { title: taskTitle.trim() } : {}),
          ...(taskPriority.trim() ? { priority: taskPriority.trim() } : {}),
          ...(taskStatus.trim() ? { status: taskStatus.trim() } : {}),
          ...(taskUserMessage.trim() ? { user_message: taskUserMessage.trim() } : {}),
          assignment_mode: taskAssignMode || "none",
        };

        if (taskAssignMode === "fixed" && taskAssignTo.trim()) {
          createCfg.assign_to = taskAssignTo.trim();
        }
        if (taskAssignMode === "variable" && taskAssignVar.trim()) {
          createCfg.assign_to_var = taskAssignVar.trim();
        }

        return createCfg;
      }
      default: { try { return JSON.parse(rawJson); } catch { return {}; } }
    }
  }

  function handleSave() {
    if (!id.trim()) { setErr(t("nodeModal.idRequired")); return; }
    if (type === "menu" && !showJson && hasMenuValidationErrors) {
      setErr(t("nodeModal.menuValidation"));
      return;
    }
    let branches: Record<string, string>;
    if (type === "condition" && !showJson) {
      const parsed = parseBranchesSafely(branchesJson) ?? {};
      branches = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => {
          const normalized = key.trim().toLowerCase();
          return !CONDITION_TRUE_ALIASES.includes(normalized) && !CONDITION_FALSE_ALIASES.includes(normalized);
        })
      );
      if (condTrueNext.trim()) branches.true = condTrueNext.trim();
      if (condFalseNext.trim()) branches.false = condFalseNext.trim();
    } else if (type === "menu" && !showJson) {
      branches = buildBranchesFromOptions(menuOptions);
    } else {
      try {
        const parsed = JSON.parse(branchesJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setErr(t("nodeModal.invalidBranches"));
          return;
        }
        branches = parsed as Record<string, string>;
      } catch {
        setErr(t("nodeModal.invalidBranches"));
        return;
      }
    }
    let config: Record<string, unknown>;
    if (showJson) {
      try { config = JSON.parse(rawJson); } catch { setErr(t("nodeModal.invalidConfig")); return; }
    } else {
      config = buildConfig();
    }
    onSave({
      id: id.trim(),
      type,
      config,
      ...(isTerminalNode ? { next: null } : { next: next || null }),
      ...(isTerminalNode ? {} : { branches }),
    });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-800">{node.id ? t("nodeModal.titleEdit") : t("nodeModal.titleNew")}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setRawJson(JSON.stringify(buildConfig(), null, 2)); setShowJson((v) => !v); }}
              className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                showJson ? "bg-slate-800 text-white border-slate-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
              }`}
            >
              {showJson ? t("nodeModal.toggleForm") : t("nodeModal.toggleJson")}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4">
          {/* ID + Type */}
          <div className="grid grid-cols-3 gap-4 mb-6 pb-6 border-b border-slate-100">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">ID del nodo</label>
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="node_1" disabled={!!node.id}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">Tipo</label>
              <select value={type} onChange={(e) => setType(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {!isTerminalNode && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-2">Siguiente nodo (next)</label>
                <select value={next} onChange={(e) => setNext(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">— ninguno —</option>
                  {allNodeIds.filter((nid) => nid !== id).map((nid) => (
                    <option key={nid} value={nid}>{nodeLabel(nid)}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {isTerminalNode && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 mb-6">
              Este nodo es terminal. Solo define el contenido; no usa next ni branches.
            </div>
          )}

          {/* Config */}
          {showJson ? (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">Config (JSON)</label>
              <textarea value={rawJson} onChange={(e) => setRawJson(e.target.value)} rows={10}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          ) : (
            <div className="space-y-5">
              {/* message */}
              {type === "message" && (
                <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                  <label className="block text-xs font-medium text-slate-600 mb-2">Mensaje</label>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
                    placeholder="Hola {{variables.nombre}}, ¿en qué te puedo ayudar?"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
              {/* input */}
              {type === "input" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Pregunta al usuario</label>
                    <textarea value={inputText} onChange={(e) => setInputText(e.target.value)} rows={3}
                      placeholder="¿Cuál es tu número de cédula?"
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Guardar respuesta en variable</label>
                    <VarComboInput value={inputVar} onChange={setInputVar} placeholder="variables.cedula"
                      suggestions={flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>

                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">{t("nodeModal.inputValidationType")}</label>
                    <select
                      value={inputValidationType}
                      onChange={(e) => setInputValidationType(String(e.target.value ?? "none"))}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="none">{t("nodeModal.inputValidationNone")}</option>
                      <option value="cedula">{t("nodeModal.inputValidationCedula")}</option>
                      <option value="numeric">{t("nodeModal.inputValidationNumeric")}</option>
                      <option value="email">{t("nodeModal.inputValidationEmail")}</option>
                      <option value="regex">{t("nodeModal.inputValidationRegex")}</option>
                    </select>

                    {inputValidationType === "regex" && (
                      <div className="grid grid-cols-3 gap-3 mt-3">
                        <div className="col-span-2">
                          <label className="block text-xs font-medium text-slate-600 mb-2">{t("nodeModal.inputValidationPattern")}</label>
                          <input
                            value={inputValidationPattern}
                            onChange={(e) => setInputValidationPattern(e.target.value)}
                            placeholder="^\\d{6,13}$"
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-2">{t("nodeModal.inputValidationFlags")}</label>
                          <input
                            value={inputValidationFlags}
                            onChange={(e) => setInputValidationFlags(e.target.value)}
                            placeholder="i"
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      </div>
                    )}

                    <div className="mt-3">
                      <label className="block text-xs font-medium text-slate-600 mb-2">{t("nodeModal.inputValidationMessage")}</label>
                      <input
                        value={inputValidationMessage}
                        onChange={(e) => setInputValidationMessage(e.target.value)}
                        placeholder={t("nodeModal.inputValidationMessagePlaceholder")}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                      <p className="font-semibold mb-1">{t("nodeModal.inputValidationHelpTitle")}</p>
                      <p>{t("nodeModal.inputValidationHelpBody")}</p>
                      <p className="mt-1 font-mono">{t("nodeModal.inputValidationExampleCedula")}</p>
                      <p className="mt-1 font-mono">{t("nodeModal.inputValidationExampleEmail")}</p>
                    </div>
                  </div>
                </div>
              )}
              {/* menu */}
              {type === "menu" && (
                <div className="space-y-4">
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Texto del menú</label>
                    <textarea value={menuText} onChange={(e) => setMenuText(e.target.value)} rows={2}
                      placeholder="¿En qué te puedo ayudar?"
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <MenuOptionsEditor
                      options={menuOptions}
                      nextNodeOptions={allNodeIds.map((nid) => ({ value: nid, label: nodeLabel(nid) }))}
                      onAddOption={() => {
                        setMenuOptions((prev) => {
                          const nextOptions = [...prev, { id: `opt_${prev.length + 1}`, title: "", next: "" }];
                          setBranchesJson(JSON.stringify(buildBranchesFromOptions(nextOptions), null, 2));
                          return nextOptions;
                        });
                      }}
                      onRemoveOption={(index) => {
                        setMenuOptions((prev) => {
                          const nextOptions = prev.filter((_, i) => i !== index);
                          setBranchesJson(JSON.stringify(buildBranchesFromOptions(nextOptions), null, 2));
                          return nextOptions;
                        });
                      }}
                      onChangeOption={(index, key, value) => {
                        setMenuOptions((prev) => {
                          const nextOptions = prev.map((option, i) => i === index ? { ...option, [key]: value } : option);
                          setBranchesJson(JSON.stringify(buildBranchesFromOptions(nextOptions), null, 2));
                          return nextOptions;
                        });
                      }}
                      showNextSelector
                      title={t("nodeModal.menuOptionsTitle")}
                      addLabel={t("nodeModal.add")}
                      emptyText={t("nodeModal.menuOptionsEmpty")}
                      idPlaceholder="id_opcion"
                      titlePlaceholder={t("nodeModal.menuOptionTitlePlaceholder")}
                      nextPlaceholder={t("nodeModal.nextPlaceholder")}
                    />
                  </div>
                  {hasMenuValidationErrors && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 space-y-1">
                      {menuValidation.duplicateIds.length > 0 && (
                        <p>IDs duplicados: {menuValidation.duplicateIds.join(", ")}</p>
                      )}
                      {menuValidation.missingIdIndexes.length > 0 && (
                        <p>Opciones sin ID: {menuValidation.missingIdIndexes.map((i) => i + 1).join(", ")}</p>
                      )}
                    </div>
                  )}
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Guardar selección en variable</label>
                    <VarComboInput value={menuVar} onChange={setMenuVar} placeholder="variables.opcion_menu"
                      suggestions={flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
              )}
              {/* condition */}
              {type === "condition" && (
                <div className="grid grid-cols-5 gap-4">
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Variable</label>
                    <VarComboInput value={condVar} onChange={setCondVar} placeholder="variables.estatus"
                      suggestions={flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS}
                      className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Operador</label>
                    <select value={condOp} onChange={(e) => setCondOp(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {CONDITION_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                    </select>
                  </div>
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Valor</label>
                    <input value={condVal} onChange={(e) => setCondVal(e.target.value)} placeholder="activo"
                      className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Si cumple (true)</label>
                    <select value={condTrueNext} onChange={(e) => setCondTrueNext(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                      <option value="">— ninguno —</option>
                      {allNodeIds.filter((nid) => nid !== id).map((nid) => (
                        <option key={nid} value={nid}>{nodeLabel(nid)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Si no cumple (false)</label>
                    <select value={condFalseNext} onChange={(e) => setCondFalseNext(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                      <option value="">— ninguno —</option>
                      {allNodeIds.filter((nid) => nid !== id).map((nid) => (
                        <option key={nid} value={nid}>{nodeLabel(nid)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {/* delay */}
              {type === "delay" && (
                <div className="bg-slate-50 rounded-lg border border-slate-100 p-4 max-w-xs">
                  <label className="block text-xs font-medium text-slate-600 mb-2">Duración (segundos)</label>
                  <input type="number" min={1} value={delaySeconds} onChange={(e) => setDelaySeconds(Number(e.target.value))}
                    className="w-24 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
              {/* end */}
              {type === "end" && (
                <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                  <label className="block text-xs font-medium text-slate-600 mb-2">Mensaje de cierre (opcional)</label>
                  <textarea value={endMsg} onChange={(e) => setEndMsg(e.target.value)} rows={2}
                    placeholder="Gracias por contactarnos. ¡Hasta pronto!"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
              {/* handoff */}
              {type === "handoff" && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Departamento / Agente</label>
                    <VarComboInput
                      value={handoffDept}
                      onChange={setHandoffDept}
                      placeholder="soporte_tecnico"
                      suggestions={handoffDepartmentSuggestions}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    />
                  </div>
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <label className="block text-xs font-medium text-slate-600 mb-2">Mensaje al transferir</label>
                    <textarea value={handoffMsg} onChange={(e) => setHandoffMsg(e.target.value)} rows={2}
                      placeholder="Te transfiero con un agente..."
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
              )}
              {/* llm */}
              {type === "llm" && (
                <div className="space-y-4">
                  {/* Compose mode + fallback */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                      <label className="block text-xs font-medium text-slate-600 mb-2">Modo de ejecución</label>
                      <select
                        value={llmComposeMode}
                        onChange={(e) => setLlmComposeMode(e.target.value as "sequential" | "parallel" | "first_match")}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white"
                      >
                        <option value="sequential">Secuencial — en orden, contexto acumulado</option>
                        <option value="parallel">Paralelo — simultáneo, variables independientes</option>
                        <option value="first_match">Primer resultado — se detiene al primer éxito</option>
                      </select>
                    </div>
                    <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                      <label className="block text-xs font-medium text-slate-600 mb-2">Texto de respaldo (si no hay salida de texto)</label>
                      <input
                        type="text"
                        value={llmFallbackText}
                        onChange={(e) => setLlmFallbackText(e.target.value)}
                        placeholder="Procesando tu solicitud..."
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                      />
                    </div>
                  </div>

                  {/* Prompt list */}
                  <div className="space-y-3">
                    {llmPrompts.map((prompt, idx) => (
                      <div key={prompt.id} className="bg-slate-50 rounded-lg border border-slate-200 p-4">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-semibold text-violet-700 bg-violet-50 border border-violet-100 rounded-full px-2.5 py-0.5">
                            Prompt {idx + 1}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              disabled={idx === 0}
                              onClick={() => {
                                const next = [...llmPrompts];
                                [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                                setLlmPrompts(next);
                              }}
                              className="p-1 rounded text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition"
                              title="Subir"
                            >↑</button>
                            <button
                              disabled={idx === llmPrompts.length - 1}
                              onClick={() => {
                                const next = [...llmPrompts];
                                [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                                setLlmPrompts(next);
                              }}
                              className="p-1 rounded text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition"
                              title="Bajar"
                            >↓</button>
                            {llmPrompts.length > 1 && (
                              <button
                                onClick={() => setLlmPrompts(llmPrompts.filter((_, i) => i !== idx))}
                                className="p-1 rounded text-slate-400 hover:text-red-600 transition"
                                title="Eliminar prompt"
                              >✕</button>
                            )}
                          </div>
                        </div>
                        <div className="space-y-3">
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Prompt del sistema</label>
                            <textarea
                              value={prompt.systemPrompt}
                              onChange={(e) => {
                                const next = [...llmPrompts];
                                next[idx] = { ...next[idx], systemPrompt: e.target.value };
                                setLlmPrompts(next);
                              }}
                              rows={4}
                              placeholder="Analiza el mensaje del usuario y responde con JSON: {intención, sentimiento, urgencia}. Usa {{input}} para el mensaje actual."
                              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">Formato de salida</label>
                              <select
                                value={prompt.outputMode}
                                onChange={(e) => {
                                  const next = [...llmPrompts];
                                  next[idx] = { ...next[idx], outputMode: e.target.value as "text" | "json" };
                                  setLlmPrompts(next);
                                }}
                                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white"
                              >
                                <option value="text">Texto — respuesta al usuario</option>
                                <option value="json">JSON — guardar en variable</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">
                                {prompt.outputMode === "json" ? "Variable destino (requerida)" : "Variable destino (opcional)"}
                              </label>
                              <VarComboInput
                                value={prompt.targetVariable}
                                onChange={(v) => {
                                  const next = [...llmPrompts];
                                  next[idx] = { ...next[idx], targetVariable: v };
                                  setLlmPrompts(next);
                                }}
                                placeholder="analisis_llm"
                                suggestions={flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS}
                                className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-500 ${prompt.outputMode === "json" && !prompt.targetVariable.trim() ? "border-red-300 bg-red-50" : "border-slate-200"}`}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() => setLlmPrompts([...llmPrompts, { id: `p${Date.now()}`, systemPrompt: "", outputMode: "text", targetVariable: "" }])}
                    className="w-full py-2 rounded-lg border border-dashed border-violet-300 text-violet-600 text-sm hover:bg-violet-50 transition"
                  >
                    + Agregar prompt
                  </button>
                  <p className="text-xs text-slate-400">Las credenciales del modelo LLM se configuran en <strong>Configuración › IA</strong>. Aquí se define la lógica de decisión por nodo.</p>
                </div>
              )}
              {/* task */}
              {type === "task" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                      <label className="block text-xs font-medium text-slate-600 mb-2">Acción de tarea</label>
                      <select
                        value={taskAction}
                        onChange={(e) => setTaskAction(String(e.target.value ?? "create_task"))}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                      >
                        <option value="create_task">Crear solicitud</option>
                        <option value="wait_for_task">Esperar estado de solicitud</option>
                      </select>
                    </div>
                    <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                      <label className="block text-xs font-medium text-slate-600 mb-2">Estado objetivo</label>
                      <select
                        value={taskStatus}
                        onChange={(e) => setTaskStatus(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                      >
                        <option value="open">open</option>
                        <option value="in_progress">in_progress</option>
                        <option value="pending_info">pending_info</option>
                        <option value="completed">completed</option>
                        <option value="rejected">rejected</option>
                      </select>
                    </div>
                  </div>

                  {taskAction === "create_task" && (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                          <label className="block text-xs font-medium text-slate-600 mb-2">Título de la solicitud</label>
                          <input
                            value={taskTitle}
                            onChange={(e) => setTaskTitle(e.target.value)}
                            placeholder="Seguimiento de caso"
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                          />
                        </div>
                        <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                          <label className="block text-xs font-medium text-slate-600 mb-2">Prioridad</label>
                          <select
                            value={taskPriority}
                            onChange={(e) => setTaskPriority(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                          >
                            <option value="baja">baja</option>
                            <option value="normal">normal</option>
                            <option value="media">media</option>
                            <option value="alta">alta</option>
                            <option value="critica">critica</option>
                          </select>
                        </div>
                      </div>

                      <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                        <label className="block text-xs font-medium text-slate-600 mb-2">Mensaje al usuario (opcional)</label>
                        <textarea
                          value={taskUserMessage}
                          onChange={(e) => setTaskUserMessage(e.target.value)}
                          rows={2}
                          placeholder="He creado tu solicitud y la estamos gestionando."
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>

                      <div className="grid grid-cols-3 gap-4">
                        <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                          <label className="block text-xs font-medium text-slate-600 mb-2">Modo de asignación</label>
                          <select
                            value={taskAssignMode}
                            onChange={(e) => setTaskAssignMode(String(e.target.value ?? "none"))}
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                          >
                            <option value="none">Sin asignar</option>
                            <option value="fixed">Agente fijo (ID)</option>
                            <option value="variable">Desde variable</option>
                            <option value="least_load">Automática por menor carga</option>
                          </select>
                        </div>

                        <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                          <label className="block text-xs font-medium text-slate-600 mb-2">Agente ID (si fijo)</label>
                          <input
                            value={taskAssignTo}
                            onChange={(e) => setTaskAssignTo(e.target.value)}
                            placeholder="15"
                            disabled={taskAssignMode !== "fixed"}
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100"
                          />
                        </div>

                        <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                          <label className="block text-xs font-medium text-slate-600 mb-2">Variable agente (si variable)</label>
                          <VarComboInput
                            value={taskAssignVar}
                            onChange={setTaskAssignVar}
                            placeholder="variables.agente_id"
                            suggestions={flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS}
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {taskAction === "wait_for_task" && (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                          <label className="block text-xs font-medium text-slate-600 mb-2">Variable con task_id</label>
                          <VarComboInput
                            value={taskIdVar}
                            onChange={setTaskIdVar}
                            placeholder="task_id"
                            suggestions={flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS}
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                          />
                        </div>
                        <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                          <label className="block text-xs font-medium text-slate-600 mb-2">Node ref de creación (opcional)</label>
                          <input
                            value={taskNodeRef}
                            onChange={(e) => setTaskNodeRef(e.target.value)}
                            placeholder="node_12"
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                          />
                        </div>
                      </div>

                      <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                        <label className="block text-xs font-medium text-slate-600 mb-2">Mensaje mientras espera (opcional)</label>
                        <textarea
                          value={taskWaitMessage}
                          onChange={(e) => setTaskWaitMessage(e.target.value)}
                          rows={2}
                          placeholder="Tu solicitud sigue en proceso. Te aviso cuando se complete."
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
              {/* action / menu / input / message webhook call */}
              {supportsEndpointMapping && (
                <div className="space-y-4 border-t border-slate-100 pt-4 mt-4">
                  <div className="mb-3">
                    {normalizedType === "menu" && (
                      <p className="text-xs font-medium text-slate-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                        📲 Llamado de endpoint/webhook al seleccionar opción (opcional)
                      </p>
                    )}
                    {(normalizedType === "input" || normalizedType === "open_response") && (
                      <p className="text-xs font-medium text-slate-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
                        📝 Llamado de endpoint/webhook después de capturar la respuesta (opcional)
                      </p>
                    )}
                    {(normalizedType === "message" || normalizedType === "text") && (
                      <p className="text-xs font-medium text-slate-700 bg-purple-50 border border-purple-100 rounded-lg px-3 py-2">
                        💬 Llamado de endpoint/webhook después de enviar el mensaje (opcional)
                      </p>
                    )}
                    {(["condition", "end", "llm", "handoff"].includes(normalizedType)) && (
                      <p className="text-xs font-medium text-slate-700 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2">
                        ⚙️ Llamado de endpoint/webhook en este nodo (opcional)
                      </p>
                    )}
                  </div>
                  
                  {/* Catalog endpoint picker */}
                  {catalogEndpoints.length > 0 && (
                    <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <label className="block text-xs font-medium text-slate-600">Endpoint del catálogo</label>
                        <button
                          type="button"
                          onClick={() => {
                            if (endpointContext) {
                              autoConfigureEndpoint(endpointContext);
                              return;
                            }
                            if (catalogEndpoints.length > 0) {
                              autoConfigureEndpoint(catalogEndpoints[0]);
                            }
                          }}
                          className="text-xs px-2.5 py-1 rounded-lg border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 transition"
                        >
                          🤖 Configurar con IA
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {catalogEndpoints.map((ep) => (
                          <button key={ep.id} onClick={() => applyEndpoint(ep)}
                            className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                              actionRef === ep.id
                                ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                                : "bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:bg-blue-50"
                            }`}>
                            {ep.sessionInit ? "⚡ " : ""}{ep.name}
                          </button>
                        ))}
                        {actionRef && (
                          <button onClick={() => setActionRef("")}
                            className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 text-slate-400 hover:text-red-600 transition">
                            ✕ Personalizado
                          </button>
                        )}
                      </div>
                      {selectedEp?.description && (
                        <p className="text-xs text-slate-500 mt-2 italic border-l-2 border-slate-300 pl-2">{selectedEp.description}</p>
                      )}
                    </div>
                  )}
                  
                  {/* Integrations picker */}
                  {integrations.length > 0 && (
                    <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                      <label className="block text-xs font-medium text-slate-600 mb-3">Integración</label>
                      <div className="flex flex-wrap gap-2">
                        {integrations.map((intg) => (
                          <button key={intg.id} onClick={() => setActionRef(String(intg.id))}
                            className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                              actionRef === String(intg.id)
                                ? "bg-violet-600 text-white border-violet-600 shadow-sm"
                                : "bg-white text-slate-600 border-slate-200 hover:border-violet-300 hover:bg-violet-50"
                            }`}>
                            {intg.tipo === "webhook" ? "🔗 " : intg.tipo === "rest" ? "⚙️ " : ""}{intg.nombre}
                          </button>
                        ))}
                        {actionRef && (
                          <button onClick={() => setActionRef("")}
                            className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 text-slate-400 hover:text-red-600 transition">
                            ✕ Limpiar
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* Method + URL */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className="col-span-1 bg-slate-50 rounded-lg border border-slate-100 p-4">
                      <label className="block text-xs font-medium text-slate-600 mb-2">Método HTTP</label>
                      <select value={actionMethod} onChange={(e) => setActionMethod(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                        {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                    <div className="col-span-3 bg-slate-50 rounded-lg border border-slate-100 p-4">
                      <label className="block text-xs font-medium text-slate-600 mb-2">URL del endpoint</label>
                      <datalist id="waba-url-suggestions">
                        {catalogEndpoints.map((ep) => (
                          <option key={ep.id} value={ep.url}>{ep.name}</option>
                        ))}
                      </datalist>
                      <input list="waba-url-suggestions" value={actionUrl} onChange={(e) => handleActionUrlChange(e.target.value)} placeholder="/api/billing/balance"
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white" />
                    </div>
                  </div>
                  
                  {/* Body params */}
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold text-slate-600">📤 Parámetros del body (inputs)</span>
                      <button onClick={() => setActionBody((b) => [...b, { key: "", value: "" }])}
                        className="flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800 font-medium">
                        <Plus className="w-3.5 h-3.5" /> Agregar
                      </button>
                    </div>
                    {requiresTenantBody && (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mb-3">
                        Este endpoint requiere tenant. Se enviará automáticamente `tenantSlug` si no está mapeado.
                      </p>
                    )}
                    {actionBody.length === 0 && (
                      <p className="text-xs text-slate-400 italic">Sin parámetros. Selecciona un endpoint o haz click en &quot;+ Agregar&quot;.</p>
                    )}
                    <div className="space-y-2">
                      {actionBody.map((row, i) => (
                        <div key={i} className="flex gap-2 items-center bg-white rounded-lg border border-slate-200 p-2">
                          <input value={row.key} onChange={(e) => setActionBody((b) => b.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                            placeholder="campo_api"
                            className="w-32 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <span className="text-slate-400 text-xs shrink-0 font-medium">→</span>
                          <VarComboInput value={row.value} onChange={(v) => setActionBody((b) => b.map((r, j) => j === i ? { ...r, value: v } : r))}
                            placeholder="variables.cedula o valor fijo"
                            suggestions={flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS}
                            className="flex-1 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <button onClick={() => setActionBody((b) => b.filter((_, j) => j !== i))}
                            className="text-red-400 hover:text-red-600 shrink-0 transition"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  {/* Response mapping */}
                  <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold text-slate-600">📥 Mapeo de respuesta (outputs → variables)</span>
                      <button onClick={() => setActionResponse((r) => [...r, { key: "", value: "" }])}
                        className="flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800 font-medium">
                        <Plus className="w-3.5 h-3.5" /> Agregar
                      </button>
                    </div>
                    {actionResponse.length === 0 && (
                      <p className="text-xs text-slate-400 italic">Sin mapeo. Selecciona un endpoint o haz click en &quot;+ Agregar&quot;.</p>
                    )}
                    <div className="space-y-2">
                      {actionResponse.map((row, i) => (
                        <div key={i} className="flex gap-2 items-center bg-white rounded-lg border border-slate-200 p-2">
                          <input value={row.key} onChange={(e) => setActionResponse((r) => r.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                            placeholder="campo_respuesta"
                            className="w-32 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <span className="text-slate-400 text-xs shrink-0 font-medium">→</span>
                          <VarComboInput value={row.value} onChange={(v) => setActionResponse((r) => r.map((x, j) => j === i ? { ...x, value: v } : x))}
                            placeholder="variables.saldo"
                            suggestions={flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS}
                            className="flex-1 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <button onClick={() => setActionResponse((r) => r.filter((_, j) => j !== i))}
                            className="text-red-400 hover:text-red-600 shrink-0 transition"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Next + Branches */}
          {!isTerminalNode ? (
            <div className="mt-6 pt-6 border-t border-slate-100">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                  <label className="block text-xs font-medium text-slate-600 mb-2">Siguiente nodo (next)</label>
                  <select value={next} onChange={(e) => setNext(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                    <option value="">— ninguno —</option>
                    {allNodeIds.filter((nid) => nid !== id).map((nid) => (
                      <option key={nid} value={nid}>{nodeLabel(nid)}</option>
                    ))}
                  </select>
                </div>
                <div className="bg-slate-50 rounded-lg border border-slate-100 p-4">
                  <label className="block text-xs font-medium text-slate-600 mb-2">Branches (JSON)</label>
                  <textarea value={branchesJson} onChange={(e) => setBranchesJson(e.target.value)} rows={3}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white" />
                </div>
              </div>
            </div>
          ) : null}

          {err && <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg"><p className="text-xs text-red-700 font-medium">{err}</p></div>}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">{t("nodeModal.cancel")}</button>
          <button onClick={handleSave}
            disabled={type === "menu" && !showJson && hasMenuValidationErrors}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
            {t("nodeModal.saveNode")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: FlowBuilder (full editor for a flow)
// ─────────────────────────────────────────────────────────────────────────────
function FlowBuilder({
  flow,
  onBack,
  onRefresh,
}: {
  flow: WabaFlow;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const t = useTranslations("wabaFlows");
  const { tenantSlug } = useAuthStore();
  const [activeVersion, setActiveVersion] = useState<(FlowVersion & { definition?: FlowDefinition }) | null>(null);
  const [definition, setDefinition] = useState<FlowDefinition | null>(null);
  const [editingNode, setEditingNode] = useState<Partial<NodeDef> | null>(null);
  const [jsonView, setJsonView] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ internal: { valid: boolean; errors: string[]; warnings: string[] }; waba: { valid: boolean; errors: string[] } } | null>(null);
  const [changelog, setChangelog] = useState("");
  const [integrations, setIntegrations] = useState<{ id: number; nombre: string; tipo: string }[]>([]);
  const [catalogEndpoints, setCatalogEndpoints] = useState<CatalogEndpoint[]>([]);
  const [flowVariables, setFlowVariables] = useState<string[]>([]);
  const validationErrors = validation?.internal?.errors ?? [];
  const validationWarnings = validation?.internal?.warnings ?? [];
  const wabaValidationErrors = validation?.waba?.errors ?? [];
  const flatNodesList = definition ? flattenNodes(definition.nodes) : [];

  const loadLatestVersion = useCallback(async () => {
    try {
      const { data } = await wabaFlowsApi.listVersions(flow.id, tenantSlug);
      const versions = Array.isArray(data)
        ? data
        : Array.isArray((data as { versions?: FlowVersion[] })?.versions)
          ? (data as { versions: FlowVersion[] }).versions
          : [];
      if (!versions.length) return;
      const latest = versions[0];
      const { data: vd } = await wabaFlowsApi.getVersion(flow.id, latest.id, tenantSlug);
      const normalizedDefinition = normalizeFlowDefinition(vd.definition as FlowDefinition);
      setActiveVersion({ ...latest, definition: normalizedDefinition });
      setDefinition(normalizedDefinition);
      setJsonText(JSON.stringify(normalizedDefinition, null, 2));
    } catch { /* ignore */ }
  }, [flow.id, tenantSlug]);

  useEffect(() => {
    loadLatestVersion();
    integrationsApi
      .list({ activo: true })
      .then(({ data }) => {
        const normalized = Array.isArray(data)
          ? data
          : Array.isArray((data as { integrations?: { id: number; nombre: string; tipo: string }[] })?.integrations)
            ? (data as { integrations: { id: number; nombre: string; tipo: string }[] }).integrations
            : [];
        setIntegrations(normalized);
      })
      .catch(() => setIntegrations([]));
    integrationsApi.getCatalog()
      .then(({ data }) => {
        const d = data as { data?: { endpoints?: CatalogEndpoint[] } | CatalogEndpoint[]; endpoints?: CatalogEndpoint[] } | CatalogEndpoint[];
        const eps = Array.isArray(d) ? d
          : Array.isArray((d as { data?: { endpoints?: CatalogEndpoint[] } | CatalogEndpoint[] }).data)
            ? (d as { data: CatalogEndpoint[] }).data
          : Array.isArray(((d as { data?: { endpoints?: CatalogEndpoint[] } }).data as { endpoints?: CatalogEndpoint[] } | undefined)?.endpoints)
            ? (((d as { data?: { endpoints?: CatalogEndpoint[] } }).data as { endpoints: CatalogEndpoint[] }).endpoints)
          : Array.isArray((d as { endpoints?: CatalogEndpoint[] }).endpoints) ? (d as { endpoints: CatalogEndpoint[] }).endpoints
          : [];
        setCatalogEndpoints(eps);
      })
      .catch(() => setCatalogEndpoints([]));
    if (!tenantSlug) {
      setFlowVariables([]);
      return;
    }

    variablesApi.list({ tenantSlug })
      .then(({ data }) => {
        const vars = Array.isArray(data) ? data : [];
        setFlowVariables(vars.map((v: { nombre: string }) => `variables.${v.nombre}`));
      })
      .catch(() => setFlowVariables([]));
  }, [loadLatestVersion, tenantSlug]);

  function handleAddNode() {
    const ids = definition ? flattenNodes(definition.nodes).map((n) => n.id) : [];
    const usedIds = new Set(ids);

    const maxNodeNumber = ids.reduce((max, id) => {
      const match = id.match(/^node_(\d+)$/i);
      if (!match) return max;
      const value = Number(match[1]);
      return Number.isFinite(value) ? Math.max(max, value) : max;
    }, 0);

    let candidate = Math.max(1, maxNodeNumber + 1);
    while (usedIds.has(`node_${candidate}`)) {
      candidate += 1;
    }

    const nextId = `node_${candidate}`;
    setEditingNode({ id: nextId, type: "message", config: { text: "" }, next: null, branches: {} });
  }

  function handleSaveNode(node: NodeDef) {
    setDefinition((prev) => {
      if (!prev) return prev;
      const result = upsertNode(prev.nodes, node);
      const nodes = result.updated ? result.nodes : [...prev.nodes, node];
      const newDef = normalizeFlowDefinition({ ...prev, nodes });
      if (!newDef.entry_point && flattenNodes(nodes).length === 1) newDef.entry_point = node.id;
      setJsonText(JSON.stringify(newDef, null, 2));
      return newDef;
    });
    setEditingNode(null);
  }

  function handleDeleteNode(id: string) {
    setDefinition((prev) => {
      if (!prev) return prev;
      const nodes = removeNode(prev.nodes, id);
      const newDef = normalizeFlowDefinition({ ...prev, nodes });
      setJsonText(JSON.stringify(newDef, null, 2));
      return newDef;
    });
  }

  function handleMoveNode(id: string, direction: -1 | 1) {
    setDefinition((prev) => {
      if (!prev) return prev;
      const idx = prev.nodes.findIndex((n) => n.id === id);
      if (idx < 0) return prev;
      const nextIdx = idx + direction;
      if (nextIdx < 0 || nextIdx >= prev.nodes.length) return prev;

      const nodes = [...prev.nodes];
      const [moved] = nodes.splice(idx, 1);
      nodes.splice(nextIdx, 0, moved);

      const newDef = normalizeFlowDefinition({ ...prev, nodes });
      setJsonText(JSON.stringify(newDef, null, 2));
      return newDef;
    });
  }

  function handleEntryPointChange(id: string) {
    setDefinition((prev) => {
      if (!prev) return prev;
      const newDef = normalizeFlowDefinition({ ...prev, entry_point: id });
      setJsonText(JSON.stringify(newDef, null, 2));
      return newDef;
    });
  }

  function handleJsonApply() {
    try {
      const parsed = parseJsonLenient(jsonText);
      const coercedDefinition = coerceToFlowDefinition(parsed);
      const normalizedDefinition = normalizeFlowDefinition(coercedDefinition);
      setDefinition(normalizedDefinition);
      setJsonText(JSON.stringify(normalizedDefinition, null, 2));
      setJsonError("");
    } catch {
      setJsonError(t("importModal.invalidJson"));
    }
  }

  function handleCanvasChange(nextDefinition: FlowDefinition) {
    const normalizedDefinition = normalizeFlowDefinition(nextDefinition);
    setDefinition(normalizedDefinition);
    setJsonText(JSON.stringify(normalizedDefinition, null, 2));
  }

  function handleAutoArrange() {
    setDefinition((prev) => {
      if (!prev) return prev;

      // Force a fresh hierarchical layout by clearing persisted positions first.
      const newDef = normalizeFlowDefinition({ ...prev, nodePositions: {} });
      setJsonText(JSON.stringify(newDef, null, 2));
      return newDef;
    });
  }

  async function handleValidate() {
    if (!definition) return;
    setValidating(true);
    try {
      const { data } = await wabaFlowsApi.validate(flow.id, { definition });
      setValidation({
        internal: {
          valid: Boolean(data?.internal?.valid),
          errors: Array.isArray(data?.internal?.errors) ? data.internal.errors : [],
          warnings: Array.isArray(data?.internal?.warnings) ? data.internal.warnings : [],
        },
        waba: {
          valid: Boolean(data?.waba?.valid),
          errors: Array.isArray(data?.waba?.errors) ? data.waba.errors : [],
        },
      });
    } catch { /* ignore */ } finally { setValidating(false); }
  }

  async function handleSaveVersion() {
    if (!definition) return;
    setSaveError("");
    setSaving(true);
    try {
      await wabaFlowsApi.saveVersion(flow.id, {
        definition,
        changelog: changelog || undefined,
        tenantSlug,
      });
      setChangelog("");
      await loadLatestVersion();
      onRefresh();
    } catch (error: unknown) {
      const msg = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveError(msg ?? t("builder.saveVersionError"));
    } finally { setSaving(false); }
  }

  async function handleExport() {
    const { data } = await wabaFlowsApi.export(flow.id);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${flow.nombre.replace(/\s+/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-slate-400 hover:text-slate-700">
            <ChevronRight className="w-5 h-5 rotate-180" />
          </button>
          <h2 className="text-lg font-semibold text-slate-800">{flow.nombre}</h2>
          {activeVersion && (
            <span className="text-xs text-slate-500">v{activeVersion.versionNumber}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setJsonView((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition ${
              jsonView ? "bg-slate-800 text-white border-slate-700" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            }`}
          >
            <FileJson className="w-3.5 h-3.5" />
            {jsonView ? t("builder.toggleVisual") : t("builder.toggleJson")}
          </button>
          <button
            onClick={handleAutoArrange}
            disabled={!definition}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200 disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t("builder.autoArrange")}
          </button>
          <button
            onClick={handleValidate}
            disabled={validating}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200"
          >
            {validating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {t("builder.validate")}
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
          >
            <Download className="w-3.5 h-3.5" />
            {t("builder.export")}
          </button>
        </div>
      </div>

      {/* Validation results */}
      {validation && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${validation.internal.valid ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
          <div className="flex items-center gap-2 font-medium mb-1">
            {validation.internal.valid
              ? <CheckCircle2 className="w-4 h-4 text-green-600" />
              : <XCircle className="w-4 h-4 text-red-600" />}
            <span className={validation.internal.valid ? "text-green-700" : "text-red-700"}>
              {validation.internal.valid ? t("builder.flowValid") : t("builder.errorsFound", { count: validationErrors.length })}
            </span>
          </div>
          {validationErrors.map((e, i) => (
            <p key={i} className="text-red-600 text-xs ml-6">• {e}</p>
          ))}
          {validationWarnings.map((w, i) => (
            <p key={i} className="text-amber-600 text-xs ml-6">⚠ {w}</p>
          ))}
          {!validation.waba.valid && wabaValidationErrors.map((e, i) => (
            <p key={i} className="text-orange-600 text-xs ml-6">WABA: {e}</p>
          ))}
        </div>
      )}

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Visual canvas / JSON editor */}
        <div className="flex-[1.5] flex flex-col min-h-0">
          {jsonView ? (
            <div className="flex flex-col flex-1 gap-2">
              <textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              {jsonError && <p className="text-red-600 text-xs">{jsonError}</p>}
              <button
                onClick={handleJsonApply}
                className="self-end px-4 py-2 rounded-xl bg-slate-800 text-white text-sm font-medium hover:bg-slate-700"
              >
                {t("builder.applyJson")}
              </button>
            </div>
          ) : (
            <div className="flex flex-col flex-1 gap-3 min-h-0">
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
                {t("builder.visualHint")}
              </div>
              <div className="flex-1 min-h-0 rounded-2xl border border-slate-200 bg-white overflow-hidden">
                {definition ? (
                  <CanvasEditor
                    definition={definition}
                    onChange={handleCanvasChange}
                    onNodeClick={(nodeId) => {
                      const selectedNode = flatNodesList.find((node) => node.id === nodeId);
                      if (selectedNode) {
                        setEditingNode(selectedNode);
                      }
                    }}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-slate-400">
                    <RefreshCw className="w-5 h-5 animate-spin" />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Node list */}
        <div className="w-80 flex flex-col min-h-0">
          <div className="flex flex-col flex-1 gap-3 overflow-y-auto pr-1">
            {flatNodesList.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-3 border-2 border-dashed border-slate-200 rounded-2xl">
                <Layers className="w-10 h-10" />
                <p className="text-sm">{t("builder.noNodes")}</p>
                <button
                  onClick={handleAddNode}
                  className="text-sm text-blue-600 hover:underline"
                >{t("builder.addFirstNode")}</button>
              </div>
            )}
            {flatNodesList.map((node, index) => (
              <NodeCard
                key={node.id}
                node={node}
                isEntry={node.id === definition?.entry_point}
                canMoveUp={index > 0}
                canMoveDown={index < flatNodesList.length - 1}
                onMoveUp={(id) => handleMoveNode(id, -1)}
                onMoveDown={(id) => handleMoveNode(id, 1)}
                onEdit={(n) => setEditingNode(n)}
                onDelete={handleDeleteNode}
              />
            ))}
            {flatNodesList.length > 0 && (
              <button
                onClick={handleAddNode}
                className="flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-400 hover:border-blue-300 hover:text-blue-500 transition"
              >
                <Plus className="w-4 h-4" />
                {t("builder.addNode")}
              </button>
            )}
          </div>
        </div>

        {/* Sidebar: entry point + save version */}
        <div className="w-64 flex flex-col gap-4 shrink-0">
          {/* Entry point selector */}
          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
            <label className="block text-xs font-medium text-slate-600 mb-2">{t("builder.entryPoint")}</label>
            <select
              value={definition?.entry_point ?? ""}
              onChange={(e) => handleEntryPointChange(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {flatNodesList.map((n) => (
                <option key={n.id} value={n.id}>{n.id} ({n.type})</option>
              ))}
            </select>
          </div>

          {/* Save new version */}
          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-3">
            <p className="text-xs font-medium text-slate-600">{t("builder.saveVersion")}</p>
            <input
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              placeholder={t("builder.changelogPlaceholder")}
              className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleSaveVersion}
              disabled={saving || !definition}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
              {t("builder.saveVersion")}
            </button>
            {saveError && <p className="text-xs text-red-600">{saveError}</p>}
          </div>

          {/* Quick stats */}
          {definition && (
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-2">
              <p className="text-xs font-medium text-slate-600">{t("builder.stats")}</p>
              <div className="space-y-1 text-xs text-slate-500">
                <div className="flex justify-between"><span>{t("builder.totalNodes")}</span><span className="font-medium text-slate-700">{flatNodesList.length}</span></div>
                <div className="flex justify-between"><span>{t("builder.menu")}</span><span className="font-medium text-slate-700">{flatNodesList.filter((n) => n.type === "menu").length}</span></div>
                <div className="flex justify-between"><span>{t("builder.action")}</span><span className="font-medium text-slate-700">{flatNodesList.filter((n) => n.type === "action").length}</span></div>
                <div className="flex justify-between"><span>{t("builder.end")}</span><span className="font-medium text-slate-700">{flatNodesList.filter((n) => n.type === "end").length}</span></div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Node edit modal */}
      {editingNode && (
        <NodeEditModal
          node={editingNode}
          allNodeIds={flatNodesList.map((n) => n.id)}
          allNodes={flatNodesList}
          catalogEndpoints={catalogEndpoints}
          flowVariables={flowVariables}
          integrations={integrations}
          onSave={handleSaveNode}
          onClose={() => setEditingNode(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: VersionsPanel
// ─────────────────────────────────────────────────────────────────────────────
function VersionsPanel({ flow, onRefresh, tenantSlug }: { flow: WabaFlow; onRefresh: () => void; tenantSlug?: string }) {
  const t = useTranslations("wabaFlows");
  const [versions, setVersions] = useState<FlowVersion[]>([]);
  const [loading, setLoading]   = useState(true);
  const [publishing, setPublishing] = useState<number | null>(null);
  const [rollingBack, setRollingBack] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await wabaFlowsApi.listVersions(flow.id, tenantSlug);
      const normalized = Array.isArray(data)
        ? data
        : Array.isArray((data as { versions?: FlowVersion[] })?.versions)
          ? ((data as { versions: FlowVersion[] }).versions)
          : [];
      setVersions(normalized);
      setActionError(null);
    } finally { setLoading(false); }
  }, [flow.id, tenantSlug]);

  useEffect(() => { reload(); }, [reload]);

  async function togglePublish(v: FlowVersion) {
    setPublishing(v.id);
    try {
      await wabaFlowsApi.publishVersion(flow.id, v.id, !v.published, tenantSlug);
      await reload();
      onRefresh();
    } catch (error: unknown) {
      const msg = (error as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error
        ?? (error as { message?: string })?.message
        ?? t("versions.publishError");
      setActionError(msg);
    } finally { setPublishing(null); }
  }

  async function rollback(v: FlowVersion) {
    setRollingBack(v.id);
    try {
      await wabaFlowsApi.rollback(flow.id, v.id, tenantSlug);
      await reload();
      onRefresh();
    } catch (error: unknown) {
      const msg = (error as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error
        ?? (error as { message?: string })?.message
        ?? t("versions.rollbackError");
      setActionError(msg);
    } finally { setRollingBack(null); }
  }

  if (loading) return <div className="flex items-center justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">{t("versions.title", { flowName: flow.nombre })}</h3>
        <button onClick={reload} className="text-slate-400 hover:text-slate-600"><RefreshCw className="w-4 h-4" /></button>
      </div>
      {actionError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {actionError}
        </div>
      )}
      {versions.length === 0 && (
        <div className="text-center py-10 text-slate-400 text-sm">{t("versions.empty")}</div>
      )}
      {versions.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-4 p-4 bg-white rounded-2xl border border-slate-200 hover:border-slate-300 transition">
          <div className="flex items-start gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${v.published ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
              v{v.versionNumber}
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700">{v.changelog ?? t("versions.versionFallback", { number: v.versionNumber })}</p>
              <p className="text-xs text-slate-400 mt-0.5">{fmtDate(v.createdAt)}</p>
              {v.published && v.publishedAt && (
                <p className="text-xs text-green-600 mt-0.5">{t("versions.publishedOn", { date: fmtDate(v.publishedAt) })}</p>
              )}
              {(() => {
                const errorMessages = extractValidationErrorMessages(v.wabaValidationErrors);
                if (errorMessages.length === 0) return null;

                const visibleErrors = errorMessages.slice(0, 2);
                const remaining = errorMessages.length - visibleErrors.length;

                return (
                  <div className="mt-1.5 space-y-0.5">
                    <p className="text-xs text-red-500">⚠ {t("versions.validationErrors", { count: errorMessages.length })}</p>
                    {visibleErrors.map((msg, idx) => (
                      <p key={`${v.id}-err-${idx}`} className="text-xs text-red-600">• {msg}</p>
                    ))}
                    {remaining > 0 && (
                      <p className="text-xs text-red-500">{t("versions.moreErrors", { count: remaining })}</p>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-1 rounded-full ${STATUS_BADGE[v.wabaValidationStatus] ?? STATUS_BADGE.draft}`}>
              {v.wabaValidationStatus}
            </span>
            <button
              onClick={() => rollback(v)}
              disabled={v.published || rollingBack === v.id}
              title={t("versions.rollback")}
              className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 disabled:opacity-30"
            >
              {rollingBack === v.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => togglePublish(v)}
              disabled={publishing === v.id}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition ${
                v.published
                  ? "bg-green-100 text-green-700 hover:bg-green-200"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {publishing === v.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
              {v.published ? t("versions.published") : t("versions.publish")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: SimulatePanel
// ─────────────────────────────────────────────────────────────────────────────
function SimulatePanel({ flow }: { flow: WabaFlow }) {
  const t = useTranslations("wabaFlows");
  const { tenantSlug } = useAuthStore();
  const [inputs, setInputs]     = useState<string[]>([]);
  const [inputVal, setInputVal] = useState("");
  const [result, setResult]     = useState<SimulationResult | null>(null);
  const [running, setRunning]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  async function runSimulation(mode: "single" | "exhaustive" = "single") {
    setRunning(true);
    setError(null);
    try {
      const { data } = await wabaFlowsApi.simulate(flow.id, {
        inputs,
        mode,
        useLlm: mode === "exhaustive",
        tenantSlug,
      });
      setResult(data as SimulationResult);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error
        ?? (e as { message?: string })?.message
        ?? t("simulate.runError");
      setError(msg);
      setResult(null);
    } finally { setRunning(false); }
  }

  function addInput() {
    if (inputVal.trim()) {
      setInputs((prev) => [...prev, inputVal.trim()]);
      setInputVal("");
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-slate-700">{t("simulate.title", { flowName: flow.nombre })}</h3>

      {/* Input sequence builder */}
      <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-3">
        <p className="text-xs font-medium text-slate-600">{t("simulate.inputSequence")}</p>
        <div className="flex gap-2">
          <input
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addInput()}
            placeholder={t("simulate.inputPlaceholder")}
            className="flex-1 rounded-xl border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={addInput}
            className="px-3 py-1.5 rounded-xl bg-blue-100 text-blue-700 text-sm hover:bg-blue-200"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {inputs.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {inputs.map((inp, i) => (
              <div key={i} className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs">
                <span className="text-slate-500 font-mono">[{i}]</span>
                <span>{inp}</span>
                <button onClick={() => setInputs((prev) => prev.filter((_, j) => j !== i))} className="text-slate-300 hover:text-red-500 ml-1">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => runSimulation("single")}
            disabled={running}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {t("simulate.run")}
          </button>
          <button
            onClick={() => runSimulation("exhaustive")}
            disabled={running}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50"
          >
            {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {t("simulate.exploreAll")}
          </button>
        </div>
        <p className="text-xs text-slate-500">
          {t("simulate.aiHint")}
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {result?.verdict && (
        <div className={`rounded-2xl border p-4 ${
          result.verdict.status === "pass"
            ? "border-green-200 bg-green-50"
            : result.verdict.status === "warn"
              ? "border-amber-200 bg-amber-50"
              : "border-red-200 bg-red-50"
        }`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("simulate.verdict")}</p>
              <p className="mt-1 text-sm font-medium text-slate-800">{result.verdict.summary}</p>
            </div>
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
              result.verdict.status === "pass"
                ? "bg-green-100 text-green-700"
                : result.verdict.status === "warn"
                  ? "bg-amber-100 text-amber-700"
                  : "bg-red-100 text-red-700"
            }`}>
              {result.verdict.status === "pass" ? t("simulate.passed") : result.verdict.status === "warn" ? t("simulate.withNotes") : t("simulate.failed")}
            </span>
          </div>

          {result.verdict.highlights?.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {result.verdict.highlights.map((item, idx) => (
                <span key={idx} className="px-2 py-1 rounded-lg bg-white/80 text-xs text-slate-700 border border-white/60">
                  {item}
                </span>
              ))}
            </div>
          )}

          {result.verdict.llm?.summary && (
            <div className="mt-3 rounded-xl bg-white/70 border border-white/60 p-3">
              <p className="text-xs font-medium text-slate-600">{t("simulate.aiReading")}</p>
              <p className="mt-1 text-xs text-slate-700">{result.verdict.llm.summary}</p>
              {Array.isArray(result.verdict.llm.risks) && result.verdict.llm.risks.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {result.verdict.llm.risks.map((risk, idx) => (
                    <span key={idx} className="px-2 py-1 rounded-lg bg-slate-100 text-xs text-slate-700">{risk}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {Array.isArray(result?.conversationIds) && result.conversationIds.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("simulate.savedInConversations")}</p>
          <p className="mt-1 text-sm text-slate-700">
            {t("simulate.savedCount", { count: result.conversationIds.length })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {result.conversationIds.slice(0, 6).map((conversationId) => (
              <span key={conversationId} className="rounded-lg bg-white border border-slate-200 px-2 py-1 text-xs font-mono text-slate-600">
                {conversationId}
              </span>
            ))}
            {result.conversationIds.length > 6 && (
              <span className="rounded-lg bg-white border border-slate-200 px-2 py-1 text-xs text-slate-500">
                {t("simulate.more", { count: result.conversationIds.length - 6 })}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Trace */}
      {Array.isArray(result?.trace) && result.trace.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{t("simulate.traceTitle", { count: result.trace.length })}</p>
          {result.trace.map((step, i) => (
            <div key={i} className={`rounded-xl border p-3 text-sm ${step.error ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}>
              {step.error ? (
                <p className="text-red-600 text-xs">{step.error}</p>
              ) : (
                <div className="flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-slate-100 text-xs font-bold flex items-center justify-center text-slate-600 shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs text-slate-500">{step.nodeId}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${NODE_TYPE_COLOR[step.nodeType ?? ""] ?? "bg-slate-100 text-slate-600"}`}>
                        {step.nodeType}
                      </span>
                    </div>
                    {step.input !== null && step.input !== undefined && (
                      <p className="text-xs text-blue-600">↳ {t("simulate.input")} <span className="font-medium">"{step.input}"</span></p>
                    )}
                    {step.output && (
                      <div className="text-xs text-slate-600 mt-1">
                        {(step.output as { text?: string }).text && <p>{(step.output as { text: string }).text}</p>}
                        {(step.output as { type?: string }).type === "buttons" && Array.isArray((step.output as { options?: { title: string }[] }).options) && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {((step.output as { options: { title: string }[] }).options).map((o: { title: string }, j: number) => (
                              <span key={j} className="bg-purple-50 text-purple-700 px-2 py-0.5 rounded-lg">{o.title}</span>
                            ))}
                          </div>
                        )}
                        {(step.output as { type?: string }).type === "end" && (
                          <span className="text-rose-600 font-medium">✓ {t("simulate.conversationFinished")}</span>
                        )}
                        {(step.output as { type?: string }).type === "api_call_simulated" && (
                          <p className="font-mono text-green-600">{(step.output as { method?: string; endpoint?: string }).method} {(step.output as { endpoint?: string }).endpoint}</p>
                        )}
                      </div>
                    )}
                    {step.waiting_for_input && (
                      <p className="text-amber-600 text-xs mt-1">⏸ {t("simulate.waitingInput")}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {Array.isArray(result?.paths) && result.paths.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              {t("simulate.routesTitle", { count: result.paths.length })}
            </p>
            <span className="text-xs text-slate-400">
              {result.strategy === "llm-assisted" ? t("simulate.aiMode") : t("simulate.deterministicMode")}
            </span>
          </div>
          {result.paths.map((path, pathIndex) => (
            <details key={path.pathId} className="rounded-2xl border border-slate-200 bg-white p-4" open={pathIndex === 0}>
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-800">{t("simulate.route", { index: pathIndex + 1 })}</p>
                  <p className="text-xs text-slate-500">{t("simulate.stepsSummary", { count: path.stepCount ?? path.trace.length, endedBy: path.endedBy ?? t("simulate.completed") })}</p>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${path.trace.some((step) => step.error)
                  ? "bg-red-100 text-red-700"
                  : "bg-slate-100 text-slate-600"}`}>
                  {path.trace.some((step) => step.error) ? t("simulate.withError") : t("simulate.explored")}
                </span>
              </summary>
              <div className="mt-4 space-y-2">
                {path.trace.map((step, i) => (
                  <div key={`${path.pathId}-${i}`} className={`rounded-xl border p-3 text-sm ${step.error ? "border-red-200 bg-red-50" : "border-slate-200 bg-slate-50"}`}>
                    {step.error ? (
                      <p className="text-red-600 text-xs">{step.error}</p>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-white text-xs font-bold flex items-center justify-center text-slate-600 border border-slate-200 shrink-0">{i + 1}</span>
                          <span className="font-mono text-xs text-slate-500">{step.nodeId}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${NODE_TYPE_COLOR[step.nodeType ?? ""] ?? "bg-slate-100 text-slate-600"}`}>{step.nodeType}</span>
                          {step.llm_intent && <span className="text-xs px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">{t("simulate.intent")} {step.llm_intent}</span>}
                        </div>
                        {step.input !== null && step.input !== undefined && (
                          <p className="text-xs text-blue-600">↳ {t("simulate.input")} <span className="font-medium">"{step.input}"</span></p>
                        )}
                        {step.output && (
                          <div className="text-xs text-slate-600 mt-1">
                            {(step.output as { text?: string }).text && <p>{(step.output as { text: string }).text}</p>}
                            {(step.output as { type?: string }).type === "buttons" && Array.isArray((step.output as { options?: { title: string }[] }).options) && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {((step.output as { options: { title: string }[] }).options).map((o: { title: string }, j: number) => (
                                  <span key={j} className="bg-purple-50 text-purple-700 px-2 py-0.5 rounded-lg">{o.title}</span>
                                ))}
                              </div>
                            )}
                            {(step.output as { type?: string }).type === "condition" && (
                              <p className="text-orange-700 font-mono">{String((step.output as { expression?: string }).expression ?? "")}</p>
                            )}
                            {(step.output as { type?: string }).type === "end" && (
                              <span className="text-rose-600 font-medium">✓ {t("simulate.conversationFinished")}</span>
                            )}
                            {(step.output as { type?: string }).type === "api_call_simulated" && (
                              <p className="font-mono text-green-600">{(step.output as { method?: string; endpoint?: string }).method} {(step.output as { endpoint?: string }).endpoint}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────
export default function WabaFlujos() {
  const t = useTranslations("wabaFlows");
  const { tenantSlug } = useAuthStore();
  const [flows, setFlows]           = useState<WabaFlow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [tab, setTab]               = useState<TabKey>("list");
  const [selectedFlow, setSelectedFlow] = useState<WabaFlow | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [importLogs, setImportLogs] = useState<unknown[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const loadFlows = useCallback(async () => {
    if (!tenantSlug) {
      setFlows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const { data } = await wabaFlowsApi.list({ activo: true, tenantSlug });
      const normalized = Array.isArray(data?.flows)
        ? data.flows
        : Array.isArray(data)
          ? data
          : [];
      setFlows(normalized);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error
        ?? (e as { message?: string })?.message
        ?? t("page.loadError");
      setLoadError(msg);
    } finally { setLoading(false); }
  }, [tenantSlug]);

  const loadImportLogs = useCallback(async () => {
    if (!tenantSlug) {
      setImportLogs([]);
      setLogsLoading(false);
      return;
    }
    setLogsLoading(true);
    try {
      const { data } = await wabaFlowsApi.importLogs({ tenantSlug });
      const normalized = Array.isArray(data)
        ? data
        : Array.isArray((data as { logs?: unknown[] })?.logs)
          ? (data as { logs: unknown[] }).logs
          : [];
      setImportLogs(normalized);
    } catch { /* errors are already logged by the API interceptor */ }
    finally { setLogsLoading(false); }
  }, [tenantSlug]);

  const safeFlows = Array.isArray(flows) ? flows : [];
  const safeImportLogs = Array.isArray(importLogs) ? importLogs : [];

  useEffect(() => { loadFlows(); }, [loadFlows]);

  useEffect(() => {
    if (tab === "import-logs") loadImportLogs();
  }, [tab, loadImportLogs]);

  async function handleDelete(id: number) {
    if (!confirm(t("page.confirmDeactivate"))) return;
    await wabaFlowsApi.remove(id);
    loadFlows();
  }

  const statusLabels = {
    draft: t("page.status.draft"),
    valid: t("page.status.valid"),
    invalid: t("page.status.invalid"),
    exported: t("page.status.exported"),
    validated: t("page.status.validated"),
    failed: t("page.status.failed"),
  } as const;

  function openFlow(flow: WabaFlow, dest: "builder" | "versions" | "simulate") {
    setSelectedFlow(flow);
    setTab(dest);
  }

  // ── Render tabs when a flow is selected ────────────────────────────────────
  if (selectedFlow && (tab === "builder" || tab === "versions" || tab === "simulate")) {
    return (
      <div className="p-6 h-full flex flex-col gap-4">
        {/* Sub-tab bar */}
        <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1 w-fit">
          {(["builder", "versions", "simulate"] as const).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                tab === tabKey ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
                {tabKey === "builder" ? t("page.tabs.builder") : tabKey === "versions" ? t("page.tabs.versions") : t("page.tabs.simulate")}
            </button>
          ))}
          <button
            onClick={() => { setSelectedFlow(null); setTab("list"); loadFlows(); }}
            className="px-3 py-1.5 text-slate-400 hover:text-slate-600"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {tab === "builder" && (
          <FlowBuilder
            flow={selectedFlow}
            onBack={() => { setSelectedFlow(null); setTab("list"); }}
            onRefresh={loadFlows}
          />
        )}
        {tab === "versions" && <VersionsPanel flow={selectedFlow} onRefresh={loadFlows} tenantSlug={tenantSlug} />}
        {tab === "simulate" && <SimulatePanel flow={selectedFlow} />}
      </div>
    );
  }

  // ── Main list view ─────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-blue-600 flex items-center justify-center">
            <Webhook className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("page.title")}</h1>
            <p className="text-sm text-slate-500">{t("page.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadFlows}
            className="p-2 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-600"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 text-white text-sm font-medium hover:bg-slate-700"
          >
            <Upload className="w-4 h-4" />
            {t("page.importJson")}
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            {t("page.newFlow")}
          </button>
        </div>
      </div>

      {!tenantSlug && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t("page.selectCompany")}
        </div>
      )}

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3">
          <span>{loadError}</span>
          <button onClick={loadFlows} className="text-xs underline hover:no-underline shrink-0">{t("page.retry")}</button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1 w-fit">
        {(["list", "import-logs"] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
              tab === tabKey ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {tabKey === "list" ? t("page.tabs.list") : t("page.tabs.importLogs")}
          </button>
        ))}
      </div>

      {/* FLOWS LIST */}
      {tab === "list" && (
        <>
          {loading && (
            <div className="flex justify-center py-12">
              <RefreshCw className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          )}
          {!loading && flows.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-4 bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200">
              <Webhook className="w-12 h-12" />
              <p className="text-sm font-medium">{t("page.empty.title")}</p>
              <p className="text-xs text-slate-400">{t("page.empty.subtitle")}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowImport(true)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 text-white text-sm font-medium hover:bg-slate-700"
                >
                  <Upload className="w-4 h-4" /> {t("page.importJson")}
                </button>
                <button
                  onClick={() => setShowCreate(true)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  <Plus className="w-4 h-4" /> {t("page.newFlow")}
                </button>
              </div>
            </div>
          )}

          {!loading && safeFlows.length > 0 && (
            <div className="grid gap-4">
              {safeFlows.map((flow) => {
                const latestVersion = flow.flowVersions?.[0];
                const isPublished = latestVersion?.published ?? false;
                const valStatus = latestVersion?.wabaValidationStatus ?? "draft";

                return (
                  <div
                    key={flow.id}
                    className="bg-white rounded-2xl border border-slate-200 hover:border-slate-300 p-5 transition group"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-4 flex-1 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center shrink-0">
                          <FileJson className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-slate-800">{flow.nombre}</h3>
                            <span className="text-xs text-slate-400 font-mono">#{flow.id}</span>
                            {isPublished && (
                              <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> {t("page.live")}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[valStatus]}`}>
                              {statusLabels[valStatus as keyof typeof statusLabels] ?? valStatus}
                            </span>
                            {latestVersion && (
                              <span className="text-xs text-slate-400">
                                v{latestVersion.versionNumber} · {fmtDate(latestVersion.createdAt)}
                              </span>
                            )}
                            <span className="text-xs text-slate-400">
                              {flow._count?.flowVersions ?? 0} {t("page.counts.versions")} · {flow._count?.executions ?? 0} {t("page.counts.executions")}
                            </span>
                          </div>
                          {latestVersion?.wabaValidationErrors && latestVersion.wabaValidationErrors.length > 0 && (
                            <div className="mt-2 flex items-center gap-1 text-xs text-red-500">
                              <AlertTriangle className="w-3 h-3" />
                              {latestVersion.wabaValidationErrors.length} {t("page.counts.validationErrors")}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => openFlow(flow, "builder")}
                          title={t("page.actions.editor")}
                          className="p-2 rounded-xl hover:bg-blue-50 text-slate-400 hover:text-blue-600"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => openFlow(flow, "versions")}
                          title={t("page.actions.history")}
                          className="p-2 rounded-xl hover:bg-purple-50 text-slate-400 hover:text-purple-600"
                        >
                          <History className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => openFlow(flow, "simulate")}
                          title={t("page.actions.simulate")}
                          className="p-2 rounded-xl hover:bg-green-50 text-slate-400 hover:text-green-600"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                        <button
                          onClick={async () => {
                            const { data } = await wabaFlowsApi.export(flow.id);
                            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${flow.nombre.replace(/\s+/g, "_")}.json`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          title={t("page.actions.export")}
                          className="p-2 rounded-xl hover:bg-amber-50 text-slate-400 hover:text-amber-600"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(flow.id)}
                          title={t("page.actions.deactivate")}
                          className="p-2 rounded-xl hover:bg-red-50 text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Always-visible quick actions */}
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openFlow(flow, "builder")}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 text-blue-700 text-xs font-medium hover:bg-blue-100"
                        >
                          <Edit3 className="w-3.5 h-3.5" /> {t("page.actions.edit")}
                        </button>
                        <button
                          onClick={() => openFlow(flow, "simulate")}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100"
                        >
                          <Play className="w-3.5 h-3.5" /> {t("page.actions.test")}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* IMPORT LOGS */}
      {tab === "import-logs" && (
        <div className="space-y-3">
          {logsLoading && <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-slate-400" /></div>}
          {!logsLoading && safeImportLogs.length === 0 && (
            <div className="text-center py-10 text-slate-400 text-sm">{t("page.importLogsEmpty")}</div>
          )}
          {(safeImportLogs as Array<{ id: number; flowId?: number; source: string; parsedNodes: number; status: string; createdAt: string; validationErrors?: string[] }>).map((log) => (
            <div key={log.id} className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold ${
                  log.status === "validated" ? "bg-green-100 text-green-700"
                  : log.status === "failed" ? "bg-red-100 text-red-700"
                  : "bg-slate-100 text-slate-600"
                }`}>
                  {log.status === "validated" ? <CheckCircle2 className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-700">
                    {t("page.importLogSummary", { flowId: log.flowId ?? "—", parsedNodes: log.parsedNodes, source: log.source })}
                  </p>
                  <p className="text-xs text-slate-400">{fmtDate(log.createdAt)}</p>
                  {log.validationErrors && log.validationErrors.length > 0 && (
                    <p className="text-xs text-red-500 mt-0.5">{log.validationErrors.slice(0, 2).join(", ")}</p>
                  )}
                </div>
              </div>
              <span className={`text-xs px-2.5 py-1 rounded-full ${
                log.status === "validated" ? "bg-green-50 text-green-700"
                : log.status === "failed" ? "bg-red-50 text-red-700"
                : "bg-slate-100 text-slate-600"
              }`}>
                {statusLabels[log.status as keyof typeof statusLabels] ?? log.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {showImport && (
        <ImportModal
          tenantSlug={tenantSlug}
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); loadFlows(); }}
        />
      )}
      {showCreate && (
        <CreateFlowModal
          tenantSlug={tenantSlug}
          onClose={() => setShowCreate(false)}
          onCreated={loadFlows}
        />
      )}
    </div>
  );
}
