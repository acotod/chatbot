"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { crmApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  UserCircle2,
  Search,
  Plus,
  Trash2,
  Pencil,
  Star,
  Phone,
  Mail,
  Building2,
  Tag,
  ClipboardList,
  TrendingUp,
  MessageSquare,
} from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useAuthStore } from "@/store/auth";

interface Contact {
  id: number;
  phone: string | null;
  nombre: string | null;
  email: string | null;
  empresa: string | null;
  cargo: string | null;
  canalOrigen: string | null;
  etiquetas: string[];
  leadScore: number | null;
  ultimoContacto: string | null;
  createdAt: string;
  _count?: { solicitudes: number; deals: number; tasks: number };
}

interface ContactDetail extends Contact {
  notas: string | null;
  customFields: Record<string, unknown>;
  solicitudes: Array<{ id: number; estado: string; createdAt: string; agente?: { nombre: string } }>;
  deals: Array<{ id: number; titulo: string; etapa: string; valor: string | null; agente?: { nombre: string } }>;
  tasks: Array<{ id: number; titulo: string; tipo: string; estado: string; venceEn: string | null; agente?: { nombre: string } }>;
  mensajes: Array<{ id: number; tipo: string; contenido: string; createdAt: string }>;
}

const ETAPA_COLORS: Record<string, string> = {
  nuevo: "bg-blue-100 text-blue-800",
  contactado: "bg-yellow-100 text-yellow-800",
  calificado: "bg-purple-100 text-purple-800",
  propuesta: "bg-orange-100 text-orange-800",
  negociacion: "bg-pink-100 text-pink-800",
  ganado: "bg-green-100 text-green-800",
  perdido: "bg-red-100 text-red-800",
};

