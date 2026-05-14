"use client";

import { API_BASE, tenantApi } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { getStoredAccessToken } from "@/store/auth";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ImagePlus, KeyRound, Plus, Power, PowerOff, RefreshCcw } from "lucide-react";

const PLAN_OPTIONS = ["free", "pro", "enterprise"] as const;

type PlanValue = (typeof PLAN_OPTIONS)[number];

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
  const t = useTranslations("tenants");
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
      setInfo(t("create.created"));
      qc.invalidateQueries({ queryKey: ["tenants"] });
      qc.invalidateQueries({ queryKey: ["tenants", "header"] });
    },
    onError: () => {
      setInfo("");
      setError(t("create.createError"));
    },
  });

  const toggleTenant = useMutation({
    mutationFn: ({ slug, activo }: { slug: string; activo: boolean }) =>
      activo ? tenantApi.deactivate(slug) : tenantApi.activate(slug),
    onSuccess: () => {
      setInfo(t("manage.statusUpdated"));
      qc.invalidateQueries({ queryKey: ["tenants"] });
      qc.invalidateQueries({ queryKey: ["tenants", "header"] });
    },
    onError: () => {
      setError(t("manage.statusUpdateError"));
    },
  });

  const rotateKey = useMutation({
    mutationFn: (slug: string) => tenantApi.rotateApiKey(slug),
    onSuccess: () => {
      setInfo(t("manage.keyRotated"));
      qc.invalidateQueries({ queryKey: ["tenants"] });
    },
    onError: () => {
      setError(t("manage.keyRotateError"));
    },
  });

  const uploadLogo = useMutation({
    mutationFn: ({ slug, file }: { slug: string; file: File }) =>
      tenantApi.uploadLogo(slug, file),
    onSuccess: () => {
      setInfo(t("manage.logoUpdated"));
      qc.invalidateQueries({ queryKey: ["tenants"] });
      qc.invalidateQueries({ queryKey: ["tenants", "header"] });
    },
    onError: () => {
      setError(t("manage.logoUpdateError"));
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
      setError(t("create.nameSlugRequired"));
      return;
    }

    createTenant.mutate();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-slate-800">{t("create.title")}</h2>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Input
              label={t("create.name")}
              value={form.nombre}
              onChange={(e) => setForm((s) => ({ ...s, nombre: e.target.value }))}
              placeholder={t("create.namePlaceholder")}
            />
            <Input
              label={t("create.slug")}
              value={form.slug}
              onChange={(e) => setForm((s) => ({ ...s, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") }))}
              placeholder={t("create.slugPlaceholder")}
            />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">{t("create.plan")}</label>
              <select
                value={form.plan}
                onChange={(e) => setForm((s) => ({ ...s, plan: e.target.value as PlanValue }))}
                className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {PLAN_OPTIONS.map((plan) => (
                  <option key={plan} value={plan}>{t(`plans.${plan}`)}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <Button type="submit" className="w-full" disabled={createTenant.isPending}>
                <Plus size={16} />
                {createTenant.isPending ? t("create.creating") : t("create.submit")}
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
          <h2 className="font-semibold text-slate-800">{t("manage.title")}</h2>
        </CardHeader>
        <CardContent>
          {isLoading && <p className="text-sm text-slate-500">{t("manage.loading")}</p>}
          {isError && (
            <p className="text-sm text-red-600">
              {t("manage.loadError")}
            </p>
          )}

          {!isLoading && !isError && tenants.length === 0 && (
            <p className="text-sm text-slate-500">{t("manage.empty")}</p>
          )}

          {!isLoading && !isError && tenants.length > 0 && (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">{t("manage.headers.logo")}</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">{t("manage.headers.name")}</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">{t("manage.headers.slug")}</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">{t("manage.headers.plan")}</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">{t("manage.headers.status")}</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">{t("manage.headers.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((tenant) => (
                    <tr key={tenant.id} className="border-t border-slate-100">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {tenant.logoUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`${API_BASE}${tenant.logoUrl}`}
                              alt={`Logo ${tenant.nombre}`}
                              className="h-8 w-8 rounded object-contain border border-slate-100"
                            />
                          ) : (
                            <div className="h-8 w-8 rounded bg-slate-100 flex items-center justify-center text-slate-400">
                              <ImagePlus size={14} />
                            </div>
                          )}
                          <button
                            type="button"
                            title={t("manage.uploadLogo")}
                            className="text-xs text-blue-600 hover:underline"
                            onClick={() => fileInputRefs.current[tenant.slug]?.click()}
                            disabled={uploadLogo.isPending}
                          >
                            {tenant.logoUrl ? t("manage.change") : t("manage.upload")}
                          </button>
                          <input
                            ref={(el) => { fileInputRefs.current[tenant.slug] = el; }}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => handleLogoChange(tenant.slug, e)}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-900">{tenant.nombre}</td>
                      <td className="px-4 py-3 text-slate-700">{tenant.slug}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${PLAN_BADGE[tenant.plan ?? "free"] ?? "bg-slate-100 text-slate-600"}`}>
                          {typeof tenant.plan === "string" && PLAN_OPTIONS.includes(tenant.plan as PlanValue)
                            ? t(`plans.${tenant.plan}`)
                            : tenant.plan ?? t("manage.defaultPlan")}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={tenant.activo ? "text-green-600" : "text-red-600"}>
                          {tenant.activo ? t("manage.active") : t("manage.inactive")}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => toggleTenant.mutate({ slug: tenant.slug, activo: tenant.activo })}
                            disabled={toggleTenant.isPending}
                          >
                            {tenant.activo ? <PowerOff size={14} /> : <Power size={14} />}
                            {tenant.activo ? t("manage.deactivate") : t("manage.activate")}
                          </Button>

                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => rotateKey.mutate(tenant.slug)}
                            disabled={rotateKey.isPending}
                          >
                            <RefreshCcw size={14} />
                            {t("manage.rotateKey")}
                          </Button>

                          {tenant.apiKey && (
                            <span className="text-xs text-slate-500 inline-flex items-center gap-1">
                              <KeyRound size={12} />
                              {tenant.apiKey.slice(0, 8)}...
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
