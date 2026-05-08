"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { agentAuthApi } from "@/lib/agentApi";
import { useAgentAuthStore } from "@/store/agentAuth";

type AgentProfile = {
  agenteId: number;
  tenantId: string;
  tenantSlug: string;
  tenantNombre: string | null;
  nombre: string;
  email: string;
  whatsapp: string | null;
  estado: string;
  puesto: { id: number; nombre: string } | null;
  calendarLink: string | null;
  lastSeenAt: string | null;
};

export default function AgentDashboardPage() {
  const router = useRouter();
  const { logout } = useAgentAuthStore();
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadProfile() {
      try {
        const res = await agentAuthApi.me();
        if (!cancelled) {
          setProfile(res.data);
        }
      } catch {
        if (!cancelled) {
          setError("No se pudo cargar el dashboard del agente.");
          logout();
          router.replace("/agente/login?reason=expired");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadProfile();

    return () => {
      cancelled = true;
    };
  }, [logout, router]);

  async function handleLogout() {
    try {
      await agentAuthApi.logout();
    } catch {
      // Best effort.
    } finally {
      logout();
      router.replace("/agente/login");
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-600">Dashboard</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Panel de agente</h1>
              <p className="mt-2 text-slate-600">
                Vista principal de tu acceso operativo. Desde aqu\u00ed pod\u00e9s revisar tus datos y abrir tu perfil.
              </p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition"
            >
              Cerrar sesi\u00f3n
            </button>
          </div>
        </div>

        {loading ? (
          <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6 text-sm text-slate-500">
            Cargando dashboard...
          </div>
        ) : error ? (
          <div className="rounded-3xl bg-white border border-red-200 shadow-sm p-6 text-sm text-red-600">
            {error}
          </div>
        ) : profile ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6 sm:col-span-2">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Bienvenido</p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-900">{profile.nombre}</h2>
              <p className="mt-2 text-sm text-slate-600">
                Tenant: <span className="font-medium text-slate-900">{profile.tenantNombre || profile.tenantSlug}</span>
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Estado: <span className="font-medium text-slate-900">{profile.estado}</span>
              </p>
              <div className="mt-4">
                <Link
                  href="/agente/perfil"
                  className="inline-flex rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 transition"
                >
                  Ver perfil completo
                </Link>
              </div>
            </div>

            <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Resumen</p>
              <div className="mt-3 space-y-2 text-sm text-slate-600">
                <p><span className="font-medium text-slate-900">Email:</span> {profile.email}</p>
                <p><span className="font-medium text-slate-900">Puesto:</span> {profile.puesto?.nombre || "Sin puesto"}</p>
                <p><span className="font-medium text-slate-900">Ultimo acceso:</span> {profile.lastSeenAt ? new Date(profile.lastSeenAt).toLocaleString("es-ES") : "Sin registro"}</p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
