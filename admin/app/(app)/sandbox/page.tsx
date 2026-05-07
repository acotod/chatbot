"use client";

import { sandboxApi } from "@/lib/api";
import { buildPermissionSet } from "@/lib/permissions";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery } from "@tanstack/react-query";
import axios from "axios";
import { Clock3, Play, ShieldCheck, TestTube2, Webhook } from "lucide-react";
import { useMemo, useState } from "react";

type CapabilitiesResponse = {
  ok: boolean;
  sandbox: {
    permission: string;
    runtime: Record<string, boolean>;
    tenantScope: string | null;
  };
};

type SimulationResponse = {
  ok: boolean;
  simulated: {
    tenantId: string;
    phone: string;
    text: string;
    msgId: string;
    correlationId: string;
    conversationId: string | null;
    conversationStatus: string | null;
  };
};

type SandboxRunListItem = {
  id: string;
  userKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  flow: { id: number; nombre: string } | null;
  flowVersionId: number | null;
  eventCount: number;
};

type SandboxRunDetail = {
  id: string;
  userKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  flow: { id: number; nombre: string } | null;
  flowVersion: { id: number; versionNumber: number; publishedAt: string | null } | null;
  events: Array<{
    id: string;
    nodeRef: string | null;
    eventType: string;
    payload: Record<string, unknown> | null;
    createdAt: string;
  }>;
};

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail;
    const message = error.response?.data?.error;
    if (typeof detail === "string" && detail) return detail;
    if (typeof message === "string" && message) return message;
  }
  return "No se pudo ejecutar la simulación sandbox.";
}

