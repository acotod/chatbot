"use client";

import { agentesApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Plus, ToggleLeft, ToggleRight } from "lucide-react";

interface Agente {
  id: number;
  nombre: string;
  email: string;
  estado: string;
}

export default function AgentesPage() {
  const { tenantSlug } = useAuthStore();
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ nombre: "", email: "" });
  const [formError, setFormError] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["agentes", tenantSlug],
    queryFn: () => agentesApi.list(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const create = useMutation({
    mutationFn: () =>
      agentesApi.create(tenantSlug, { nombre: form.nombre, email: form.email }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agentes"] });
      setModal(false);
      setForm({ nombre: "", email: "" });
    },
    onError: () => setFormError("No se pudo crear el agente. Intentá de nuevo."),
  });

  const toggle = useMutation({
    mutationFn: ({ id, estado }: { id: number; estado: string }) =>
      agentesApi.updateEstado(tenantSlug, id, estado),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentes"] }),
  });

  const agentes: Agente[] = data?.data ?? data ?? [];
  const activos = agentes.filter((a) => a.estado === "activo").length;

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    if (!form.nombre.trim() || !form.email.trim()) {
      setFormError("Completá todos los campos.");
      return;
    }
    create.mutate();
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">
            {activos} activos · {agentes.length} en total
          </p>
        </div>
        <Button onClick={() => setModal(true)}>
          <Plus size={16} />
          Nuevo agente
        </Button>
      </div>

      {/* Cards grid */}
      {isLoading ? (
        <p className="text-slate-400 text-sm">Cargando agentes...</p>
      ) : agentes.length === 0 ? (
        <Card>
          <div className="py-16 text-center">
            <p className="text-slate-400 text-sm">No hay agentes registrados.</p>
            <button
              onClick={() => setModal(true)}
              className="mt-3 text-blue-600 text-sm font-medium hover:text-blue-700"
            >
              Crear el primero →
            </button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {agentes.map((a) => (
            <Card key={a.id}>
              <div className="p-5 flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-semibold shrink-0">
                    {a.nombre.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">{a.nombre}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{a.email}</p>
                    <StatusBadge status={a.estado} className="mt-2" />
                  </div>
                </div>
                <button
                  onClick={() =>
                    toggle.mutate({
                      id: a.id,
                      estado: a.estado === "activo" ? "inactivo" : "activo",
                    })
                  }
                  className="mt-0.5 text-slate-400 hover:text-blue-600 transition"
                  title={a.estado === "activo" ? "Desactivar" : "Activar"}
                >
                  {a.estado === "activo" ? (
                    <ToggleRight size={24} className="text-blue-600" />
                  ) : (
                    <ToggleLeft size={24} />
                  )}
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={modal}
        onClose={() => {
          setModal(false);
          setFormError("");
        }}
        title="Nuevo agente"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <Input
            label="Nombre completo"
            value={form.nombre}
            onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
            placeholder="Ej: María González"
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="maria@clinica.com"
            error={formError}
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setModal(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creando..." : "Crear agente 💙"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
