"use client";

import { tenantApi } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { getStoredAccessToken } from "@/store/auth";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ImagePlus, KeyRound, Plus, Power, PowerOff, RefreshCcw } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3200";

const PLAN_OPTIONS = [
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "enterprise", label: "Enterprise" },
] as const;

type PlanValue = (typeof PLAN_OPTIONS)[number]["value"];

const PLAN_BADGE: Record<PlanValue | string, string> = {
  free: "bg-slate-100 text-slate-600",
  pro: "bg-blue-100 text-blue-700",
  enterprise: "bg-purple-100 text-purple-700",
};

interface Tenant {
  id: string;
  nombre: string;
  slug: string;
  plan?: string;
  activo: boolean;
  apiKey?: string;
  logoUrl?: string;
}

export default function TenantsPage() {
  const qc = useQueryClient();
  const hasAccessToken = Boolean(getStoredAccessToken());
  const [form, setForm] = useState({ nombre: "", slug: "", plan: "free" as PlanValue });
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const { data, isLoading, isError } = useQuery({
    queryKey: ["tenants"],
    queryFn: () => tenantApi.list().then((r) => r.data),
    enabled: hasAccessToken,
  });

  const createTenant = useMutation({
    mutationFn: () =>
      tenantApi.create({
        nombre: form.nombre.trim(),
        slug: form.slug.trim(),
        plan: form.plan || "free",
      }),
    onSuccess: () => {
      setForm({ nombre: "", slug: "", plan: "free" });
      setError("");
      setInfo("Empresa creada correctamente.");
      qc.invalidateQueries({ queryKey: ["tenants"] });
      qc.invalidateQueries({ queryKey: ["tenants", "header"] });
    },
    onError: () => {
      setInfo("");
      setError("No se pudo crear la empresa. Revisá nombre/slug o permisos.");
    },
  });

  const toggleTenant = useMutation({
    mutationFn: ({ slug, activo }: { slug: string; activo: boolean }) =>
      activo ? tenantApi.deactivate(slug) : tenantApi.activate(slug),
    onSuccess: () => {
      setInfo("Estado de la empresa actualizado.");
      qc.invalidateQueries({ queryKey: ["tenants"] });
      qc.invalidateQueries({ queryKey: ["tenants", "header"] });
    },
    onError: () => {
      setError("No se pudo actualizar el estado de la empresa.");
    },
  });

  const rotateKey = useMutation({
    mutationFn: (slug: string) => tenantApi.rotateApiKey(slug),
    onSuccess: () => {
      setInfo("API key rotada correctamente.");
      qc.invalidateQueries({ queryKey: ["tenants"] });
    },
    onError: () => {
      setError("No se pudo rotar la API key de la empresa.");
    },
  });

  const uploadLogo = useMutation({
    mutationFn: ({ slug, file }: { slug: string; file: File }) =>
      tenantApi.uploadLogo(slug, file),
    onSuccess: () => {
      setInfo("Logo actualizado.");
      qc.invalidateQueries({ queryKey: ["tenants"] });
      qc.invalidateQueries({ queryKey: ["tenants", "header"] });
    },
    onError: () => {
      setError("No se pudo subir el logo.");
    },
  });

  function handleLogoChange(slug: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setInfo("");
    uploadLogo.mutate({ slug, file });
    e.target.value = "";
  }

  const tenants: Tenant[] = Array.isArray(data) ? data : [];

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");

    if (!form.nombre.trim() || !form.slug.trim()) {
      setError("Nombre y slug son obligatorios.");
      return;
    }

    createTenant.mutate();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-slate-800">Nueva empresa</h2>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Input
              label="Nombre"
              value={form.nombre}
              onChange={(e) => setForm((s) => ({ ...s, nombre: e.target.value }))}
              placeholder="Ej: Clinica Norte"
            />
            <Input
              label="Slug"
              value={form.slug}
              onChange={(e) => setForm((s) => ({ ...s, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") }))}
              placeholder="clinica-norte"
            />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Plan</label>
              <select
                value={form.plan}
                onChange={(e) => setForm((s) => ({ ...s, plan: e.target.value as PlanValue }))}
                className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {PLAN_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <Button type="submit" className="w-full" disabled={createTenant.isPending}>
                <Plus size={16} />
                {createTenant.isPending ? "Creando..." : "Crear empresa"}
              </Button>
            </div>
          </form>

          {error && (
            <p className="mt-3 text-sm text-red-600">{error}</p>
          )}
          {info && (
            <p className="mt-3 text-sm text-green-600">{info}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-slate-800">Administrar empresas</h2>
        </CardHeader>
        <CardContent>
          {isLoading && <p className="text-sm text-slate-500">Cargando empresas...</p>}
          {isError && (
            <p className="text-sm text-red-600">
              No se pudo cargar empresas. Verificá que tu usuario sea super admin y tenga permisos.
            </p>
          )}

          {!isLoading && !isError && tenants.length === 0 && (
            <p className="text-sm text-slate-500">No hay empresas creadas.</p>
          )}

          {!isLoading && !isError && tenants.length > 0 && (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Logo</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Nombre</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Slug</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Plan</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Estado</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t) => (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {t.logoUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`${API_BASE}${t.logoUrl}`}
                              alt={`Logo ${t.nombre}`}
                              className="h-8 w-8 rounded object-contain border border-slate-100"
                            />
                          ) : (
                            <div className="h-8 w-8 rounded bg-slate-100 flex items-center justify-center text-slate-400">
                              <ImagePlus size={14} />
                            </div>
                          )}
                          <button
                            type="button"
                            title="Subir logo"
                            className="text-xs text-blue-600 hover:underline"
                            onClick={() => fileInputRefs.current[t.slug]?.click()}
                            disabled={uploadLogo.isPending}
                          >
                            {t.logoUrl ? "Cambiar" : "Subir"}
                          </button>
                          <input
                            ref={(el) => { fileInputRefs.current[t.slug] = el; }}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => handleLogoChange(t.slug, e)}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-900">{t.nombre}</td>
                      <td className="px-4 py-3 text-slate-700">{t.slug}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${PLAN_BADGE[t.plan ?? "free"] ?? "bg-slate-100 text-slate-600"}`}>
                          {PLAN_OPTIONS.find((o) => o.value === t.plan)?.label ?? t.plan ?? "Free"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={t.activo ? "text-green-600" : "text-red-600"}>
                          {t.activo ? "Activo" : "Inactivo"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => toggleTenant.mutate({ slug: t.slug, activo: t.activo })}
                            disabled={toggleTenant.isPending}
                          >
                            {t.activo ? <PowerOff size={14} /> : <Power size={14} />}
                            {t.activo ? "Desactivar" : "Activar"}
                          </Button>

                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => rotateKey.mutate(t.slug)}
                            disabled={rotateKey.isPending}
                          >
                            <RefreshCcw size={14} />
                            Rotar key
                          </Button>

                          {t.apiKey && (
                            <span className="text-xs text-slate-500 inline-flex items-center gap-1">
                              <KeyRound size={12} />
                              {t.apiKey.slice(0, 8)}...
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
