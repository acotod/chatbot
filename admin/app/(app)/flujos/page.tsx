"use client";
import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ReactFlow, {
  Background, Controls, MiniMap, addEdge,
  applyNodeChanges, applyEdgeChanges,
  type Node, type Edge, type Connection,
  type NodeChange, type EdgeChange,
} from "reactflow";
import "reactflow/dist/style.css";
import { flowsApi, llmApi, tenantApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import {
  AlertTriangle, CheckCircle2, Plus, Save, Sparkles, Trash2, Wrench,
  Upload, Download, ShieldAlert, ShieldCheck, Play, Phone, Zap, ArrowRight,
  ChevronRight, RotateCcw, Copy, Check, History, FileJson,
} from "lucide-react";
import NodeEditorPanel from "@/components/flujos/NodeEditorPanel";
import FlowNode from "@/components/flujos/FlowNode";
import WhatsAppPreview from "@/components/flujos/WhatsAppPreview";
import { parseMetaJsonToGraph, buildMetaJsonFromGraph } from "@/lib/flowTransformer";
import type { EndpointDef, FlowDiagnostic, MetaFlowJson } from "@/lib/flowTypes";

// ── Types ───────────────────────────────────────────────────────────────────

interface Tenant { id: string; slug: string; nombre: string; }
interface DbFlow {
  id: number; nombre: string; tenantId: string;
  version: number; activo: boolean; metaJson?: unknown;
  nodes: DbNode[]; edges: DbEdge[];
}
interface DbNode  { id: number; type: string; content: Record<string, unknown>; posX: number; posY: number; }
interface DbEdge  { id: number; sourceNodeId: number; targetNodeId: number; condition: string | null; }
interface LlmStatus { available: boolean; provider: string | null; model: string | null; }
interface RescueItem { id: number; status: string; confidenceScore: number | null; llmUsed: boolean; createdAt: string; }
interface AiBrief {
  projectType: string;
  useCase: string;
  industry: string;
  targetUser: string;
  mainGoal: string;
  requiredInputs: string;
  businessRules: string;
  apiIntegrations: string;
  expectedOutputs: string;
  tone: string;
}

interface PromptAssistantResponse {
  status: "needs_info" | "ready";
  assistantMessage: string;
  questions: string[];
  missing: string[];
  suggestedPrompt: string;
  score: number;
  provider?: string | null;
  model?: string | null;
}

interface PromptAssistantMsg {
  role: "user" | "assistant";
  text: string;
}

interface SimulationStepInput { name: string; label: string; }
interface SimulationWabaItem { kind: string; text?: string; label?: string; name?: string; options?: string[]; }
interface SimulationStep {
  step: number;
  screenId: string;
  screenTitle?: string;
  inputs_in_screen?: SimulationStepInput[];
  provided_inputs?: Record<string, unknown>;
  webhooks_detected?: Array<{ component: string; action: string }>;
  mock_webhook_response?: { status: number; body: unknown };
  next_screen_id?: string | null;
  terminal?: boolean;
  warning?: string;
  channel?: { waba?: SimulationWabaItem[] };
}
interface SimulationResult {
  steps: SimulationStep[];
  summary: {
    totalSteps: number;
    screensTraversed: string[];
    terminal: boolean;
    mockInputsUsed?: Record<string, unknown>;
    error?: string;
  };
}

interface RequirementEntity {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface RequirementAnalysis {
  intent?: string;
  summary?: string;
  goals?: string[];
  entities?: RequirementEntity[];
  constraints?: string[];
  flow_type?: string;
  tone?: string;
  error_handling?: string;
  estimated_screens?: number;
  source?: string;
}

interface OrchestrationStage {
  key: string;
  label: string;
  status: string;
  detail?: RequirementAnalysis & {
    screenCount?: number;
    enrichedPromptLen?: number;
    catalogSize?: number;
    suggested?: number;
    errors?: number;
    warnings?: number;
  };
}

interface DataContractField {
  type: string;
  required: boolean;
  description: string;
}

interface IntelligentDesignResponse {
  orchestration?: {
    pipelineVersion?: string;
    stages?: OrchestrationStage[];
  };
  proposal?: {
    flowJson?: MetaFlowJson;
    summary?: {
      screenCount?: number;
    };
  };
  integrations?: {
    suggested?: Array<{ id: string; name: string; method: string; url: string; score?: number }>;
    catalogSize?: number;
  };
  dataContract?: {
    user_input?: Record<string, DataContractField>;
    validated_data?: Record<string, unknown>;
    api_responses?: Record<string, { endpoint: string; method: string; outputs: string[] }>;
    context_memory?: {
      flow_intent?: string;
      flow_type?: string;
      tone?: string;
      error_handling?: string;
      goals?: string[];
      constraints?: string[];
    };
  };
  validation?: {
    status?: string;
    errors?: FlowDiagnostic[];
    warnings?: FlowDiagnostic[];
    completeness_errors?: Array<{ code?: string; message?: string; field?: string }>;
    covered_fields?: string[];
  };
  approval?: {
    required?: boolean;
    status?: string;
  };
  legacy?: {
    json?: MetaFlowJson;
    warning?: string;
  };
}

interface FlowHistoryItem {
  id: number;
  nombre: string;
  status: "draft" | "published";
  screenCount: number;
  intent: string | null;
  summary: string | null;
  feedback: { good: number; bad: number };
  createdAt: string;
}

interface FlowMetrics {
  totalFlows: number;
  draftFlows: number;
  publishedFlows: number;
  approvalRate: number;
  feedback: {
    good: number;
    bad: number;
    total: number;
    satisfactionRate: number | null;
  };
  learningExamples: number;
}

type MainTab = "generar" | "builder" | "preview" | "probar" | "exportar" | "rescate";

const STEPS: { id: MainTab; label: string; icon: string }[] = [
  { id: "builder",  label: "1. Editar",   icon: "⬡" },
  { id: "preview",  label: "2. Preview",  icon: "📱" },
  { id: "probar",   label: "3. Probar",   icon: "▶" },
  { id: "exportar", label: "4. Exportar", icon: "⬇" },
];

function toRFNode(n: DbNode): Node {
  return {
    id: String(n.id), type: "flowNode",
    position: { x: n.posX, y: n.posY },
    data: { label: (n.content?.label as string) ?? n.type, nodeType: n.type, content: n.content },
  };
}
function toRFEdge(e: DbEdge): Edge {
  return {
    id: String(e.id), source: String(e.sourceNodeId), target: String(e.targetNodeId),
    label: e.condition ?? undefined, animated: true,
  };
}

let nodeIdCounter = 1000;
const NODE_TYPES = { flowNode: FlowNode };

// ── Component ────────────────────────────────────────────────────────────────

export default function FlujoSPage() {
  const qc = useQueryClient();
  const { tenantSlug } = useAuthStore();

  // Tabs
  const [activeTab, setActiveTab] = useState<MainTab>("builder");

  // Flow selection
  const [selectedFlowId, setSelectedFlowId] = useState<number | null>(null);
  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const [rfEdges, setRfEdges] = useState<Edge[]>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  // Saving
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [newFlowName, setNewFlowName] = useState("");

  // ── Generar tab
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiRetryCountdown, setAiRetryCountdown] = useState<number | null>(null);
  const [aiError, setAiError] = useState("");
  const [aiGenerated, setAiGenerated] = useState<MetaFlowJson | null>(null);
  const [aiDesignReport, setAiDesignReport] = useState<IntelligentDesignResponse | null>(null);
  const [aiSimulating, setAiSimulating]     = useState(false);
  const [aiSimulation, setAiSimulation]     = useState<SimulationResult | null>(null);
  const [aiSimError, setAiSimError]         = useState("");
  // Phase 4 — governance
  const [draftSaving, setDraftSaving]       = useState(false);
  const [draftId, setDraftId]               = useState<number | null>(null);
  const [draftNombre, setDraftNombre]       = useState("");
  const [draftError, setDraftError]         = useState("");
  const [approving, setApproving]           = useState(false);
  const [approvalDone, setApprovalDone]     = useState(false);
  const [approvalError, setApprovalError]   = useState("");
  const [feedbackSent, setFeedbackSent]     = useState<"good" | "bad" | null>(null);
  const [showCorrections, setShowCorrections] = useState(false);
  const [correctionText, setCorrectionText] = useState("");
  // Phase 5 — historial IA
  const [showHistory, setShowHistory]           = useState(false);
  const [historyLoading, setHistoryLoading]     = useState(false);
  const [historyItems, setHistoryItems]         = useState<FlowHistoryItem[]>([]);
  const [historyFilter, setHistoryFilter]       = useState<"all" | "draft" | "published">("all");
  const [metrics, setMetrics]                   = useState<FlowMetrics | null>(null);
  const [showAiBrief, setShowAiBrief] = useState(true);
  const [aiBrief, setAiBrief] = useState<AiBrief>({
    projectType: "general",
    useCase: "",
    industry: "",
    targetUser: "",
    mainGoal: "",
    requiredInputs: "",
    businessRules: "",
    apiIntegrations: "",
    expectedOutputs: "",
    tone: "cercano",
  });
  const [promptAssistRunning, setPromptAssistRunning] = useState(false);
  const [promptAssistError, setPromptAssistError] = useState("");
  const [promptAssistHistory, setPromptAssistHistory] = useState<PromptAssistantMsg[]>([]);
  const [promptAssistAnswers, setPromptAssistAnswers] = useState<Record<number, string>>({});
  const [promptAssistQuestions, setPromptAssistQuestions] = useState<string[]>([]);
  const [promptAssistMissing, setPromptAssistMissing] = useState<string[]>([]);
  const [promptAssistScore, setPromptAssistScore] = useState<number | null>(null);
  const [promptAssistReady, setPromptAssistReady] = useState(false);
  const [repairRunning, setRepairRunning] = useState(false);
  const [repairError, setRepairError] = useState("");
  const [repairNotes, setRepairNotes] = useState("");
  const [repairQuestions, setRepairQuestions] = useState<string[]>([]);
  const [repairAnswers, setRepairAnswers] = useState<Record<number, string>>({});
  const [repairMissing, setRepairMissing] = useState<string[]>([]);
  const [repairAssistantMessage, setRepairAssistantMessage] = useState("");

  // ── Import / Export modal
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState("");
  const [importPreview, setImportPreview] = useState<{
    nodes: number;
    edges: number;
    errors: number;
    warnings: number;
    diagnostics: FlowDiagnostic[];
  } | null>(null);
  const [exportResult, setExportResult] = useState<{
    json: unknown;
    validation: { errors: FlowDiagnostic[]; warnings: FlowDiagnostic[] };
  } | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [builderView, setBuilderView] = useState<"canvas" | "json">("canvas");
  const [builderJsonText, setBuilderJsonText] = useState("");
  const [builderJsonError, setBuilderJsonError] = useState("");

  // ── Validation strip
  const [validationDiags, setValidationDiags] = useState<FlowDiagnostic[]>([]);
  const [showValidation, setShowValidation] = useState(false);

  // ── Probar tab
  const [testInput, setTestInput] = useState("");
  const [testSessionId] = useState(() => {
    const area = ['11', '351', '261', '387', '341', '221', '299', '381'][Math.floor(Math.random() * 8)];
    const line = String(Math.floor(Math.random() * 90_000_000) + 10_000_000);
    return `+549${area}${line}`;
  });
  const [testSteps, setTestSteps] = useState<Array<{ role: "user" | "bot"; text: string; nodeId?: string }>>([]);
  const [testRunning, setTestRunning] = useState(false);
  const [testError, setTestError] = useState("");

  // ── WABA Rescue tab
  const [flowJsonInput, setFlowJsonInput] = useState("");
  const [wabaErrorInput, setWabaErrorInput] = useState("");
  const [rescueResult, setRescueResult] = useState<Record<string, unknown> | null>(null);
  const [validateResult, setValidateResult] = useState<Record<string, unknown> | null>(null);
  const [rescueError, setRescueError] = useState("");

  // ── Queries ─────────────────────────────────────────────────────────────────

  const { data: tenants = [] } = useQuery<Tenant[]>({
    queryKey: ["tenants"],
    queryFn: () => tenantApi.list().then(r => r.data),
  });

  const { data: flows = [], isLoading } = useQuery<DbFlow[]>({
    queryKey: ["flows", tenantSlug],
    queryFn: () => flowsApi.list(tenantSlug ? { tenantSlug } : undefined).then(r => r.data),
  });

  const selectedTenantId = tenantSlug
    ? tenants.find(t => t.slug === tenantSlug)?.id ?? ""
    : (tenants[0]?.id ?? "");

  const { data: llmStatus } = useQuery<LlmStatus>({
    queryKey: ["llm-status", selectedTenantId],
    enabled: !!selectedTenantId,
    queryFn: () => llmApi.status(selectedTenantId).then(r => r.data),
  });

  const { data: rescueHistory = [] } = useQuery<RescueItem[]>({
    queryKey: ["llm-rescue-history", selectedTenantId],
    enabled: !!selectedTenantId,
    queryFn: () => llmApi.listRescues({ tenantId: selectedTenantId, page: 1, limit: 8 }).then(r => r.data?.data ?? []),
  });

  const { data: catalogData } = useQuery({
    queryKey: ["endpoints-catalog", tenantSlug],
    queryFn: () => flowsApi.getEndpointsCatalog({ tenantSlug: tenantSlug ?? undefined }),
  });
  const endpointCatalog: EndpointDef[] =
    (catalogData as { data?: { data?: { endpoints?: EndpointDef[] } } })?.data?.data?.endpoints ?? [];

  // ── Mutations ────────────────────────────────────────────────────────────────

  const createFlow = useMutation({
    mutationFn: (data: { nombre: string; tenantId: string }) =>
      flowsApi.create(data).then(r => r.data),
    onSuccess: (flow: DbFlow) => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      loadFlow(flow);
      setNewFlowName("");
    },
  });

  const deleteFlow = useMutation({
    mutationFn: (id: number) => flowsApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      setSelectedFlowId(null); setRfNodes([]); setRfEdges([]);
    },
  });

  const validateMutation = useMutation({
    mutationFn: () => { const p = JSON.parse(flowJsonInput); return llmApi.validate(p).then(r => r.data); },
    onSuccess: d => { setValidateResult(d); setRescueError(""); },
    onError: (err: unknown) => {
      setValidateResult(null);
      setRescueError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || "No se pudo validar.");
    },
  });

  const rescueMutation = useMutation({
    mutationFn: () => {
      const pj = JSON.parse(flowJsonInput);
      const pe = (() => { try { return JSON.parse(wabaErrorInput); } catch { return wabaErrorInput; } })();
      return llmApi.rescue({ originalJson: pj, wabaError: pe, tenantId: selectedTenantId || undefined }).then(r => r.data);
    },
    onSuccess: d => { setRescueResult(d); setRescueError(""); qc.invalidateQueries({ queryKey: ["llm-rescue-history"] }); },
    onError: (err: unknown) => {
      setRescueResult(null);
      const e = err as { response?: { status?: number; data?: { error?: string } } };
      setRescueError(e.response?.status === 403
        ? "Sin permisos (MANAGE_LLM_RESCUE)."
        : e.response?.data?.error || "No se pudo ejecutar el rescate.");
    },
  });

  // ── Flow helpers ──────────────────────────────────────────────────────────────

  function loadFlow(flow: DbFlow) {
    setSelectedFlowId(flow.id);
    setRfNodes(flow.nodes.map(toRFNode));
    setRfEdges(flow.edges.map(toRFEdge));
    setSelectedNode(null);
    setBuilderView("canvas");
    setBuilderJsonText("");
    setBuilderJsonError("");
    setValidationDiags([]);
    setShowValidation(false);
    setTestSteps([]);
  }

  const onNodesChange = useCallback((c: NodeChange[]) => setRfNodes(nds => applyNodeChanges(c, nds)), []);
  const onEdgesChange = useCallback((c: EdgeChange[]) => setRfEdges(eds => applyEdgeChanges(c, eds)), []);
  const onConnect     = useCallback((p: Connection)  => setRfEdges(eds => addEdge({ ...p, animated: true }, eds)), []);

  function addNode() {
    const id = `new-${++nodeIdCounter}`;
    setRfNodes(prev => [...prev, {
      id, type: "flowNode",
      position: { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 },
      data: { label: "Nuevo nodo", nodeType: "screen", content: { label: "Nuevo nodo", title: "", body: "" } },
    }]);
  }

  function applyNodeEdit(nodeId: string, data: Partial<Node["data"]>) {
    setRfNodes(prev => prev.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n));
    setSelectedNode(null);
  }

  function deleteNode(nodeId: string) {
    setRfNodes(prev => prev.filter(n => n.id !== nodeId));
    setRfEdges(prev => prev.filter(e => e.source !== nodeId && e.target !== nodeId));
    setSelectedNode(null);
  }

  function onNodeClick(_: React.MouseEvent, node: Node) { setSelectedNode(node); }

  function openBuilderJson() {
    const result = buildMetaJsonFromGraph(rfNodes, rfEdges, endpointCatalog);
    const diagnostics = [...result.validation.errors, ...result.validation.warnings];
    setValidationDiags(diagnostics);
    setShowValidation(diagnostics.length > 0);
    if (!result.json) {
      setBuilderJsonError(result.validation.errors.map(error => error.message).join("; ") || "No se pudo generar el JSON del flujo");
      return;
    }
    setBuilderJsonText(JSON.stringify(result.json, null, 2));
    setBuilderJsonError("");
    setBuilderView("json");
  }

  function applyBuilderJson() {
    setBuilderJsonError("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(builderJsonText);
    } catch {
      setBuilderJsonError("JSON inválido — revisa la sintaxis");
      return;
    }

    const result = parseMetaJsonToGraph(parsed);
    const errors = result.diagnostics.filter(d => d.severity === "error");
    setValidationDiags(result.diagnostics);
    setShowValidation(result.diagnostics.length > 0);

    if (errors.length > 0) {
      setBuilderJsonError(errors.map(error => error.message).join("; "));
      return;
    }

    setRfNodes(result.nodes);
    setRfEdges(result.edges);
    setSelectedNode(null);
    setBuilderJsonError("");
    setBuilderView("canvas");
  }

  // ── Save ──────────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!selectedFlowId) return;
    setSaving(true);
    try {
      const idToIndex: Record<string, number> = {};
      rfNodes.forEach((n, i) => { idToIndex[n.id] = i; });
      const nodes = rfNodes.map(n => ({
        type: (n.data.nodeType as string) ?? "screen",
        content: { ...(n.data.content as object), label: n.data.label as string },
        posX: n.position.x, posY: n.position.y,
      }));
      const edges = rfEdges
        .filter(e => idToIndex[e.source] !== undefined && idToIndex[e.target] !== undefined)
        .map(e => ({ sourceIndex: idToIndex[e.source], targetIndex: idToIndex[e.target], condition: (e.label as string) ?? null }));
      const { json: metaJson } = buildMetaJsonFromGraph(rfNodes, rfEdges, endpointCatalog);
      const updated = await flowsApi.update(selectedFlowId, { nodes, edges, metaJson: metaJson ?? undefined }).then(r => r.data) as DbFlow;
      setRfNodes(updated.nodes.map(toRFNode));
      setRfEdges(updated.edges.map(toRFEdge));
      setSaveMsg("Guardado \u{1F499}");
      setTimeout(() => setSaveMsg(""), 3000);
      qc.invalidateQueries({ queryKey: ["flows"] });
    } finally { setSaving(false); }
  }

  // ── AI Simulate ─────────────────────────────────────────────────────────────

  async function handleSimulate() {
    if (!aiGenerated) return;
    setAiSimulating(true);
    setAiSimError("");
    setAiSimulation(null);
    try {
      const res = await (llmApi as unknown as {
        simulateFlow: (p: { flowJson: unknown; dataContract?: unknown; tenantId?: string }) => Promise<{ data: { simulation: SimulationResult } }>;
      }).simulateFlow({
        flowJson     : aiGenerated,
        dataContract : aiDesignReport?.dataContract,
        tenantId     : selectedTenantId || undefined,
      });
      setAiSimulation(res.data.simulation);
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; response?: { status?: number; data?: { error?: string } } };
      const isNetworkErr = !e?.response && (e?.message === "Network Error" || e?.code === "ERR_NETWORK");
      setAiSimError(
        isNetworkErr
          ? "No se pudo conectar con la API. Verifica que el servidor esté activo e intenta de nuevo."
          : e?.response?.data?.error ?? e?.message ?? "Error al simular"
      );
    } finally {
      setAiSimulating(false);
    }
  }

  // ── Governance: save draft ──────────────────────────────────────────────────

  async function handleSaveDraft(nombre: string) {
    if (!aiGenerated || !nombre.trim()) return;
    setDraftSaving(true);
    setDraftError("");
    try {
      const res = await (llmApi as unknown as {
        saveFlowDraft: (p: {
          flowJson: unknown;
          nombre: string;
          tenantId?: string;
          designReport?: unknown;
        }) => Promise<{ data: { draftId: number; nombre: string; status: string } }>;
      }).saveFlowDraft({
        flowJson    : aiGenerated,
        nombre      : nombre.trim(),
        tenantId    : selectedTenantId || undefined,
        designReport: aiDesignReport ?? undefined,
      });
      setDraftId(res.data.draftId);
      setDraftNombre(res.data.nombre);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setDraftError(e?.message ?? "Error al guardar el borrador");
    } finally {
      setDraftSaving(false);
    }
  }

  // ── Governance: approve draft ───────────────────────────────────────────────

  async function handleApproveFlow() {
    if (!draftId) return;
    setApproving(true);
    setApprovalError("");
    try {
      await (llmApi as unknown as {
        approveFlow: (id: number, tenantId?: string) => Promise<unknown>;
      }).approveFlow(draftId, selectedTenantId || undefined);
      setApprovalDone(true);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setApprovalError(e?.message ?? "Error al aprobar el flujo");
    } finally {
      setApproving(false);
    }
  }

  // ── Learning: submit feedback ───────────────────────────────────────────────

  async function handleFeedback(rating: "good" | "bad") {
    setFeedbackSent(rating);
    try {
      await (llmApi as unknown as {
        submitFeedback: (p: {
          rating: "good" | "bad";
          tenantId?: string;
          prompt?: string;
          intent?: string;
          flowId?: number;
          corrections?: string;
        }) => Promise<unknown>;
      }).submitFeedback({
        rating,
        tenantId   : selectedTenantId || undefined,
        prompt     : aiPrompt,
        intent     : aiDesignReport?.orchestration?.stages?.[0]?.detail?.intent ?? "",
        flowId     : draftId ?? undefined,
        corrections: correctionText.trim() || undefined,
      });
    } catch { /* feedback is best-effort */ }
    if (rating === "bad") setShowCorrections(true);
  }

  // ── Phase 5: load history + metrics ─────────────────────────────────────────

  async function handleLoadHistory() {
    setHistoryLoading(true);
    try {
      const [histRes, metricsRes] = await Promise.all([
        (llmApi as unknown as {
          flowHistory: (p: {
            tenantId?: string;
            status?: "all" | "draft" | "published";
            limit?: number;
          }) => Promise<{ data: { flows: FlowHistoryItem[] } }>;
        }).flowHistory({
          tenantId: selectedTenantId || undefined,
          status  : historyFilter,
          limit   : 30,
        }),
        (llmApi as unknown as {
          flowMetrics: (tenantId?: string) => Promise<{ data: FlowMetrics }>;
        }).flowMetrics(selectedTenantId || undefined),
      ]);
      setHistoryItems(histRes.data.flows);
      setMetrics(metricsRes.data);
    } catch { /* non-critical */ }
    finally { setHistoryLoading(false); }
  }

  function handleRedesign(item: FlowHistoryItem) {
    if (item.intent) setAiPrompt(item.intent);
    // reset prior generation state
    setAiGenerated(null);
    setAiDesignReport(null);
    setAiSimulation(null);
    setDraftId(null);
    setDraftNombre(item.nombre);
    setApprovalDone(false);
    setFeedbackSent(null);
    setShowHistory(false);
  }

  // ── AI Generate ──────────────────────────────────────────────────────────────

  async function handleAiGenerate() {
    if (!aiPrompt.trim()) return;
    setAiGenerating(true);
    setAiError("");
    setAiRetryCountdown(null);
    setAiGenerated(null);
    setAiDesignReport(null);

    const MAX_FRONTEND_RETRIES = 2;
    const RETRY_DELAYS = [5, 10]; // seconds between retries

    for (let attempt = 0; attempt <= MAX_FRONTEND_RETRIES; attempt++) {
      try {
        const res = await (llmApi as unknown as {
          designIntelligentFlow: (p: { prompt: string; tenantId?: string }) => Promise<{ data: IntelligentDesignResponse }>;
          generateFlow: (p: { prompt: string; tenantId?: string }) => Promise<{ data: { json: MetaFlowJson } }>;
        }).designIntelligentFlow({ prompt: aiPrompt, tenantId: selectedTenantId || undefined });
        const report = res.data;
        const generated = report.proposal?.flowJson ?? report.legacy?.json;
        if (!generated) throw new Error("No se recibio un flujo valido desde el orquestador IA");

        setAiDesignReport(report);
        setAiGenerated(generated);
        setAiRetryCountdown(null);
        // Parse and load into builder
        const parsed = parseMetaJsonToGraph(generated);
        setRfNodes(parsed.nodes);
        setRfEdges(parsed.edges);
        setValidationDiags(parsed.diagnostics);
        if (parsed.diagnostics.some(d => d.severity === "warning")) setShowValidation(true);
        setAiGenerating(false);
        return;
      } catch (err: unknown) {
        const e = err as {
          message?: string;
          code?: string;
          response?: { status?: number; data?: { error?: string; details?: Array<{ path: string; msg: string }> } };
        };
        const status = e.response?.status;
        const is503 = status === 503 || status === 529;

        if (is503 && attempt < MAX_FRONTEND_RETRIES) {
          const delaySec = RETRY_DELAYS[attempt] ?? 10;
          // Countdown
          for (let t = delaySec; t > 0; t--) {
            setAiRetryCountdown(t);
            await new Promise(r => setTimeout(r, 1000));
          }
          setAiRetryCountdown(null);
          continue; // retry
        }

        const details = e.response?.data?.details;
        setAiError(
          details?.map(d => `${d.path}: ${d.msg}`).join('; ') ||
          (is503 ? 'El proveedor LLM está temporalmente sobrecargado. Intenta de nuevo en unos segundos.' : undefined) ||
          e.response?.data?.error ||
          (e.code === 'ECONNABORTED' ? 'Tiempo de espera agotado al generar con IA. Intenta de nuevo.' : undefined) ||
          e.message ||
          "Error al generar el flujo con IA. Verifica la configuración LLM."
        );
        break;
      }
    }

    setAiRetryCountdown(null);
    setAiGenerating(false);
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  function resetImportDraft() {
    setImportJson("");
    setImportError("");
    setImportPreview(null);
  }

  function parseImportDraft() {
    setImportError("");
    setImportPreview(null);
    if (!importJson.trim()) {
      setImportError("Pega o sube un JSON antes de continuar");
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(importJson);
    } catch {
      setImportError("JSON inválido — revisa la sintaxis");
      return null;
    }

    const result = parseMetaJsonToGraph(parsed);
    const errors = result.diagnostics.filter(d => d.severity === "error");
    const warnings = result.diagnostics.filter(d => d.severity === "warning");

    setImportPreview({
      nodes: result.nodes.length,
      edges: result.edges.length,
      errors: errors.length,
      warnings: warnings.length,
      diagnostics: result.diagnostics,
    });

    if (errors.length > 0) {
      setImportError(errors.map(e => e.message).join("; "));
      return null;
    }

    return result;
  }

  function handleImportPreview() {
    parseImportDraft();
  }

  function handleImportFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setImportJson(String(event.target?.result ?? ""));
      setImportError("");
      setImportPreview(null);
    };
    reader.readAsText(file);
  }

  function handleImport() {
    const result = parseImportDraft();
    if (!result) return;
    setRfNodes(result.nodes);
    setRfEdges(result.edges);
    setValidationDiags(result.diagnostics);
    if (result.diagnostics.some(d => d.severity === "warning")) setShowValidation(true);
    setImportOpen(false);
    resetImportDraft();
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  async function handleExport() {
    setExportLoading(true);
    try {
      const res = await flowsApi.exportJson({
        nodes: rfNodes.map(n => ({ ...n.data, position: n.position })),
        edges: rfEdges,
        tenantSlug: tenantSlug ?? undefined,
        flowId: selectedFlowId ?? undefined,
      });
      setExportResult((res as { data: typeof exportResult }).data);
    } catch {
      const result = buildMetaJsonFromGraph(rfNodes, rfEdges, endpointCatalog);
      setExportResult({ json: result.json, validation: result.validation });
    } finally { setExportLoading(false); }
  }

  function handleValidate() {
    const { validation } = buildMetaJsonFromGraph(rfNodes, rfEdges, endpointCatalog);
    setValidationDiags([...validation.errors, ...validation.warnings]);
    setShowValidation(true);
  }

  // ── Test / Probar ───────────────────────────────────────────────────────────

  async function handleTestStep() {
    if (!testInput.trim() || !selectedFlowId) return;
    setTestRunning(true);
    setTestError("");
    const userMsg = testInput.trim();
    setTestInput("");
    setTestSteps(prev => [...prev, { role: "user", text: userMsg }]);
    try {
      const res = await flowsApi.execute(selectedFlowId, {
        sessionId: testSessionId,
        mensaje: userMsg,
        tenantId: selectedTenantId,
      });
      const data = (res as { data: { reply?: string; response?: string; nextScreen?: string } }).data;
      const reply = data.reply ?? data.response ?? "✓ (sin respuesta de texto)";
      setTestSteps(prev => [...prev, { role: "bot", text: reply, nodeId: data.nextScreen }]);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      const msg = e.response?.data?.error ?? "Error al ejecutar el paso";
      setTestError(msg);
      setTestSteps(prev => [...prev, { role: "bot", text: `Error: ${msg}` }]);
    } finally { setTestRunning(false); }
  }

  function resetTest() {
    setTestSteps([]);
    setTestError("");
    setTestInput("");
  }

  // ── Export tab actions ───────────────────────────────────────────────────────

  async function handleExportTab() {
    await handleExport();
    setActiveTab("exportar");
  }

  async function copyJson() {
    if (!exportResult?.json) return;
    await navigator.clipboard.writeText(JSON.stringify(exportResult.json, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── WABA helpers ─────────────────────────────────────────────────────────────

  function runValidate() {
    setRescueError(""); setRescueResult(null);
    try { JSON.parse(flowJsonInput); } catch { setRescueError("JSON inválido."); return; }
    validateMutation.mutate();
  }

  function runRescue() {
    setRescueError(""); setValidateResult(null);
    if (!flowJsonInput.trim() || !wabaErrorInput.trim()) { setRescueError("Pega el JSON del flujo y el error WABA."); return; }
    try { JSON.parse(flowJsonInput); } catch { setRescueError("JSON inválido."); return; }
    rescueMutation.mutate();
  }

  const firstTenantId = tenants[0]?.id ?? "";

  // ── AI prompt helper ────────────────────────────────────────────────────────

  function buildAiBriefPrompt(brief: AiBrief) {
    const integrations = brief.apiIntegrations.trim() || "Sin integraciones externas";
    return [
      "Objetivo: Diseñar un flujo conversacional de WhatsApp Business (WABA)",
      `Tipo de proyecto: ${brief.projectType || "general"}`,
      `Caso de uso: ${brief.useCase || "No especificado"}`,
      `Industria: ${brief.industry || "No especificada"}`,
      `Usuario objetivo: ${brief.targetUser || "No especificado"}`,
      `Objetivo principal: ${brief.mainGoal || "No especificado"}`,
      "",
      "Entradas esperadas:",
      brief.requiredInputs || "No especificadas",
      "",
      "Reglas de negocio:",
      brief.businessRules || "No especificadas",
      "",
      "Integraciones API / Webhooks:",
      integrations,
      "",
      "Salidas esperadas:",
      brief.expectedOutputs || "No especificadas",
      "",
      `Tono conversacional: ${brief.tone || "cercano"}`,
      "",
      "Entrega requerida:",
      "1) Flujo completo con nodos, transiciones y condiciones.",
      "2) Validaciones y manejo de errores (reintentos + fallback humano).",
      "3) Pantallas claras y optimizadas para UX en WhatsApp.",
      "4) JSON final compatible con WABA listo para publicar.",
      "",
      "Arquitectura obligatoria de pantalla inicial (entry point):",
      "- Debe clasificar la intencion del usuario (explicita o inferida).",
      "- Debe definir tipo de datos a recolectar: simple (1 campo), multiple (varios) o conversacional (dinamico).",
      "- Debe determinar el siguiente flujo automaticamente segun intent.",
      "- Debe permitir fallback a texto libre interpretado por LLM.",
      "",
      "UX recomendada para pantalla 1:",
      "Hola 👋",
      "Estoy aca para ayudarte.",
      "Que te gustaria hacer hoy?",
      "Podes elegir una opcion o escribirme directamente 💬",
      "",
      "Opciones sugeridas:",
      "- Hablar con alguien",
      "- Me siento estresado/a",
      "- Quiero informacion",
      "- Es algo urgente",
      "",
      "Mapping de ejemplo (intencion + datos):",
      "{ \"intent\": \"ESTRES\", \"data_required\": [\"nivel_estres\"], \"data_type\": \"simple\" }",
      "{ \"intent\": \"SOLICITUD_ESPACIO\", \"data_required\": [\"nombre\", \"fecha\", \"hora\"], \"data_type\": \"multiple\" }",
      "",
      "Responde solo con JSON compatible con WABA, sin explicaciones ni markdown.",
    ].join("\n");
  }

  async function callPromptAssistant(userMessage?: string, historyOverride?: PromptAssistantMsg[]) {
    setPromptAssistRunning(true);
    setPromptAssistError("");
    try {
      const draft = (aiPrompt.trim() || buildAiBriefPrompt(aiBrief)).slice(0, 12000);
      const history = (historyOverride ?? promptAssistHistory).slice(-20);
      const res = await llmApi.promptAssistant({
        tenantId: selectedTenantId || undefined,
        draftPrompt: draft,
        userMessage: userMessage ? userMessage.slice(0, 2000) : undefined,
        brief: aiBrief as unknown as Record<string, unknown>,
        history,
      });
      const data = (res as { data: PromptAssistantResponse }).data;

      if (data.suggestedPrompt?.trim()) {
        setAiPrompt(data.suggestedPrompt.trim());
      }

      const assistantMsgs: PromptAssistantMsg[] = [];
      if (data.assistantMessage?.trim()) {
        assistantMsgs.push({ role: "assistant", text: data.assistantMessage.trim() });
      }
      (data.questions ?? []).forEach((q) => {
        const text = String(q || "").trim();
        if (text) assistantMsgs.push({ role: "assistant", text: `Pregunta: ${text}` });
      });
      if (assistantMsgs.length > 0) {
        setPromptAssistHistory((prev) => [...prev, ...assistantMsgs]);
      }

      setPromptAssistQuestions(data.questions ?? []);
      setPromptAssistMissing(data.missing ?? []);
      setPromptAssistScore(typeof data.score === "number" ? data.score : null);
      setPromptAssistReady(data.status === "ready");
      if (data.status === "ready") setPromptAssistAnswers({});
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setPromptAssistError(e.response?.data?.error || e.message || "Error al validar/completar el prompt con IA");
    } finally {
      setPromptAssistRunning(false);
    }
  }

  async function handleBuildPromptAssistant() {
    await callPromptAssistant();
  }

  function getDesignValidationDetails() {
    const validation = aiDesignReport?.validation as {
      errors?: Array<{ message?: string; code?: string }>;
      warnings?: Array<{ message?: string; code?: string }>;
      completeness_errors?: Array<{ message?: string; code?: string; field?: string }>;
    } | undefined;

    const normalize = (items: Array<{ message?: string; code?: string; field?: string }> | undefined) =>
      (items ?? [])
        .map((item) => ({
          message: (item?.message || item?.code || "Incidencia sin detalle").trim(),
          field: item?.field,
        }))
        .filter((item) => item.message.length > 0);

    return {
      errors: normalize(validation?.errors),
      warnings: normalize(validation?.warnings),
      completeness: normalize(validation?.completeness_errors),
    };
  }

  function buildRepairUserMessage(extraAnswers?: string) {
    const diagnostics = getDesignValidationDetails();
    const lines: string[] = [
      "Necesito reparar un flujo WABA generado para que pase validacion logica y estructural.",
      "Analiza errores y pide informacion faltante si es necesario.",
      "Si falta contexto, devuelve preguntas concretas. Si no falta, deja un suggestedPrompt listo para regenerar.",
      "",
      "Errores detectados:",
      ...(diagnostics.errors.length > 0
        ? diagnostics.errors.map((e, i) => `${i + 1}. ${e.message}`)
        : ["- Sin errores estructurales reportados"]),
      "",
      "Campos requeridos faltantes:",
      ...(diagnostics.completeness.length > 0
        ? diagnostics.completeness.map((e, i) => `${i + 1}. ${e.field ? `${e.field}: ` : ""}${e.message}`)
        : ["- Sin faltantes requeridos reportados"]),
      "",
      "Contexto adicional del usuario:",
      repairNotes.trim() || "(sin contexto adicional)",
    ];

    if (extraAnswers?.trim()) {
      lines.push("", "Respuestas del usuario a preguntas de reparacion:", extraAnswers.trim());
    }

    return lines.join("\n");
  }

  async function runRepairGeneration(repairedPrompt: string) {
    const finalPrompt = [
      repairedPrompt,
      "",
      "Objetivo de reparacion:",
      "- Resolver errores de validacion logica.",
      "- Mantener compatibilidad con JSON de Meta WABA (screens/routing_model).",
      repairNotes.trim() ? `- Contexto adicional del usuario: ${repairNotes.trim()}` : null,
    ].filter(Boolean).join("\n");

    const res = await (llmApi as unknown as {
      designIntelligentFlow: (p: { prompt: string; tenantId?: string }) => Promise<{ data: IntelligentDesignResponse }>;
    }).designIntelligentFlow({
      prompt: finalPrompt,
      tenantId: selectedTenantId || undefined,
    });

    const report = res.data;
    const generated = report.proposal?.flowJson ?? report.legacy?.json;
    if (!generated) throw new Error("No se recibio un flujo reparado valido");

    setAiDesignReport(report);
    setAiGenerated(generated);
    const parsed = parseMetaJsonToGraph(generated);
    setRfNodes(parsed.nodes);
    setRfEdges(parsed.edges);
    setValidationDiags(parsed.diagnostics);
    if (parsed.diagnostics.some((d) => d.severity === "warning")) setShowValidation(true);
  }

  async function handleRepairFlow() {
    if (!aiGenerated) return;

    setRepairRunning(true);
    setRepairError("");
    setRepairAssistantMessage("");

    try {
      const repairRequest = buildRepairUserMessage();
      const draftPrompt = (aiPrompt.trim() || buildAiBriefPrompt(aiBrief)).slice(0, 12000);
      const res = await llmApi.promptAssistant({
        tenantId: selectedTenantId || undefined,
        draftPrompt,
        userMessage: repairRequest.slice(0, 4000),
        brief: aiBrief as unknown as Record<string, unknown>,
        history: promptAssistHistory.slice(-10),
      });
      const data = (res as { data: PromptAssistantResponse }).data;

      setRepairAssistantMessage((data.assistantMessage || "").trim());
      setRepairMissing(data.missing ?? []);

      if (data.status === "needs_info" && (data.questions?.length ?? 0) > 0) {
        setRepairQuestions(data.questions ?? []);
        setRepairAnswers({});
        return;
      }

      const repairedPrompt = data.suggestedPrompt?.trim() || aiPrompt.trim();
      if (!repairedPrompt) {
        throw new Error("No hay prompt de reparacion disponible");
      }

      setAiPrompt(repairedPrompt);
      setRepairQuestions([]);
      setRepairAnswers({});
      await runRepairGeneration(repairedPrompt);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setRepairError(e.response?.data?.error || e.message || "No se pudo reparar el flujo");
    } finally {
      setRepairRunning(false);
    }
  }

  async function handleRepairAnswersSubmit() {
    if (!aiGenerated) return;
    const answered = repairQuestions
      .map((q, i) => ({ q, a: (repairAnswers[i] ?? "").trim() }))
      .filter((item) => item.a.length > 0);
    if (answered.length === 0) return;

    setRepairRunning(true);
    setRepairError("");
    try {
      const answerBlock = answered.map((item, i) => `${i + 1}) ${item.q}: ${item.a}`).join("\n");
      const followUpMessage = buildRepairUserMessage(answerBlock);
      const draftPrompt = (aiPrompt.trim() || buildAiBriefPrompt(aiBrief)).slice(0, 12000);

      const res = await llmApi.promptAssistant({
        tenantId: selectedTenantId || undefined,
        draftPrompt,
        userMessage: followUpMessage.slice(0, 4000),
        brief: aiBrief as unknown as Record<string, unknown>,
        history: promptAssistHistory.slice(-10),
      });
      const data = (res as { data: PromptAssistantResponse }).data;

      setRepairAssistantMessage((data.assistantMessage || "").trim());
      setRepairMissing(data.missing ?? []);

      if (data.status === "needs_info" && (data.questions?.length ?? 0) > 0) {
        setRepairQuestions(data.questions ?? []);
        setRepairAnswers({});
        return;
      }

      const repairedPrompt = data.suggestedPrompt?.trim() || aiPrompt.trim();
      if (!repairedPrompt) {
        throw new Error("No se recibio prompt reparado");
      }

      setAiPrompt(repairedPrompt);
      setRepairQuestions([]);
      setRepairAnswers({});
      await runRepairGeneration(repairedPrompt);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setRepairError(e.response?.data?.error || e.message || "No se pudo completar la reparacion");
    } finally {
      setRepairRunning(false);
    }
  }

  async function handlePromptAssistantReply() {
    const answered = promptAssistQuestions
      .map((q, i) => ({ question: q, answer: (promptAssistAnswers[i] ?? "").trim(), index: i }))
      .filter((item) => item.answer.length > 0);
    if (answered.length === 0) return;

    // Rebuild the trailing question block as interleaved Q/A pairs so each answer
    // is displayed directly below its corresponding question.
    let baseHistory = [...promptAssistHistory];
    let trailingQuestions = 0;
    for (let i = baseHistory.length - 1; i >= 0; i--) {
      const msg = baseHistory[i];
      if (msg.role === "assistant" && msg.text.startsWith("Pregunta:")) {
        trailingQuestions += 1;
        continue;
      }
      break;
    }
    if (trailingQuestions > 0) {
      baseHistory = baseHistory.slice(0, -trailingQuestions);
    }

    const interleaved: PromptAssistantMsg[] = [];
    promptAssistQuestions.forEach((q, i) => {
      interleaved.push({ role: "assistant", text: `Pregunta: ${q}` });
      const answer = (promptAssistAnswers[i] ?? "").trim();
      if (answer) interleaved.push({ role: "user", text: answer });
    });

    const combinedAnswer = answered.map((item) => `${item.index + 1}. ${item.answer}`).join(" | ");
    const nextHistory = [...baseHistory, ...interleaved];
    setPromptAssistHistory(nextHistory);
    setPromptAssistAnswers({});
    await callPromptAssistant(combinedAnswer, nextHistory);
  }

  function applyEmotionalSupportPreset() {
    const preset: AiBrief = {
      projectType: "apoyo-emocional",
      useCase: "Apoyo emocional inicial con derivacion segun necesidad",
      industry: "bienestar y salud mental",
      targetUser: "personas que buscan contencion o ayuda inmediata",
      mainGoal: "detectar necesidad y guiar a apoyo, informacion o urgencias",
      requiredInputs: "seleccion de opcion emocional (radio), descripcion breve opcional",
      businessRules: "mostrar 4 opciones: hablar con alguien, estoy estresado, informacion, urgente; si elige urgente, priorizar derivacion inmediata a humano",
      apiIntegrations: "Webhook opcional para notificar equipo de guardia en ruta urgente",
      expectedOutputs: "respuesta empatica, siguiente paso claro y cierre con accion concreta",
      tone: "cercano",
    };
    setAiBrief(preset);
    setAiPrompt(buildAiBriefPrompt(preset));
  }

  // ── Build exportable JSON once for "Exportar" tab ───────────────────────────
  const exportJsonStr = exportResult?.json ? JSON.stringify(exportResult.json, null, 2) : null;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] gap-3">

      {/* ── Top nav bar ── */}
      <div className="flex items-center gap-1 bg-white rounded-xl border px-2 py-1.5 overflow-x-auto">
        {STEPS.map((step, i) => (
          <button key={step.id} onClick={() => setActiveTab(step.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition ${
              activeTab === step.id ? "bg-blue-600 text-white font-medium" : "text-slate-600 hover:bg-slate-100"
            }`}>
            <span className="text-base leading-none">{step.icon}</span>
            {step.label}
            {i < STEPS.length - 1 && <ChevronRight className="w-3 h-3 text-slate-300 ml-1" />}
          </button>
        ))}
        <div className="flex-1" />
        {/* Rescate link */}
        <button onClick={() => setActiveTab("rescate")}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition ${
            activeTab === "rescate" ? "bg-amber-500 text-white" : "text-amber-600 hover:bg-amber-50"
          }`}>
          <Wrench className="w-3.5 h-3.5" /> Rescate WABA
        </button>
        {/* LLM badge */}
        <div className={`hidden sm:flex items-center gap-1 text-xs px-2 py-1 rounded border ${
          llmStatus?.available ? "border-green-200 bg-green-50 text-green-700" : "border-gray-200 bg-gray-50 text-gray-400"
        }`}>
          <Zap className="w-3 h-3" />
          {llmStatus?.available ? `${llmStatus.provider}` : "LLM off"}
        </div>
      </div>

      {/* ══════════════════ STEP 1 — GENERAR ══════════════════ */}

      {activeTab === "generar" && (
        <div className="flex-1 flex gap-4 overflow-hidden">
          {/* Left: Flows list */}
          <div className="w-56 flex-shrink-0 flex flex-col gap-3">
            <div className="bg-white rounded-xl border p-3 flex flex-col gap-2">
              <h2 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Flujos</h2>
              <div className="flex gap-1.5">
                <input value={newFlowName} onChange={e => setNewFlowName(e.target.value)} placeholder="Nombre"
                  className="flex-1 border rounded px-2 py-1 text-xs" />
                <button onClick={() => { if (!newFlowName.trim() || !firstTenantId) return; createFlow.mutate({ nombre: newFlowName.trim(), tenantId: firstTenantId }); }}
                  className="bg-blue-600 text-white rounded px-2 py-1 hover:bg-blue-700">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {isLoading
                ? Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-9 bg-gray-100 rounded-lg animate-pulse" />)
                : flows.map(flow => (
                    <div key={flow.id} onClick={() => { loadFlow(flow); setAiGenerated(null); }}
                      className={`flex items-center justify-between p-2 rounded-lg cursor-pointer text-xs transition ${selectedFlowId === flow.id ? "bg-blue-50 text-blue-700 font-medium" : "hover:bg-gray-50 text-gray-700"}`}>
                      <span className="truncate">{flow.nombre}</span>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-gray-400">v{flow.version}</span>
                        <button onClick={e => { e.stopPropagation(); deleteFlow.mutate(flow.id); }} className="text-gray-300 hover:text-red-500">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
            </div>
          </div>

          {/* Right: AI generation area */}
          <div className="flex-1 flex flex-col gap-4 overflow-y-auto">
            <div className="bg-white rounded-xl border p-6 space-y-5">
              <div className="space-y-1">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-blue-500" />
                  Disenar flujo inteligente
                </h2>
                <p className="text-sm text-gray-500">
                  Describe en lenguaje natural lo que necesitas y el sistema orquesta interpretacion,
                  propuesta de flujo, sugerencia de integraciones, validacion y simulacion.
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-700">AI Brief (guiado)</h3>
                  <button
                    onClick={() => setShowAiBrief(v => !v)}
                    className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-white"
                  >
                    {showAiBrief ? "Ocultar" : "Mostrar"}
                  </button>
                </div>

                {showAiBrief && (
                  <div className="grid md:grid-cols-2 gap-2">
                    <select value={aiBrief.projectType} onChange={e => setAiBrief(prev => ({ ...prev, projectType: e.target.value }))}
                      className="border rounded-lg px-2.5 py-2 text-xs bg-white md:col-span-2">
                      <option value="general">Tipo: General</option>
                      <option value="atencion-cliente">Tipo: Atencion al cliente</option>
                      <option value="ventas">Tipo: Ventas</option>
                      <option value="soporte-tecnico">Tipo: Soporte tecnico</option>
                      <option value="agendamiento">Tipo: Agendamiento</option>
                      <option value="cobranzas">Tipo: Cobranzas</option>
                      <option value="apoyo-emocional">Tipo: Apoyo emocional</option>
                    </select>
                    <input value={aiBrief.useCase} onChange={e => setAiBrief(prev => ({ ...prev, useCase: e.target.value }))}
                      placeholder="Caso de uso (ej: Agendamiento de citas)" className="border rounded-lg px-2.5 py-2 text-xs bg-white" />
                    <input value={aiBrief.industry} onChange={e => setAiBrief(prev => ({ ...prev, industry: e.target.value }))}
                      placeholder="Industria (ej: salud, retail, banca)" className="border rounded-lg px-2.5 py-2 text-xs bg-white" />
                    <input value={aiBrief.targetUser} onChange={e => setAiBrief(prev => ({ ...prev, targetUser: e.target.value }))}
                      placeholder="Usuario objetivo" className="border rounded-lg px-2.5 py-2 text-xs bg-white" />
                    <input value={aiBrief.mainGoal} onChange={e => setAiBrief(prev => ({ ...prev, mainGoal: e.target.value }))}
                      placeholder="Objetivo principal" className="border rounded-lg px-2.5 py-2 text-xs bg-white" />
                    <textarea value={aiBrief.requiredInputs} onChange={e => setAiBrief(prev => ({ ...prev, requiredInputs: e.target.value }))}
                      placeholder="Entradas requeridas (ej: nombre, teléfono, fecha)" rows={2}
                      className="border rounded-lg px-2.5 py-2 text-xs bg-white md:col-span-2 resize-none" />
                    <textarea value={aiBrief.businessRules} onChange={e => setAiBrief(prev => ({ ...prev, businessRules: e.target.value }))}
                      placeholder="Reglas de negocio y validaciones" rows={2}
                      className="border rounded-lg px-2.5 py-2 text-xs bg-white md:col-span-2 resize-none" />
                    <textarea value={aiBrief.apiIntegrations} onChange={e => setAiBrief(prev => ({ ...prev, apiIntegrations: e.target.value }))}
                      placeholder="Integraciones API/webhooks (endpoint + método + propósito)" rows={2}
                      className="border rounded-lg px-2.5 py-2 text-xs bg-white md:col-span-2 resize-none" />
                    <textarea value={aiBrief.expectedOutputs} onChange={e => setAiBrief(prev => ({ ...prev, expectedOutputs: e.target.value }))}
                      placeholder="Salidas esperadas (confirmación, ticket, resumen, etc.)" rows={2}
                      className="border rounded-lg px-2.5 py-2 text-xs bg-white md:col-span-2 resize-none" />
                    <select value={aiBrief.tone} onChange={e => setAiBrief(prev => ({ ...prev, tone: e.target.value }))}
                      className="border rounded-lg px-2.5 py-2 text-xs bg-white md:col-span-2">
                      <option value="cercano">Tono cercano</option>
                      <option value="profesional">Tono profesional</option>
                      <option value="formal">Tono formal</option>
                    </select>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleBuildPromptAssistant}
                    disabled={promptAssistRunning || !llmStatus?.available}
                    className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-white hover:bg-slate-700"
                  >
                    {promptAssistRunning ? "Analizando prompt..." : "Construir prompt inteligente"}
                  </button>
                  <button
                    onClick={applyEmotionalSupportPreset}
                    className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    Plantilla: Apoyo emocional
                  </button>
                  <button
                    onClick={() => {
                      setAiBrief({
                        projectType: "general",
                        useCase: "",
                        industry: "",
                        targetUser: "",
                        mainGoal: "",
                        requiredInputs: "",
                        businessRules: "",
                        apiIntegrations: "",
                        expectedOutputs: "",
                        tone: "cercano",
                      });
                      setPromptAssistHistory([]);
                      setPromptAssistQuestions([]);
                      setPromptAssistMissing([]);
                      setPromptAssistScore(null);
                      setPromptAssistReady(false);
                      setPromptAssistAnswers({});
                      setPromptAssistError("");
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-white"
                  >
                    Limpiar brief
                  </button>
                </div>

                {(promptAssistHistory.length > 0 || promptAssistError || promptAssistRunning) && (
                  <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                    {/* Header */}
                    <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
                      <div className="flex items-center gap-2">
                        <span className="text-base">🤖</span>
                        <span className="text-xs font-semibold text-slate-700">Asistente de prompt</span>
                      </div>
                      {promptAssistScore !== null && (
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${promptAssistScore >= 80 ? "bg-green-500" : promptAssistScore >= 50 ? "bg-amber-400" : "bg-red-400"}`}
                              style={{ width: `${promptAssistScore}%` }}
                            />
                          </div>
                          <span className={`text-xs font-medium ${promptAssistScore >= 80 ? "text-green-600" : promptAssistScore >= 50 ? "text-amber-600" : "text-red-500"}`}>
                            {promptAssistScore}%
                          </span>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${promptAssistReady ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                            {promptAssistReady ? "✓ Listo" : "Incompleto"}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="p-3 space-y-3">
                      {/* Missing fields as chips */}
                      {promptAssistMissing.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {promptAssistMissing.map((m, i) => (
                            <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700">
                              ⚠ {m}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Chat history */}
                      {promptAssistHistory.length > 0 && (
                        <div className="max-h-44 overflow-y-auto space-y-2 text-xs pr-1">
                          {promptAssistHistory.map((m, idx) => (
                            <div key={`${m.role}-${idx}`} className={`flex gap-1.5 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                              <span className="shrink-0 text-sm">{m.role === "assistant" ? "🤖" : "👤"}</span>
                              <div className={`rounded-lg px-2.5 py-1.5 max-w-[85%] leading-relaxed ${m.role === "assistant" ? "bg-slate-100 text-slate-700" : "bg-blue-600 text-white"}`}>
                                {m.text}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Loading */}
                      {promptAssistRunning && (
                        <div className="flex items-center gap-2 text-xs text-slate-400">
                          <span className="text-sm">🤖</span>
                          <span className="flex gap-0.5">
                            <span className="animate-bounce" style={{ animationDelay: "0ms" }}>•</span>
                            <span className="animate-bounce" style={{ animationDelay: "150ms" }}>•</span>
                            <span className="animate-bounce" style={{ animationDelay: "300ms" }}>•</span>
                          </span>
                        </div>
                      )}

                      {/* Per-question inputs */}
                      {promptAssistQuestions.length > 0 && !promptAssistReady && (
                        <div className="space-y-2.5 border-t border-slate-100 pt-3">
                          <p className="text-xs text-slate-500 font-medium">Responde para completar el prompt:</p>
                          {promptAssistQuestions.map((q, i) => (
                            <div key={i} className="space-y-1">
                              <label className="text-xs text-slate-700 font-medium leading-snug">{i + 1}. {q}</label>
                              <input
                                type="text"
                                value={promptAssistAnswers[i] ?? ""}
                                onChange={(e) => setPromptAssistAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === "Enter") handlePromptAssistantReply(); }}
                                placeholder="Tu respuesta..."
                                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-400 transition"
                                disabled={promptAssistRunning}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Ready state CTA */}
                      {promptAssistReady && (
                        <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700">
                          <span>✅</span>
                          <span className="font-medium">El prompt está listo. Puedes generar el flujo.</span>
                        </div>
                      )}

                      {/* Error */}
                      {promptAssistError && (
                        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                          ⚠ {promptAssistError}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex gap-2 pt-1">
                        {!promptAssistReady && (
                          <button
                            onClick={handlePromptAssistantReply}
                            disabled={promptAssistRunning || Object.values(promptAssistAnswers).every((v) => !v?.trim())}
                            className="flex-1 text-xs px-3 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 transition"
                          >
                            {promptAssistRunning ? "Procesando..." : "Enviar respuestas →"}
                          </button>
                        )}
                        <button
                          onClick={handleBuildPromptAssistant}
                          disabled={promptAssistRunning}
                          className="text-xs px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition"
                        >
                          Re-validar
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Prompt examples */}
              <div className="flex flex-wrap gap-2">
                {[
                  "Registro de cita médica con nombre, fecha y especialidad",
                  "Soporte técnico con escalado a agente humano",
                  "Seguimiento de pedido ecommerce con estado y devolucion",
                  "Precalificacion de leads para equipo comercial",
                  "Flujo de apoyo emocional con opciones: hablar con alguien, estres, informacion y urgente",
                  "Encuesta de satisfacción post-servicio de 5 preguntas",
                ].map(ex => (
                  <button key={ex} onClick={() => setAiPrompt(ex)}
                    className="text-xs px-3 py-1.5 rounded-full border border-blue-200 text-blue-600 hover:bg-blue-50 transition">
                    {ex}
                  </button>
                ))}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">Tu requerimiento</label>
                <textarea value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} rows={5}
                  className="w-full border rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 resize-none"
                  placeholder="Ejemplo: Quiero un flujo de agendamiento de citas para una clínica. El usuario debe ingresar su nombre, seleccionar una especialidad médica, elegir un horario disponible consultando la API y recibir confirmación." />
              </div>

              {aiError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />{aiError}
                </div>
              )}

              {!llmStatus?.available && (
                <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <div>
                    <strong>LLM no configurado.</strong> Ve a Configuración → LLM para activar OpenAI, Anthropic u otro proveedor.
                    También puedes diseñar el flujo manualmente en <button onClick={() => setActiveTab("builder")} className="underline">Paso 1 (Editar)</button>.
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={handleAiGenerate}
                  disabled={aiGenerating || !aiPrompt.trim() || !llmStatus?.available}
                  className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 transition font-medium text-sm">
                  {aiGenerating
                    ? aiRetryCountdown !== null
                      ? <><RotateCcw className="w-4 h-4 animate-spin" /> Reintentando en {aiRetryCountdown}s…</>
                      : <><RotateCcw className="w-4 h-4 animate-spin" /> Orquestando…</>
                    : <><Sparkles className="w-4 h-4" /> Disenar flujo inteligente</>}
                </button>
                {aiGenerated && (
                  <button onClick={() => { setActiveTab("builder"); }}
                    className="flex items-center gap-2 px-5 py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 transition font-medium text-sm">
                    <ArrowRight className="w-4 h-4" /> Ver en Builder
                  </button>
                )}
                <button onClick={() => setActiveTab("builder")}
                  className="flex items-center gap-2 px-4 py-2.5 border rounded-xl text-sm hover:bg-gray-50 text-gray-600 transition">
                  Diseñar manualmente
                </button>
              </div>
            </div>

            {/* Generated preview */}
            {aiGenerated && (
              <div className="bg-white rounded-xl border p-4 space-y-3">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  Flujo generado — {(aiGenerated as MetaFlowJson).screens?.length ?? 0} pantallas
                </h3>
                {aiDesignReport?.orchestration?.stages && aiDesignReport.orchestration.stages.length > 0 && (() => {
                  const analysisStage = aiDesignReport.orchestration.stages.find(s => s.key === 'interpret_requirement');
                  const analysis = analysisStage?.detail;
                  const validateStage = aiDesignReport.orchestration.stages.find(s => s.key === 'validate_logic');
                  const validationFailed = validateStage?.status === 'failed';
                  const validationErrors = aiDesignReport.validation?.errors ?? [];
                  const validationWarnings = aiDesignReport.validation?.warnings ?? [];
                  const validationCompleteness = aiDesignReport.validation?.completeness_errors ?? [];
                  const stageStatusColor = (s: string) =>
                    s === 'completed' ? 'text-green-600' :
                    s === 'completed_with_warnings' ? 'text-amber-600' :
                    s === 'failed' ? 'text-red-600' :
                    s === 'ready' ? 'text-blue-600' : 'text-slate-500';

                  return (
                    <div className="space-y-2">
                      {/* Pipeline stages */}
                      <div className="rounded-lg border bg-slate-50 p-2.5 space-y-1.5">
                        <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                          <Zap className="w-3.5 h-3.5 text-indigo-500" />
                          Pipeline de orquestación · v{aiDesignReport.orchestration.pipelineVersion ?? '2.0'}
                        </div>
                        <div className="grid md:grid-cols-2 gap-1.5">
                          {aiDesignReport.orchestration.stages.map((stage) => (
                            <div key={stage.key} className="text-xs text-slate-600 flex items-center justify-between border rounded px-2 py-1 bg-white">
                              <span>{stage.label}</span>
                              <span className={`font-medium text-[10px] uppercase ${stageStatusColor(stage.status)}`}>{stage.status.replace(/_/g, ' ')}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Validation details + repair loop */}
                      {(validationFailed || validationErrors.length > 0 || validationWarnings.length > 0 || validationCompleteness.length > 0) && (
                        <div className={`rounded-lg border p-2.5 space-y-2 ${validationFailed ? 'bg-red-50/70 border-red-200' : 'bg-amber-50/70 border-amber-200'}`}>
                          <div className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                            <ShieldAlert className={`w-3.5 h-3.5 ${validationFailed ? 'text-red-600' : 'text-amber-600'}`} />
                            Diagnostico de validacion
                            <span className={`ml-auto text-[10px] uppercase ${validationFailed ? 'text-red-600' : 'text-amber-600'}`}>
                              {validationFailed ? 'Requiere reparacion' : 'Con advertencias'}
                            </span>
                          </div>

                          {validationErrors.length > 0 && (
                            <div className="space-y-1">
                              <div className="text-[10px] text-red-700 uppercase tracking-wide">Errores</div>
                              <ul className="text-xs text-red-800 list-disc list-inside space-y-0.5">
                                {validationErrors.slice(0, 6).map((err, i) => (
                                  <li key={`v-err-${i}`}>{err.message || err.code || 'Error sin detalle'}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {validationCompleteness.length > 0 && (
                            <div className="space-y-1">
                              <div className="text-[10px] text-red-700 uppercase tracking-wide">Campos requeridos faltantes</div>
                              <ul className="text-xs text-red-800 list-disc list-inside space-y-0.5">
                                {validationCompleteness.slice(0, 6).map((err, i) => (
                                  <li key={`v-complete-${i}`}>{err.message || err.code || 'Campo requerido faltante'}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {validationWarnings.length > 0 && (
                            <div className="space-y-1">
                              <div className="text-[10px] text-amber-700 uppercase tracking-wide">Warnings</div>
                              <ul className="text-xs text-amber-800 list-disc list-inside space-y-0.5">
                                {validationWarnings.slice(0, 4).map((warn, i) => (
                                  <li key={`v-warn-${i}`}>{warn.message || warn.code || 'Warning sin detalle'}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          <div className="space-y-1.5 border-t border-slate-200/70 pt-2">
                            <label className="text-[10px] uppercase tracking-wide text-slate-600">Contexto adicional para reparar</label>
                            <textarea
                              value={repairNotes}
                              onChange={(e) => setRepairNotes(e.target.value)}
                              placeholder="Ej: telefono debe ser obligatorio con formato +54..., agregar webhook de confirmacion final, etc."
                              rows={2}
                              className="w-full border rounded-md px-2 py-1.5 text-xs bg-white"
                              disabled={repairRunning}
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={handleRepairFlow}
                                disabled={repairRunning}
                                className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                              >
                                {repairRunning ? 'Reparando...' : 'Reparar con IA'}
                              </button>
                              <button
                                onClick={() => {
                                  setRepairQuestions([]);
                                  setRepairAnswers({});
                                  setRepairMissing([]);
                                  setRepairAssistantMessage('');
                                  setRepairError('');
                                }}
                                disabled={repairRunning}
                                className="text-xs px-3 py-1.5 rounded-md border border-slate-300 hover:bg-white disabled:opacity-50"
                              >
                                Limpiar reparacion
                              </button>
                            </div>
                          </div>

                          {repairMissing.length > 0 && (
                            <div className="flex flex-wrap gap-1 pt-1">
                              {repairMissing.map((m, i) => (
                                <span key={`repair-miss-${i}`} className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                                  Falta: {m}
                                </span>
                              ))}
                            </div>
                          )}

                          {repairAssistantMessage && (
                            <div className="text-xs text-slate-700 bg-white border rounded-md px-2 py-1.5">
                              {repairAssistantMessage}
                            </div>
                          )}

                          {repairQuestions.length > 0 && (
                            <div className="space-y-1.5 border-t border-slate-200/70 pt-2">
                              <div className="text-[10px] uppercase tracking-wide text-slate-600">La IA necesita mas informacion</div>
                              {repairQuestions.map((q, i) => (
                                <div key={`repair-q-${i}`} className="space-y-1">
                                  <label className="text-xs text-slate-700">{i + 1}. {q}</label>
                                  <input
                                    type="text"
                                    value={repairAnswers[i] ?? ''}
                                    onChange={(e) => setRepairAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
                                    className="w-full border rounded-md px-2 py-1.5 text-xs bg-white"
                                    placeholder="Escribe la respuesta..."
                                    disabled={repairRunning}
                                  />
                                </div>
                              ))}
                              <button
                                onClick={handleRepairAnswersSubmit}
                                disabled={repairRunning || Object.values(repairAnswers).every((v) => !v?.trim())}
                                className="text-xs px-3 py-1.5 rounded-md bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50"
                              >
                                {repairRunning ? 'Procesando respuestas...' : 'Enviar respuestas y reparar'}
                              </button>
                            </div>
                          )}

                          {repairError && (
                            <div className="text-xs text-red-700 bg-red-100 border border-red-200 rounded-md px-2 py-1.5">
                              {repairError}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Requirement analysis detail */}
                      {analysis && (
                        <div className="rounded-lg border bg-indigo-50/60 border-indigo-100 p-2.5 space-y-2">
                          <div className="text-xs font-semibold text-indigo-800 flex items-center gap-1.5">
                            <Sparkles className="w-3.5 h-3.5" />
                            Análisis del requerimiento
                            {analysis.source === 'fallback' && (
                              <span className="ml-auto text-[10px] text-amber-600 font-normal">(modo fallback)</span>
                            )}
                          </div>
                          {analysis.intent && (
                            <div className="flex flex-wrap gap-1.5 items-center">
                              <span className="text-[10px] text-indigo-500 uppercase tracking-wide">Intent</span>
                              <span className="text-xs font-mono bg-indigo-100 text-indigo-900 px-1.5 py-0.5 rounded">{analysis.intent}</span>
                              {analysis.flow_type && <span className="text-[10px] bg-white border rounded px-1.5 py-0.5 text-slate-600">{analysis.flow_type}</span>}
                              {analysis.tone && <span className="text-[10px] bg-white border rounded px-1.5 py-0.5 text-slate-600">{analysis.tone}</span>}
                              {analysis.estimated_screens != null && (
                                <span className="text-[10px] bg-white border rounded px-1.5 py-0.5 text-slate-600">{analysis.estimated_screens} pantallas</span>
                              )}
                            </div>
                          )}
                          {analysis.summary && (
                            <p className="text-xs text-indigo-700 italic">{analysis.summary}</p>
                          )}
                          {analysis.entities && analysis.entities.length > 0 && (
                            <div>
                              <div className="text-[10px] text-indigo-500 uppercase tracking-wide mb-1">Campos detectados</div>
                              <div className="flex flex-wrap gap-1">
                                {analysis.entities.map((e) => (
                                  <span key={e.name} className="text-[10px] bg-white border rounded px-1.5 py-0.5 flex items-center gap-1">
                                    <span className="font-mono text-slate-800">{e.name}</span>
                                    <span className="text-slate-400">[{e.type}]</span>
                                    {e.required && <span className="text-red-400">*</span>}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {analysis.constraints && analysis.constraints.length > 0 && (
                            <div>
                              <div className="text-[10px] text-indigo-500 uppercase tracking-wide mb-1">Restricciones</div>
                              <ul className="text-xs text-indigo-700 list-disc list-inside space-y-0.5">
                                {analysis.constraints.map((c, i) => <li key={i}>{c}</li>)}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Data contract */}
                      {aiDesignReport.dataContract && Object.keys(aiDesignReport.dataContract.user_input ?? {}).length > 0 && (
                        <div className="rounded-lg border bg-emerald-50/60 border-emerald-100 p-2.5 space-y-1.5">
                          <div className="text-xs font-semibold text-emerald-800 flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            Contrato de datos
                          </div>
                          <div className="grid sm:grid-cols-2 gap-1">
                            {Object.entries(aiDesignReport.dataContract.user_input ?? {}).map(([field, meta]) => (
                              <div key={field} className="text-[10px] bg-white border rounded px-2 py-1 flex items-center justify-between gap-1">
                                <span className="font-mono text-slate-800">{field}</span>
                                <span className="flex items-center gap-1 text-slate-400">
                                  <span className="border rounded px-1">{meta.type}</span>
                                  {meta.required && <span className="text-red-400">req</span>}
                                </span>
                              </div>
                            ))}
                          </div>
                          {Object.keys(aiDesignReport.dataContract.api_responses ?? {}).length > 0 && (
                            <div className="text-[10px] text-emerald-600">
                              {Object.keys(aiDesignReport.dataContract.api_responses!).length} endpoint(s) mapeado(s) al contrato
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {aiDesignReport?.integrations?.suggested && aiDesignReport.integrations.suggested.length > 0 && (
                  <div className="rounded-lg border bg-blue-50/60 border-blue-100 p-2.5 space-y-1.5">
                    <div className="text-xs font-semibold text-blue-700 flex items-center gap-1.5">
                      <ArrowRight className="w-3.5 h-3.5" />
                      Integraciones sugeridas
                    </div>
                    <div className="space-y-1">
                      {aiDesignReport.integrations.suggested.slice(0, 3).map((item) => (
                        <div key={item.id} className="text-xs text-blue-900 bg-white border border-blue-100 rounded px-2 py-1 flex items-center gap-1.5">
                          <span className="font-mono text-[10px] bg-blue-100 text-blue-700 px-1 rounded">{item.method}</span>
                          <span className="truncate">{item.name}</span>
                          {(item.score ?? 0) > 0 && <span className="ml-auto text-[10px] text-slate-400">score {item.score}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {(aiGenerated as MetaFlowJson).screens?.map((s) => (
                    <div key={s.id} className="border rounded-lg p-2 text-xs space-y-1 bg-slate-50">
                      <div className="font-medium text-slate-700">{s.id}</div>
                      <div className="text-slate-500 line-clamp-2">{s.title}</div>
                      {s.terminal && <span className="text-red-500 text-[10px]">terminal</span>}
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setActiveTab("builder")}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                    <ArrowRight className="w-3.5 h-3.5" /> Editar en Builder
                  </button>
                  <button onClick={() => setActiveTab("preview")}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 border rounded-lg hover:bg-gray-50 transition">
                    <Phone className="w-3.5 h-3.5" /> Ver Preview
                  </button>
                  <button onClick={handleSimulate} disabled={aiSimulating}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-50 transition disabled:opacity-50">
                    {aiSimulating
                      ? <><RotateCcw className="w-3.5 h-3.5 animate-spin" /> Simulando…</>
                      : <><Play className="w-3.5 h-3.5" /> Simular dry-run</>}
                  </button>
                </div>

                {/* Simulation error */}
                {aiSimError && (
                  <div className="rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 px-3 py-2">{aiSimError}</div>
                )}

                {/* Simulation transcript */}
                {aiSimulation && (
                  <div className="rounded-lg border bg-slate-900 p-3 space-y-1.5">
                    <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                      <Play className="w-3.5 h-3.5 text-emerald-400" />
                      Simulación dry-run · {aiSimulation.summary.totalSteps} paso(s)
                      {aiSimulation.summary.terminal
                        ? <span className="ml-auto text-[10px] text-emerald-400">✓ Flujo terminal alcanzado</span>
                        : <span className="ml-auto text-[10px] text-amber-400">⚠ No terminal</span>}
                    </div>
                    {aiSimulation.summary.error && (
                      <div className="text-xs text-red-400">{aiSimulation.summary.error}</div>
                    )}
                    <div className="space-y-2 mt-1">
                      {aiSimulation.steps.map((step) => (
                        <div key={step.step} className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono bg-slate-700 text-slate-300 px-1.5 rounded">#{step.step}</span>
                            <span className="text-xs font-medium text-slate-100">{step.screenTitle ?? step.screenId}</span>
                            <span className="text-[10px] text-slate-500 font-mono">{step.screenId}</span>
                            {step.terminal && <span className="ml-auto text-[10px] text-emerald-400 font-semibold">TERMINAL</span>}
                            {step.warning  && <span className="ml-auto text-[10px] text-amber-400">{step.warning}</span>}
                          </div>

                          {/* WABA view — components */}
                          {step.channel?.waba && step.channel.waba.length > 0 && (
                            <div className="pl-1 border-l-2 border-slate-600 space-y-0.5">
                              {step.channel.waba.map((item, i) => (
                                <div key={i} className="text-[11px]">
                                  {item.kind === 'heading'   && <span className="text-slate-100 font-semibold">{item.text}</span>}
                                  {item.kind === 'body'      && <span className="text-slate-400">{item.text}</span>}
                                  {item.kind === 'input'     && <span className="text-blue-300">[input] {item.label} <span className="font-mono text-[10px] text-slate-500">→ {item.name}</span></span>}
                                  {item.kind === 'date'      && <span className="text-blue-300">[date] {item.label}</span>}
                                  {item.kind === 'radio'     && <span className="text-purple-300">[radio] {item.label}: {item.options?.join(', ')}</span>}
                                  {item.kind === 'footer'    && <span className="text-emerald-300">[CTA] {item.label}</span>}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Mock inputs used */}
                          {step.provided_inputs && Object.keys(step.provided_inputs).length > 0 && (
                            <div className="flex flex-wrap gap-1 pt-0.5">
                              {Object.entries(step.provided_inputs).map(([k, v]) => (
                                <span key={k} className="text-[10px] font-mono bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
                                  {k}=<span className="text-yellow-300">{String(v)}</span>
                                </span>
                              ))}
                            </div>
                          )}

                          {/* Webhook mock */}
                          {step.mock_webhook_response && (
                            <div className="text-[10px] text-slate-400 flex items-center gap-1">
                              <Zap className="w-3 h-3 text-amber-400" />
                              webhook mocked → HTTP {step.mock_webhook_response.status}
                            </div>
                          )}

                          {/* Next */}
                          {!step.terminal && step.next_screen_id && (
                            <div className="text-[10px] text-slate-500 flex items-center gap-1">
                              <ChevronRight className="w-3 h-3" /> → {step.next_screen_id}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

          {/* ── Phase 4: Governance / Approval gate ───────────────────────── */}
          {aiGenerated && (
            <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Aprobación y publicación
              </div>

              {/* Save draft section */}
              {!draftId ? (
                <div className="space-y-2">
                  <p className="text-xs text-slate-400">
                    Guarda el diseño como borrador para revisión antes de publicarlo en producción.
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Nombre del flujo…"
                      value={draftNombre}
                      onChange={(e) => setDraftNombre(e.target.value)}
                      className="flex-1 rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-sm px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-slate-400"
                      maxLength={100}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSaveDraft(draftNombre); }}
                    />
                    <button
                      onClick={() => handleSaveDraft(draftNombre)}
                      disabled={draftSaving || !draftNombre.trim()}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
                    >
                      {draftSaving ? "Guardando…" : "Guardar borrador"}
                    </button>
                  </div>
                  {draftError && (
                    <p className="text-xs text-red-400">{draftError}</p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Draft saved badge */}
                  <div className="flex items-center gap-2 text-xs bg-slate-800 rounded-lg px-3 py-2">
                    <span className="inline-flex items-center gap-1 bg-blue-600/20 text-blue-300 border border-blue-600/40 rounded px-2 py-0.5 font-mono">
                      #{draftId}
                    </span>
                    <span className="text-slate-300 font-medium">{draftNombre}</span>
                    <span className="text-slate-500">· pendiente de aprobación</span>
                  </div>

                  {/* Approve button */}
                  {!approvalDone ? (
                    <div className="space-y-1">
                      <button
                        onClick={handleApproveFlow}
                        disabled={approving}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors"
                      >
                        <ShieldCheck className="w-4 h-4" />
                        {approving ? "Publicando…" : "Aprobar y publicar"}
                      </button>
                      {approvalError && (
                        <p className="text-xs text-red-400">{approvalError}</p>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-emerald-400 font-semibold">
                      <ShieldCheck className="w-4 h-4" />
                      Flujo publicado correctamente
                    </div>
                  )}
                </div>
              )}

              {/* ── Feedback (learning loop) ───────────────────────────────── */}
              <div className="border-t border-slate-700 pt-3 space-y-2">
                <p className="text-xs text-slate-500">
                  ¿El diseño generado fue útil?
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleFeedback("good")}
                    disabled={feedbackSent !== null}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      feedbackSent === "good"
                        ? "bg-emerald-600/20 border-emerald-500 text-emerald-300"
                        : "bg-slate-800 border-slate-600 text-slate-300 hover:border-emerald-500 hover:text-emerald-300"
                    } disabled:opacity-50`}
                  >
                    👍 Sí, muy útil
                  </button>
                  <button
                    onClick={() => handleFeedback("bad")}
                    disabled={feedbackSent !== null}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      feedbackSent === "bad"
                        ? "bg-red-600/20 border-red-500 text-red-300"
                        : "bg-slate-800 border-slate-600 text-slate-300 hover:border-red-500 hover:text-red-300"
                    } disabled:opacity-50`}
                  >
                    👎 Necesita mejoras
                  </button>
                  {feedbackSent && (
                    <span className="text-xs text-slate-500">Feedback registrado</span>
                  )}
                </div>

                {showCorrections && feedbackSent === "bad" && (
                  <div className="space-y-1.5">
                    <textarea
                      value={correctionText}
                      onChange={(e) => setCorrectionText(e.target.value)}
                      placeholder="Describe qué mejorarías en este diseño…"
                      rows={3}
                      className="w-full rounded-lg bg-slate-800 border border-slate-600 text-slate-200 text-xs px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-slate-400 resize-none"
                      maxLength={1000}
                    />
                    <button
                      onClick={() => handleFeedback("bad")}
                      className="px-3 py-1 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
                    >
                      Enviar correcciones
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Phase 5: Historial IA + Métricas ─────────────────────── */}
          <div className="rounded-xl border border-slate-200 bg-white">
            <button
              onClick={() => {
                const next = !showHistory;
                setShowHistory(next);
                if (next && historyItems.length === 0) handleLoadHistory();
              }}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition rounded-xl"
            >
              <span className="flex items-center gap-2">
                <History className="w-4 h-4 text-indigo-500" />
                Historial IA
                {metrics && (
                  <span className="text-xs font-normal text-slate-500">
                    · {metrics.totalFlows} flujos · {metrics.publishedFlows} publicados
                    {metrics.feedback.satisfactionRate !== null && (
                      <> · {metrics.feedback.satisfactionRate}% satisfacción</>
                    )}
                  </span>
                )}
              </span>
              <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${showHistory ? "rotate-90" : ""}`} />
            </button>

            {showHistory && (
              <div className="border-t border-slate-100 p-4 space-y-4">

                {/* Metrics bar */}
                {metrics && (
                  <div className="grid grid-cols-4 gap-3">
                    {[
                      { label: "Diseñados", value: metrics.totalFlows, color: "text-slate-700" },
                      { label: "Publicados", value: metrics.publishedFlows, color: "text-emerald-600" },
                      { label: "Borradores", value: metrics.draftFlows, color: "text-amber-600" },
                      { label: "Ejemplos IA", value: metrics.learningExamples, color: "text-indigo-600" },
                    ].map((m) => (
                      <div key={m.label} className="rounded-lg bg-slate-50 border p-3 text-center">
                        <div className={`text-xl font-bold ${m.color}`}>{m.value}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5">{m.label}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Filter tabs */}
                <div className="flex gap-2">
                  {(["all", "published", "draft"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => {
                        setHistoryFilter(f);
                        setHistoryItems([]);
                        setTimeout(() => handleLoadHistory(), 0);
                      }}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                        historyFilter === f
                          ? "bg-indigo-600 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {f === "all" ? "Todos" : f === "published" ? "Publicados" : "Borradores"}
                    </button>
                  ))}
                  <button
                    onClick={handleLoadHistory}
                    disabled={historyLoading}
                    className="ml-auto flex items-center gap-1 px-3 py-1 rounded-full text-xs text-slate-500 hover:text-slate-700 transition-colors"
                  >
                    <RotateCcw className={`w-3 h-3 ${historyLoading ? "animate-spin" : ""}`} />
                    Actualizar
                  </button>
                </div>

                {/* History list */}
                {historyLoading ? (
                  <div className="text-center text-sm text-slate-400 py-6">Cargando historial…</div>
                ) : historyItems.length === 0 ? (
                  <div className="text-center text-sm text-slate-400 py-6">
                    No hay flujos IA diseñados para este tenant.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {historyItems.map((item) => (
                      <div key={item.id} className="rounded-lg border bg-slate-50 hover:bg-white transition p-3 flex items-start gap-3">
                        <span className={`mt-0.5 inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 ${
                          item.status === "published"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-amber-100 text-amber-700"
                        }`}>
                          {item.status === "published" ? "✓ publicado" : "borrador"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-slate-800 truncate">{item.nombre}</div>
                          {item.intent && (
                            <div className="text-xs text-slate-500 truncate mt-0.5">{item.intent}</div>
                          )}
                          <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-400">
                            <span>{item.screenCount} pantallas</span>
                            {(item.feedback.good + item.feedback.bad) > 0 && (
                              <span>👍 {item.feedback.good} · 👎 {item.feedback.bad}</span>
                            )}
                            <span>{new Date(item.createdAt).toLocaleDateString("es")}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleRedesign(item)}
                          className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors border border-indigo-200"
                          title="Cargar intent y re-diseñar"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Re-diseñar
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          </div>
        </div>

      )}

      {activeTab === "builder" && (
        <div className="flex flex-1 gap-4 overflow-hidden">
          {/* Flows list */}
          <div className="w-56 flex-shrink-0 flex flex-col gap-3">
            <div className="bg-white rounded-xl border p-3 flex flex-col gap-2">
              <h2 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Flujos</h2>
              <div className="flex gap-1.5">
                <input value={newFlowName} onChange={e => setNewFlowName(e.target.value)} placeholder="Nombre"
                  className="flex-1 border rounded px-2 py-1 text-xs" />
                <button onClick={() => { if (!newFlowName.trim() || !firstTenantId) return; createFlow.mutate({ nombre: newFlowName.trim(), tenantId: firstTenantId }); }}
                  className="bg-blue-600 text-white rounded px-2 py-1 hover:bg-blue-700">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {isLoading
                ? Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-9 bg-gray-100 rounded-lg animate-pulse" />)
                : flows.map(flow => (
                    <div key={flow.id} onClick={() => loadFlow(flow)}
                      className={`flex items-center justify-between p-2 rounded-lg cursor-pointer text-xs transition ${selectedFlowId === flow.id ? "bg-blue-50 text-blue-700 font-medium" : "hover:bg-gray-50 text-gray-700"}`}>
                      <span className="truncate">{flow.nombre}</span>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-gray-400">v{flow.version}</span>
                        <button onClick={e => { e.stopPropagation(); deleteFlow.mutate(flow.id); }} className="text-gray-300 hover:text-red-500">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
            </div>
          </div>

          {/* Canvas area */}
          <div className="flex-1 flex flex-col gap-2 min-w-0">
            {/* Toolbar */}
            <div className="flex items-center gap-2 bg-white rounded-xl border px-3 py-2 flex-wrap">
              <button onClick={addNode} disabled={!selectedFlowId}
                className="flex items-center gap-1 text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg disabled:opacity-40 transition">
                <Plus className="w-4 h-4" /> Nodo
              </button>
              <button onClick={handleSave} disabled={!selectedFlowId || saving}
                className="flex items-center gap-1 text-sm bg-blue-600 text-white hover:bg-blue-700 px-3 py-1.5 rounded-lg disabled:opacity-50 transition">
                <Save className="w-4 h-4" /> {saving ? "Guardando…" : "Guardar"}
              </button>
              <div className="w-px h-5 bg-gray-200" />
              <button onClick={() => { resetImportDraft(); setImportOpen(true); }} disabled={!selectedFlowId}
                className="flex items-center gap-1 text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg disabled:opacity-40 transition">
                <Upload className="w-4 h-4" /> Importar
              </button>
              <button onClick={handleValidate} disabled={!selectedFlowId}
                className="flex items-center gap-1 text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg disabled:opacity-40 transition">
                <ShieldAlert className="w-4 h-4" /> Validar
              </button>
              <button
                onClick={() => builderView === "canvas" ? openBuilderJson() : setBuilderView("canvas")}
                disabled={!selectedFlowId}
                className={`flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg disabled:opacity-40 transition ${builderView === "json" ? "bg-slate-800 text-white hover:bg-slate-700" : "bg-gray-100 hover:bg-gray-200"}`}
              >
                <FileJson className="w-4 h-4" /> {builderView === "json" ? "Canvas" : "JSON"}
              </button>
              <button onClick={() => setActiveTab("preview")} disabled={rfNodes.length === 0}
                className="flex items-center gap-1 text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg disabled:opacity-40 transition">
                <Phone className="w-4 h-4" /> Preview
              </button>
              <button onClick={() => setActiveTab("probar")} disabled={!selectedFlowId}
                className="flex items-center gap-1 text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg disabled:opacity-40 transition">
                <Play className="w-4 h-4" /> Probar
              </button>
              {saveMsg && <span className="text-sm text-green-600 font-medium">{saveMsg}</span>}
              {!selectedFlowId && <span className="text-sm text-gray-400">← Selecciona un flujo</span>}
            </div>

            {/* Validation strip */}
            {showValidation && validationDiags.length > 0 && (
              <div className="bg-white border rounded-xl px-3 py-2 space-y-1 max-h-28 overflow-y-auto">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">Diagnósticos</span>
                  <button onClick={() => setShowValidation(false)} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
                </div>
                {validationDiags.map((d, i) => (
                  <div key={i} className={`flex items-start gap-1.5 text-xs ${d.severity === "error" ? "text-red-700" : d.severity === "warning" ? "text-amber-700" : "text-blue-700"}`}>
                    <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    <span>{d.message}{d.fix ? ` — ${d.fix}` : ""}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Builder workspace */}
            <div className="flex-1 bg-white rounded-xl border overflow-hidden">
              {builderView === "json" ? (
                <div className="h-full flex flex-col p-4 gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">Editor JSON del flujo</h3>
                      <p className="text-xs text-slate-500">Edita el JSON Meta y aplícalo de vuelta al canvas cuando esté válido.</p>
                    </div>
                    <button onClick={applyBuilderJson} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                      Aplicar JSON
                    </button>
                  </div>
                  <textarea
                    value={builderJsonText}
                    onChange={e => setBuilderJsonText(e.target.value)}
                    className="flex-1 w-full font-mono text-xs border rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                    placeholder='{"version":"7.1","data_api_version":"3.0","routing_model":{},"screens":[]}'
                  />
                  {builderJsonError && (
                    <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />{builderJsonError}
                    </div>
                  )}
                </div>
              ) : (
                <ReactFlow nodes={rfNodes} edges={rfEdges} nodeTypes={NODE_TYPES}
                  onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                  onConnect={onConnect} onNodeClick={onNodeClick} fitView deleteKeyCode="Delete">
                  <Background gap={16} color="#f0f0f0" />
                  <Controls />
                  <MiniMap nodeColor={n => ({ start: "#16a34a", end: "#dc2626", webhook: "#0891b2", condition: "#d97706", input: "#7c3aed", screen: "#2563eb" }[n.data?.nodeType as string] ?? "#2563eb")}
                    maskColor="rgba(255,255,255,0.8)" />
                </ReactFlow>
              )}
            </div>
          </div>

          {/* Node editor */}
          {selectedNode && (
            <NodeEditorPanel key={selectedNode.id} node={selectedNode} endpointCatalog={endpointCatalog}
              onApply={applyNodeEdit} onCancel={() => setSelectedNode(null)} onDelete={deleteNode} />
          )}
        </div>
      )}

      {/* ══════════════════ STEP 3 — PREVIEW ══════════════════ */}

      {activeTab === "preview" && (
        <div className="flex-1 flex gap-4 overflow-hidden">
          <div className="flex-1 bg-white rounded-xl border p-4 overflow-y-auto space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Simulación WhatsApp</h2>
                <p className="text-sm text-gray-500">Visualización de las pantallas del flujo tal como las vería el usuario final.</p>
              </div>
              <button onClick={() => setActiveTab("builder")}
                className="flex items-center gap-1 text-sm border px-3 py-1.5 rounded-lg hover:bg-gray-50">
                ← Volver al Editor
              </button>
            </div>
            {rfNodes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-400 space-y-2">
                <Phone className="w-12 h-12 text-gray-200" />
                <p className="text-sm">No hay nodos en el flujo. <button onClick={() => setActiveTab("builder")} className="text-blue-500 underline">Diseña uno manualmente</button> o importa un JSON desde el builder.</p>
              </div>
            ) : (
              <WhatsAppPreview nodes={rfNodes} edges={rfEdges} />
            )}
          </div>
        </div>
      )}

      {/* ══════════════════ STEP 4 — PROBAR ══════════════════ */}

      {activeTab === "probar" && (
        <div className="flex-1 flex gap-4 overflow-hidden">
          {/* Left: flow info */}
          <div className="w-56 flex-shrink-0 bg-white rounded-xl border p-4 space-y-3 overflow-y-auto">
            <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Flujos</h3>
            <div className="space-y-1">
              {flows.map(flow => (
                <div key={flow.id} onClick={() => loadFlow(flow)}
                  className={`p-2 rounded-lg cursor-pointer text-xs transition ${selectedFlowId === flow.id ? "bg-blue-50 text-blue-700 font-medium" : "hover:bg-gray-50 text-gray-700"}`}>
                  {flow.nombre}
                </div>
              ))}
            </div>
            {selectedFlowId && (
              <div className="pt-2 border-t">
                <div className="text-xs text-gray-500">Nodos: {rfNodes.length}</div>
                <div className="text-xs text-gray-500">Aristas: {rfEdges.length}</div>
              </div>
            )}
          </div>

          {/* Chat test panel */}
          <div className="flex-1 flex flex-col bg-white rounded-xl border overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div>
                <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <Play className="w-4 h-4 text-green-600" /> Prueba end-to-end
                </h2>
                <p className="text-xs text-gray-500">Simula una conversación real con el flujo. Sesión: <span className="font-mono">{testSessionId}</span></p>
              </div>
              <button onClick={resetTest} className="flex items-center gap-1 text-xs border px-3 py-1.5 rounded-lg hover:bg-gray-50">
                <RotateCcw className="w-3 h-3" /> Reiniciar
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#ece5dd]">
              {testSteps.length === 0 && (
                <div className="text-center text-sm text-gray-400 pt-8">
                  {selectedFlowId ? "Escribe un mensaje para iniciar la prueba." : "Selecciona un flujo en el panel izquierdo."}
                </div>
              )}
              {testSteps.map((step, i) => (
                <div key={i} className={`flex ${step.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[70%] px-3 py-2 rounded-xl text-sm shadow-sm ${
                    step.role === "user"
                      ? "bg-[#dcf8c6] text-gray-800 rounded-br-none"
                      : "bg-white text-gray-800 rounded-bl-none"
                  }`}>
                    {step.text}
                    {step.nodeId && <div className="text-[10px] text-gray-400 mt-0.5">→ {step.nodeId}</div>}
                  </div>
                </div>
              ))}
              {testRunning && (
                <div className="flex justify-start">
                  <div className="bg-white px-3 py-2 rounded-xl rounded-bl-none text-sm shadow-sm text-gray-500 animate-pulse">Procesando…</div>
                </div>
              )}
              {testError && (
                <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{testError}
                </div>
              )}
            </div>

            {/* Input */}
            <div className="flex items-center gap-2 p-3 border-t bg-gray-50">
              <input value={testInput} onChange={e => setTestInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleTestStep(); } }}
                placeholder={selectedFlowId ? "Escribe un mensaje de prueba…" : "Selecciona un flujo primero"}
                disabled={!selectedFlowId || testRunning}
                className="flex-1 border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-50 bg-white" />
              <button onClick={handleTestStep} disabled={!selectedFlowId || testRunning || !testInput.trim()}
                className="bg-green-600 text-white rounded-xl px-4 py-2 text-sm hover:bg-green-700 disabled:opacity-40 transition flex items-center gap-1">
                <Play className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Right: preview phone */}
          <div className="hidden xl:flex w-64 flex-shrink-0 bg-white rounded-xl border flex-col">
            <div className="p-3 border-b">
              <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide flex items-center gap-1">
                <Phone className="w-3 h-3" /> Vista previa
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              <WhatsAppPreview nodes={rfNodes} edges={rfEdges} compact />
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════ STEP 5 — EXPORTAR ══════════════════ */}

      {activeTab === "exportar" && (
        <div className="flex-1 flex gap-4 overflow-hidden">
          <div className="flex-1 flex flex-col bg-white rounded-xl border overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b flex-shrink-0">
              <div>
                <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <Download className="w-4 h-4" /> JSON Meta exportado
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Formato WhatsApp Flows — version 7.1 · data_api_version 3.0
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleExportTab()} disabled={exportLoading || rfNodes.length === 0}
                  className="flex items-center gap-1.5 text-sm border px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition">
                  <RotateCcw className="w-3.5 h-3.5" /> Regenerar
                </button>
                {exportJsonStr && (
                  <button onClick={copyJson}
                    className={`flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg transition font-medium ${copied ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-700"}`}>
                    {copied ? <><Check className="w-4 h-4" /> Copiado</> : <><Copy className="w-4 h-4" /> Copiar JSON</>}
                  </button>
                )}
              </div>
            </div>

            {/* Validation errors */}
            {exportResult && (exportResult.validation.errors.length > 0 || exportResult.validation.warnings.length > 0) && (
              <div className="px-5 py-3 border-b space-y-1.5 flex-shrink-0 bg-amber-50">
                {exportResult.validation.errors.map((e, i) => (
                  <div key={i} className="text-xs text-red-700 flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>{e.message}{e.fix ? ` — ${e.fix}` : ""}</span>
                  </div>
                ))}
                {exportResult.validation.warnings.map((w, i) => (
                  <div key={i} className="text-xs text-amber-700 flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>{w.message}</span>
                  </div>
                ))}
              </div>
            )}

            {rfNodes.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-gray-400">
                <div className="text-center space-y-2">
                  <Download className="w-12 h-12 mx-auto text-gray-200" />
                  <p className="text-sm">No hay flujo cargado. Diseña uno primero.</p>
                  <button onClick={() => setActiveTab("builder")} className="text-sm text-blue-600 underline">Ir al builder</button>
                </div>
              </div>
            ) : !exportResult ? (
              <div className="flex-1 flex items-center justify-center">
                <button onClick={handleExportTab} disabled={exportLoading}
                  className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 text-sm font-medium">
                  {exportLoading ? <><RotateCcw className="w-4 h-4 animate-spin" /> Generando…</> : <><Download className="w-4 h-4" /> Generar JSON</>}
                </button>
              </div>
            ) : !exportResult.json ? (
              <div className="flex-1 flex items-center justify-center text-red-600 text-sm p-6">
                El JSON no se generó debido a errores bloqueantes. Corrígelos en el builder primero.
              </div>
            ) : (
              <pre className="flex-1 overflow-auto text-xs bg-slate-50 p-5 font-mono leading-relaxed">
                {exportJsonStr}
              </pre>
            )}
          </div>

          {/* Right panel: flow summary */}
          <div className="w-64 flex-shrink-0 bg-white rounded-xl border p-4 space-y-4 overflow-y-auto">
            <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Resumen</h3>
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-gray-600">
                <span>Nodos</span><span className="font-medium">{rfNodes.length}</span>
              </div>
              <div className="flex justify-between text-xs text-gray-600">
                <span>Conexiones</span><span className="font-medium">{rfEdges.length}</span>
              </div>
              <div className="flex justify-between text-xs text-gray-600">
                <span>Errores</span>
                <span className={`font-medium ${(exportResult?.validation.errors.length ?? 0) > 0 ? "text-red-600" : "text-green-600"}`}>
                  {exportResult?.validation.errors.length ?? "—"}
                </span>
              </div>
              <div className="flex justify-between text-xs text-gray-600">
                <span>Warnings</span>
                <span className={`font-medium ${(exportResult?.validation.warnings.length ?? 0) > 0 ? "text-amber-600" : "text-green-600"}`}>
                  {exportResult?.validation.warnings.length ?? "—"}
                </span>
              </div>
            </div>
            <div className="border-t pt-3 space-y-2">
              <p className="text-xs text-gray-500">Para publicar en WhatsApp Business:</p>
              <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
                <li>Copia el JSON</li>
                <li>Ve al Meta Business Manager</li>
                <li>Crea/actualiza un Flow en WhatsApp Flows</li>
                <li>Pega el JSON en el editor</li>
              </ol>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════ RESCATE WABA ══════════════════ */}

      {activeTab === "rescate" && (
        <div className="flex-1 grid grid-cols-1 xl:grid-cols-3 gap-4 overflow-hidden">
          <div className="xl:col-span-2 bg-white rounded-xl border p-4 space-y-4 overflow-y-auto">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-800">Rescate WABA Integrado</h2>
                <p className="text-sm text-slate-500">Pega el JSON que falla y el error raw de WABA para validar o corregir con LLM.</p>
              </div>
              <div className="text-xs px-2 py-1 rounded-md border bg-slate-50 text-slate-600">
                {llmStatus?.available ? `LLM: ${llmStatus.provider} / ${llmStatus.model}` : "LLM no configurado"}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-600">JSON del Flow</label>
              <textarea value={flowJsonInput} onChange={e => setFlowJsonInput(e.target.value)} rows={10}
                className="w-full font-mono text-xs border rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                placeholder='{"version":"6.1","screens":[]}' />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-600">Error Raw de WABA</label>
              <textarea value={wabaErrorInput} onChange={e => setWabaErrorInput(e.target.value)} rows={6}
                className="w-full font-mono text-xs border rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                placeholder='{"error":{"message":"...","code":1002}}' />
            </div>
            <div className="flex items-center gap-2">
              <button onClick={runValidate} disabled={validateMutation.isPending}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm text-slate-700 disabled:opacity-50">
                <CheckCircle2 className="w-4 h-4" />{validateMutation.isPending ? "Validando..." : "Validar"}
              </button>
              <button onClick={runRescue} disabled={rescueMutation.isPending}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm text-white disabled:opacity-50">
                <Wrench className="w-4 h-4" />{rescueMutation.isPending ? "Rescatando..." : "Rescatar con LLM"}
              </button>
            </div>
            {rescueError && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5" />{rescueError}
              </div>
            )}
            {validateResult && (
              <div className="rounded-lg border p-3 bg-slate-50 space-y-2">
                <h3 className="text-sm font-semibold text-slate-700">Resultado de validación</h3>
                <pre className="text-xs bg-white border rounded p-3 overflow-auto max-h-64">{JSON.stringify(validateResult, null, 2)}</pre>
              </div>
            )}
            {rescueResult && (
              <div className="rounded-lg border p-3 bg-blue-50/40 space-y-2">
                <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-blue-600" /> Resultado de rescate
                </h3>
                <pre className="text-xs bg-white border rounded p-3 overflow-auto max-h-[28rem]">{JSON.stringify(rescueResult, null, 2)}</pre>
              </div>
            )}
          </div>
          <div className="bg-white rounded-xl border p-4 space-y-3 overflow-y-auto">
            <h3 className="text-sm font-semibold text-slate-800">Historial reciente</h3>
            {rescueHistory.length === 0
              ? <p className="text-sm text-slate-400">Sin rescates registrados.</p>
              : rescueHistory.map(item => (
                  <div key={item.id} className="rounded-lg border p-2.5 text-xs space-y-1">
                    <div className="flex justify-between gap-2">
                      <span className="font-semibold text-slate-700">#{item.id}</span>
                      <span className="text-slate-500">{new Date(item.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">{item.status}</span>
                      <span className="text-slate-500">Conf: {item.confidenceScore ?? "-"}</span>
                    </div>
                    <div className="text-slate-500">LLM: {item.llmUsed ? "sí" : "no"}</div>
                  </div>
                ))}
          </div>
        </div>
      )}

      {/* ══ IMPORT MODAL ══ */}
      {importOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2"><Upload className="w-4 h-4" /> Importar JSON Meta</h2>
              <button onClick={() => setImportOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">Subir archivo JSON</label>
              <input
                type="file"
                accept=".json,application/json"
                onChange={handleImportFileUpload}
                className="block text-sm text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
            </div>
            <textarea value={importJson} onChange={e => setImportJson(e.target.value)} rows={14}
              className="w-full font-mono text-xs border rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              placeholder='{"version":"7.1","data_api_version":"3.0","routing_model":{},"screens":[]}' />
            {importPreview && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="flex flex-wrap gap-3 text-xs text-slate-600">
                  <span>Pantallas: <span className="font-semibold text-slate-800">{importPreview.nodes}</span></span>
                  <span>Conexiones: <span className="font-semibold text-slate-800">{importPreview.edges}</span></span>
                  <span>Errores: <span className={`font-semibold ${importPreview.errors > 0 ? "text-red-600" : "text-green-600"}`}>{importPreview.errors}</span></span>
                  <span>Warnings: <span className={`font-semibold ${importPreview.warnings > 0 ? "text-amber-600" : "text-green-600"}`}>{importPreview.warnings}</span></span>
                </div>
                {importPreview.diagnostics.length > 0 && (
                  <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
                    {importPreview.diagnostics.map((diag, index) => (
                      <div key={`${diag.code}-${index}`} className={`text-xs flex items-start gap-1.5 ${diag.severity === "error" ? "text-red-700" : diag.severity === "warning" ? "text-amber-700" : "text-blue-700"}`}>
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                        <span>{diag.message}{diag.fix ? ` — ${diag.fix}` : ""}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {importError && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />{importError}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={resetImportDraft} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Limpiar</button>
              <button onClick={handleImportPreview} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Revisar</button>
              <button onClick={() => setImportOpen(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancelar</button>
              <button onClick={handleImport} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Importar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
