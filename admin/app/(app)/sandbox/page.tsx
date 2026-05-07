"use client";

import { sandboxApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery } from "@tanstack/react-query";
import axios from "axios";
import { Play, ShieldCheck, TestTube2, Webhook } from "lucide-react";
import { useState } from "react";

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
  };
};

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
  const { tenantSlug, superAdmin } = useAuthStore();
  const [phone, setPhone] = useState("+5215550000000");
  const [text, setText] = useState("Hola, quiero probar el sandbox.");
  const [contactName, setContactName] = useState("Sandbox User");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sandbox-capabilities"],
    queryFn: () => sandboxApi.capabilities().then((res) => res.data as CapabilitiesResponse),
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
  });

  const runtimeEntries = Object.entries(data?.sandbox.runtime ?? {});

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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.9fr)]">
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
              disabled={simulateMutation.isPending || (superAdmin && !tenantSlug)}
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
            </div>
          )}
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
              <h2 className="text-lg font-semibold">Siguiente corte</h2>
            </div>
            <div className="space-y-3 text-sm text-slate-600">
              <p>Mock Meta Cloud API para outbound y status events.</p>
              <p>Editor JSON completo para payload inbound editable.</p>
              <p>Timeline de ejecuci\u00f3n y replay desde conversaciones.</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}