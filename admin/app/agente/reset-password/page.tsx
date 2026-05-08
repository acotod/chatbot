"use client";

import { agentAuthApi } from "@/lib/agentApi";
import axios from "axios";
import { MessageCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type AgentResetPasswordPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getResetErrorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return "No se pudo restablecer la contraseña. Intenta nuevamente.";
  }

  const status = error.response?.status;
  if (status === 400) {
    return String(error.response?.data?.error || "El enlace ya no es válido o expiró.");
  }
  if (status === 403) {
    return "Tu acceso de agente está inactivo. Contactá al administrador.";
  }

  return String(error.response?.data?.error || "No se pudo restablecer la contraseña. Intenta nuevamente.");
}

export default async function AgentResetPasswordPage({ searchParams }: AgentResetPasswordPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const tokenValue = resolvedSearchParams?.token;
  const token = Array.isArray(tokenValue) ? tokenValue[0] : tokenValue;

  return <AgentResetPasswordScreen token={token ?? ""} />;
}

function AgentResetPasswordScreen({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!token) {
      setError("Falta el token de recuperación.");
      return;
    }
    if (password.trim().length < 8) {
      setError("La nueva contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (password !== confirmPassword) {
      setError("La confirmación no coincide con la contraseña.");
      return;
    }

    setLoading(true);
    try {
      const res = await agentAuthApi.resetPassword(token, password.trim());
      setSuccess(res.data.message);
      setTimeout(() => {
        router.push("/agente/login");
      }, 1200);
    } catch (err) {
      setError(getResetErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-slate-100 via-cyan-50 to-slate-100 flex items-center justify-center p-4">
      <div className="pointer-events-none absolute -top-24 -left-24 h-64 w-64 rounded-full bg-cyan-200/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 rounded-full bg-slate-300/30 blur-3xl" />

      <div className="relative bg-white rounded-3xl shadow-xl border border-slate-200/80 w-full max-w-md p-8 sm:p-9">
        <div className="flex items-center gap-3 mb-9">
          <div className="w-11 h-11 rounded-2xl bg-cyan-600 flex items-center justify-center shadow-sm shadow-cyan-200">
            <MessageCircle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Zentra Bot</h1>
            <p className="text-xs text-slate-500">Recuperación de agente</p>
          </div>
        </div>

        <h2 className="text-3xl font-semibold tracking-tight text-slate-900 mb-2">
          Restablecer contraseña
        </h2>
        <p className="text-slate-600 text-base mb-7">
          Definí una nueva contraseña para volver a entrar a tu perfil operativo.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4.5">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Nueva contraseña</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 8 caracteres"
              required
              className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500 transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Confirmar contraseña</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repetí la contraseña"
              required
              className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500 transition-all"
            />
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="px-4 py-3 bg-cyan-50 border border-cyan-200 rounded-xl text-cyan-700 text-sm">
              {success}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 bg-cyan-600 hover:bg-cyan-700 text-white font-medium rounded-xl transition-all shadow-sm shadow-cyan-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Actualizando..." : "Guardar nueva contraseña"}
          </button>
        </form>
      </div>
    </div>
  );
}