function LeadScoreBadge({ score }: { score: number | null }) {
  if (score == null) return null;
  const color = score >= 70 ? "bg-green-500" : score >= 40 ? "bg-yellow-500" : "bg-gray-400";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold text-white ${color}`}>
      <Star className="w-3 h-3" />
      {score}
    </span>
  );
}

export default function ContactosPage() {
  const { tenantSlug } = useAuthStore();
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Partial<Contact> | null>(null);

  const handleSearchChange = useCallback((v: string) => {
    setSearch(v);
    const t = setTimeout(() => setDebouncedSearch(v), 300);
    return () => clearTimeout(t);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["crm-contacts", tenantSlug, debouncedSearch, page],
    queryFn: () =>
      crmApi.listContacts({ tenantSlug, q: debouncedSearch || undefined, page, limit: 50 }).then(r => r.data),
    enabled: !!tenantSlug,
  });

  const { data: detail, isLoading: loadingDetail } = useQuery({
    queryKey: ["crm-contact", selectedId],
    queryFn: () => crmApi.getContact(selectedId!, tenantSlug).then(r => r.data as ContactDetail),
    enabled: selectedId != null,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => crmApi.deleteContact(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["crm-contacts"] }),
  });

  const saveMutation = useMutation({
    mutationFn: (d: Record<string, unknown>) =>
      editing?.id
        ? crmApi.updateContact(editing.id, d)
        : crmApi.createContact({ ...d, tenantSlug }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm-contacts"] });
      setShowForm(false);
      setEditing(null);
    },
  });

  const contacts: Contact[] = data?.data ?? [];

  function openEdit(c: Contact) {
    setEditing(c);
    setShowForm(true);
  }

  function openCreate() {
    setEditing({});
    setShowForm(true);
  }

  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) {
      if (String(v).trim()) payload[k] = v;
    }
    if (fd.get("etiquetas")) {
      payload.etiquetas = String(fd.get("etiquetas"))
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);
    }
    if (fd.get("leadScore")) payload.leadScore = Number(fd.get("leadScore"));
    saveMutation.mutate(payload);
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <UserCircle2 className="w-7 h-7 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Contactos</h1>
            <p className="text-sm text-gray-500">{data?.total ?? 0} contactos totales</p>
          </div>
        </div>
        <Button onClick={openCreate} className="gap-2">
          <Plus className="w-4 h-4" />
          Nuevo Contacto
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          className="pl-10"
          placeholder="Buscar por nombre, teléfono, email, empresa..."
          value={search}
          onChange={e => handleSearchChange(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contacto</TableHead>
              <TableHead>Canal</TableHead>
              <TableHead>Etiquetas</TableHead>
              <TableHead>Lead Score</TableHead>
              <TableHead>Actividad</TableHead>
              <TableHead>Último contacto</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12 text-gray-400">
                  Cargando...
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12 text-gray-400">
                  No hay contactos
                </TableCell>
              </TableRow>
            ) : contacts.map(c => (
              <TableRow
                key={c.id}
                className="cursor-pointer hover:bg-blue-50/40 transition-colors"
                onClick={() => setSelectedId(c.id)}
              >
                <TableCell>
                  <div>
                    <p className="font-medium text-gray-900">{c.nombre ?? c.phone ?? "—"}</p>
                    <div className="flex items-center gap-3 mt-0.5">
                      {c.phone && <span className="text-xs text-gray-500 flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</span>}
                      {c.email && <span className="text-xs text-gray-500 flex items-center gap-1"><Mail className="w-3 h-3" />{c.email}</span>}
                    </div>
                    {c.empresa && <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5"><Building2 className="w-3 h-3" />{c.empresa}</p>}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs capitalize">{c.canalOrigen ?? "—"}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {(c.etiquetas ?? []).slice(0, 3).map(t => (
                      <Badge key={t} variant="secondary" className="text-xs gap-1">
                        <Tag className="w-2.5 h-2.5" />{t}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell><LeadScoreBadge score={c.leadScore} /></TableCell>
                <TableCell>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span title="Solicitudes">{c._count?.solicitudes ?? 0} sol.</span>
                    <span title="Deals">{c._count?.deals ?? 0} deals</span>
                    <span title="Tareas">{c._count?.tasks ?? 0} tareas</span>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-gray-500">
                  {c.ultimoContacto ? format(new Date(c.ultimoContacto), "dd MMM yyyy", { locale: es }) : "—"}
                </TableCell>
                <TableCell onClick={e => e.stopPropagation()}>
                  <div className="flex items-center gap-1">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(c)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-red-500 hover:text-red-700"
                      onClick={() => {
                        if (confirm(`¿Eliminar contacto ${c.nombre ?? c.phone}?`)) deleteMutation.mutate(c.id);
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Contact 360 Drawer */}
      <Dialog open={selectedId != null} onOpenChange={o => !o && setSelectedId(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCircle2 className="w-5 h-5 text-blue-600" />
              Vista 360 — {detail?.nombre ?? detail?.phone ?? "Contacto"}
            </DialogTitle>
          </DialogHeader>
          {loadingDetail ? (
            <p className="text-center py-8 text-gray-400">Cargando...</p>
          ) : detail ? (
            <Tabs defaultValue="perfil">
              <TabsList className="w-full">
                <TabsTrigger value="perfil">Perfil</TabsTrigger>
                <TabsTrigger value="solicitudes">Solicitudes ({detail.solicitudes?.length ?? 0})</TabsTrigger>
                <TabsTrigger value="deals">Deals ({detail.deals?.length ?? 0})</TabsTrigger>
                <TabsTrigger value="tareas">Tareas ({detail.tasks?.length ?? 0})</TabsTrigger>
                <TabsTrigger value="mensajes">Mensajes</TabsTrigger>
              </TabsList>

              <TabsContent value="perfil" className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Nombre" value={detail.nombre} />
                  <Field label="Teléfono" value={detail.phone} />
                  <Field label="Email" value={detail.email} />
                  <Field label="Empresa" value={detail.empresa} />
                  <Field label="Cargo" value={detail.cargo} />
                  <Field label="Canal origen" value={detail.canalOrigen} />
                  <Field label="Lead Score" value={detail.leadScore?.toString()} />
                  <Field label="Último contacto" value={detail.ultimoContacto ? format(new Date(detail.ultimoContacto), "dd/MM/yyyy HH:mm") : null} />
                </div>
                {(detail.etiquetas ?? []).length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1.5">Etiquetas</p>
                    <div className="flex flex-wrap gap-1">
                      {detail.etiquetas.map(t => <Badge key={t} variant="secondary">{t}</Badge>)}
                    </div>
                  </div>
                )}
                {detail.notas && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Notas</p>
                    <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">{detail.notas}</p>
                  </div>
                )}
                <Button size="sm" variant="outline" onClick={() => { setSelectedId(null); openEdit(detail); }}>
                  <Pencil className="w-3.5 h-3.5 mr-1.5" />Editar contacto
                </Button>
              </TabsContent>

              <TabsContent value="solicitudes" className="mt-4">
                {detail.solicitudes?.length === 0 ? (
                  <p className="text-center py-8 text-gray-400">Sin solicitudes</p>
                ) : (
                  <div className="space-y-2">
                    {detail.solicitudes?.map(s => (
                      <div key={s.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div>
                          <p className="text-sm font-medium">Solicitud #{s.id}</p>
                          <p className="text-xs text-gray-500">{s.agente?.nombre ?? "Sin agente"}</p>
                        </div>
                        <div className="text-right">
                          <Badge variant="outline">{s.estado}</Badge>
                          <p className="text-xs text-gray-400 mt-1">{format(new Date(s.createdAt), "dd/MM/yyyy")}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="deals" className="mt-4">
                {detail.deals?.length === 0 ? (
                  <p className="text-center py-8 text-gray-400">Sin deals</p>
                ) : (
                  <div className="space-y-2">
                    {detail.deals?.map(d => (
                      <div key={d.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div>
                          <p className="text-sm font-medium">{d.titulo}</p>
                          <p className="text-xs text-gray-500">{d.agente?.nombre ?? "Sin agente"}</p>
                        </div>
                        <div className="text-right">
                          <Badge className={`text-xs ${ETAPA_COLORS[d.etapa] ?? ""}`}>{d.etapa}</Badge>
                          {d.valor && <p className="text-xs font-semibold mt-1">${Number(d.valor).toLocaleString()}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="tareas" className="mt-4">
                {detail.tasks?.length === 0 ? (
                  <p className="text-center py-8 text-gray-400">Sin tareas</p>
                ) : (
                  <div className="space-y-2">
                    {detail.tasks?.map(t => (
                      <div key={t.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div>
                          <p className="text-sm font-medium">{t.titulo}</p>
                          <p className="text-xs text-gray-500 capitalize">{t.tipo}</p>
                        </div>
                        <div className="text-right">
                          <Badge variant={t.estado === "completada" ? "default" : "outline"}>{t.estado}</Badge>
                          {t.venceEn && <p className="text-xs text-gray-400 mt-1">Vence: {format(new Date(t.venceEn), "dd/MM/yyyy")}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="mensajes" className="mt-4">
                {detail.mensajes?.length === 0 ? (
                  <p className="text-center py-8 text-gray-400">Sin mensajes recientes</p>
                ) : (
                  <div className="space-y-2">
                    {detail.mensajes?.map(m => (
                      <div key={m.id} className={`p-3 rounded-lg text-sm ${m.tipo === "inbound" ? "bg-gray-50" : "bg-blue-50 ml-8"}`}>
                        <p className="text-gray-700">{m.contenido}</p>
                        <p className="text-xs text-gray-400 mt-1">{format(new Date(m.createdAt), "dd/MM HH:mm")}</p>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Create / Edit Form */}
      <Dialog open={showForm} onOpenChange={o => { setShowForm(o); if (!o) setEditing(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Editar Contacto" : "Nuevo Contacto"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <FormField name="nombre" label="Nombre" defaultValue={editing?.nombre ?? ""} />
              <FormField name="phone" label="Teléfono" defaultValue={editing?.phone ?? ""} />
              <FormField name="email" label="Email" type="email" defaultValue={editing?.email ?? ""} />
              <FormField name="empresa" label="Empresa" defaultValue={editing?.empresa ?? ""} />
              <FormField name="cargo" label="Cargo" defaultValue={editing?.cargo ?? ""} />
              <FormField name="leadScore" label="Lead Score (0-100)" type="number" defaultValue={editing?.leadScore?.toString() ?? "0"} />
            </div>
            <FormField name="etiquetas" label="Etiquetas (separadas por coma)" defaultValue={(editing?.etiquetas ?? []).join(", ")} />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => { setShowForm(false); setEditing(null); }}>Cancelar</Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Guardando..." : "Guardar"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 mt-0.5">{value ?? "—"}</p>
    </div>
  );
}

function FormField({
  name, label, type = "text", defaultValue = "",
}: {
  name: string; label: string; type?: string; defaultValue?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>
      <Input name={name} type={type} defaultValue={defaultValue} />
    </div>
  );
}