export default function SandboxPage() {
  const { tenantSlug, superAdmin, permissions } = useAuthStore();
  const [phone, setPhone] = useState("+5215550000000");
  const [text, setText] = useState("Hola, quiero probar el sandbox.");
  const [contactName, setContactName] = useState("Sandbox User");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const permissionSet = useMemo(() => buildPermissionSet(permissions), [permissions]);
  const canAccessSandbox = superAdmin || permissionSet.has("VIEW_SANDBOX");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sandbox-capabilities"],
    queryFn: () => sandboxApi.capabilities().then((res) => res.data as CapabilitiesResponse),
    enabled: canAccessSandbox,
    staleTime: 30_000,
  });

  const simulateMutation = useMutation({
    mutationFn: () =>
      sandboxApi.simulateInbound({
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
        phone,
        text,
        contactName,
      }).then((res) => res.data as SimulationResponse),
    onSuccess: (result) => {
      if (result.simulated.conversationId) {
        setSelectedRunId(result.simulated.conversationId);
      }
    },
  });

  const { data: runsData, isLoading: runsLoading } = useQuery({
    queryKey: ["sandbox-runs", tenantSlug, phone],
    queryFn: () =>
      sandboxApi.listRuns({
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
        userKey: phone,
        limit: 8,
      }).then((res) => res.data as { ok: boolean; data: SandboxRunListItem[] }),
    enabled: canAccessSandbox && (!superAdmin || Boolean(tenantSlug)) && Boolean(phone.trim()),
    staleTime: 5_000,
  });

  const runs = runsData?.data ?? [];

  const { data: runDetailData, isLoading: runDetailLoading } = useQuery({
    queryKey: ["sandbox-run-detail", tenantSlug, selectedRunId],
    queryFn: () =>
      sandboxApi.getRun(selectedRunId!, {
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
      }).then((res) => res.data as { ok: boolean; data: SandboxRunDetail }),
    enabled: canAccessSandbox && !!selectedRunId && (!superAdmin || Boolean(tenantSlug)),
    staleTime: 5_000,
  });

  const selectedRun = runDetailData?.data ?? null;

  const runtimeEntries = Object.entries(data?.sandbox.runtime ?? {});

  if (!canAccessSandbox) {
    return (
      <div className="rounded-3xl border border-red-200 bg-red-50 px-6 py-5 text-sm text-red-700">
        No tienes permisos para acceder al Sandbox Emulator.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Sandbox Emulator</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-500">
            Primer slice operativo del sandbox enterprise. Este panel ya dispara un inbound reutilizando el runtime real de
            webhook, chatbot router, flow engine y node executors.
          </p>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Estado inicial: runtime real + simulaci\u00f3n inbound.
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.95fr)]">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center gap-2 text-slate-900">
            <Webhook className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Simular inbound</h2>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm text-slate-600">
              <span>Tel\u00e9fono</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm text-slate-900 transition focus:border-blue-500 focus:outline-none"
                placeholder="+5215550000000"
              />
            </label>
            <label className="space-y-2 text-sm text-slate-600">
              <span>Contacto</span>
              <input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm text-slate-900 transition focus:border-blue-500 focus:outline-none"
                placeholder="Sandbox User"
              />
            </label>
            <label className="space-y-2 text-sm text-slate-600 md:col-span-2">
              <span>Mensaje</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm text-slate-900 transition focus:border-blue-500 focus:outline-none"
                placeholder="Escribe el contenido a inyectar al runtime real"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
            <div>
              {superAdmin ? (
                <span>
                  Tenant activo desde selector global: <strong>{tenantSlug || "sin seleccionar"}</strong>
                </span>
              ) : (
                <span>El tenant se resuelve desde tu sesi\u00f3n JWT.</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => simulateMutation.mutate()}
              disabled={simulateMutation.isPending || !canAccessSandbox || (superAdmin && !tenantSlug)}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              <Play className="h-4 w-4" />
              {simulateMutation.isPending ? "Ejecutando..." : "Simular inbound"}
            </button>
          </div>

          <div className="mt-4 rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
            <div className="mb-2 font-semibold text-slate-300">Payload enviado</div>
            <pre className="overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(
                {
                  tenantSlug: superAdmin ? tenantSlug || null : null,
                  phone,
                  contactName,
                  text,
                },
                null,
                2
              )}
            </pre>
          </div>

          {simulateMutation.isError && (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {getErrorMessage(simulateMutation.error)}
            </div>
          )}

          {simulateMutation.data && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <p className="font-medium">Ejecuci\u00f3n lanzada sobre el runtime real.</p>
              <p className="mt-1">Mensaje: <strong>{simulateMutation.data.simulated.msgId}</strong></p>
              <p>Correlation ID: <strong>{simulateMutation.data.simulated.correlationId}</strong></p>
              {simulateMutation.data.simulated.conversationId && (
                <p>
                  Run: <strong>{simulateMutation.data.simulated.conversationId}</strong> · Estado: <strong>{simulateMutation.data.simulated.conversationStatus ?? "active"}</strong>
                </p>
              )}
            </div>
          )}

          <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <div className="mb-4 flex items-center gap-2 text-slate-900">
              <Clock3 className="h-5 w-5 text-slate-600" />
              <h2 className="text-lg font-semibold">Runs recientes</h2>
            </div>

            {runsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="h-16 animate-pulse rounded-2xl bg-white" />
                ))}
              </div>
            ) : runs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-500">
                A\u00fan no hay runs para este tel\u00e9fono en el tenant activo.
              </div>
            ) : (
              <div className="space-y-3">
                {runs.map((run) => {
                  const active = run.id === selectedRunId;
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => setSelectedRunId(run.id)}
                      className={[
                        "w-full rounded-2xl border px-4 py-3 text-left transition",
                        active
                          ? "border-blue-300 bg-blue-50"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-100",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">{run.flow?.nombre ?? "Flow runtime"}</div>
                          <div className="mt-1 text-xs text-slate-500">{run.id}</div>
                        </div>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          {run.status}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-500">
                        <span>Inicio: {formatDateTime(run.startedAt)}</span>
                        <span>Eventos: {run.eventCount}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <div className="space-y-6">
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-slate-900">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              <h2 className="text-lg font-semibold">Capacidades</h2>
            </div>

            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="h-10 animate-pulse rounded-2xl bg-slate-100" />
                ))}
              </div>
            ) : isError ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                No se pudieron cargar las capacidades del sandbox.
              </div>
            ) : (
              <div className="space-y-3">
                {runtimeEntries.map(([key, enabled]) => (
                  <div key={key} className="flex items-center justify-between rounded-2xl border border-slate-200 px-4 py-3 text-sm">
                    <span className="font-medium text-slate-700">{key}</span>
                    <span className={enabled ? "text-emerald-700" : "text-amber-700"}>
                      {enabled ? "activo" : "pendiente"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-slate-900">
              <TestTube2 className="h-5 w-5 text-violet-600" />
              <h2 className="text-lg font-semibold">Timeline</h2>
            </div>

            {!selectedRunId ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                Selecciona un run para inspeccionar su timeline.
              </div>
            ) : runDetailLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="h-14 animate-pulse rounded-2xl bg-slate-100" />
                ))}
              </div>
            ) : selectedRun ? (
              <div className="space-y-4">
                <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                  <p><strong className="text-slate-900">Run:</strong> {selectedRun.id}</p>
                  <p><strong className="text-slate-900">Estado:</strong> {selectedRun.status}</p>
                  <p><strong className="text-slate-900">Inicio:</strong> {formatDateTime(selectedRun.startedAt)}</p>
                  <p><strong className="text-slate-900">Fin:</strong> {formatDateTime(selectedRun.endedAt)}</p>
                </div>

                <div className="space-y-3">
                  {selectedRun.events.map((event) => (
                    <div key={event.id} className="rounded-2xl border border-slate-200 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">{event.eventType}</div>
                          <div className="mt-1 text-xs text-slate-500">Nodo: {event.nodeRef ?? "-"}</div>
                        </div>
                        <div className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</div>
                      </div>
                      <pre className="mt-3 overflow-auto rounded-xl bg-slate-950 p-3 text-[11px] text-slate-100">
                        {JSON.stringify(event.payload ?? {}, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                No se pudo cargar el detalle del run.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}