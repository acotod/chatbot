"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AgentConversation, agentAuthApi, type AgentSolicitud, type AgentSolicitudMessage } from "@/lib/agentApi";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentLocale, useTranslations } from "@/lib/i18n/client";
import { cn, formatDate } from "@/lib/utils";
import { Filter, MessageCircleMore, Search } from "lucide-react";

const ESTADOS = ["open", "in_progress", "pending_info", "completed", "rejected"];
const PRIORIDADES = ["", "baja", "media", "alta"];
const CATEGORIAS = ["", "tecnico", "facturacion", "comercial", "soporte", "otro"];

const ESTADO_LABELS: Record<string, string> = {
	open: "Abierta",
	in_progress: "En progreso",
	pending_info: "Pendiente info",
	completed: "Completada",
	rejected: "Rechazada",
};

const ESTADO_LABELS_EN: Record<string, string> = {
	open: "Open",
	in_progress: "In progress",
	pending_info: "Pending info",
	completed: "Completed",
	rejected: "Rejected",
};

const PRIORIDAD_LABELS: Record<string, string> = {
	baja: "Baja",
	media: "Media",
	alta: "Alta",
};

const PRIORIDAD_LABELS_EN: Record<string, string> = {
	baja: "Low",
	media: "Medium",
	alta: "High",
};

const CATEGORIA_LABELS: Record<string, string> = {
	tecnico: "Tecnico",
	facturacion: "Facturacion",
	comercial: "Comercial",
	soporte: "Soporte",
	otro: "Otro",
};

const CATEGORIA_LABELS_EN: Record<string, string> = {
	tecnico: "Technical",
	facturacion: "Billing",
	comercial: "Sales",
	soporte: "Support",
	otro: "Other",
};

type DetailTab = "resumen" | "conversaciones" | "mensajes";

type DetailSolicitud = AgentSolicitud & {
	agente?: { id?: number; nombre: string } | null;
};

function getMessageText(message: AgentSolicitudMessage): string {
	if (typeof message.contenido === "string") return message.contenido;
	if (message.contenido && typeof message.contenido === "object" && "text" in message.contenido) {
		const text = (message.contenido as { text?: unknown }).text;
		return typeof text === "string" ? text : JSON.stringify(message.contenido);
	}
	return JSON.stringify(message.contenido);
}

export default function AgentSolicitudesPage() {
	const t = useTranslations("solicitudes");
	const locale = useCurrentLocale();
	const isEn = locale === "en";
	const qc = useQueryClient();
	const [status, setStatus] = useState<"assigned" | "completed">("assigned");
	const [detailModal, setDetailModal] = useState<{ open: boolean; solicitud: DetailSolicitud | null }>({
		open: false,
		solicitud: null,
	});
	const [detailTab, setDetailTab] = useState<DetailTab>("mensajes");
	const [detailDraft, setDetailDraft] = useState({
		estado: "",
		prioridad: "",
		categoria: "",
		subcategoria: "",
		dueAt: "",
	});
	const [messageInput, setMessageInput] = useState("");
	const [messageSearch, setMessageSearch] = useState("");
	const [messageDirection, setMessageDirection] = useState<"" | "entrada" | "salida">("");
	const [messageReadStatus, setMessageReadStatus] = useState<"" | "leido" | "no_leido">("");
	const [messageStartDate, setMessageStartDate] = useState("");
	const [messageEndDate, setMessageEndDate] = useState("");

	const { data, isLoading, isError } = useQuery({
		queryKey: ["agent-solicitudes-page", status],
		queryFn: () => agentAuthApi.solicitudes({ status, page: 1, limit: 50 }).then((r) => r.data),
	});

	const rows = data?.data ?? [];
	const total = data?.total ?? rows.length;

	useEffect(() => {
		if (!detailModal.solicitud) return;
		setDetailDraft({
			estado: detailModal.solicitud.estado || "",
			prioridad: detailModal.solicitud.prioridad || "",
			categoria: detailModal.solicitud.categoria || "",
			subcategoria: detailModal.solicitud.subcategoria || "",
			dueAt: detailModal.solicitud.dueAt ? String(detailModal.solicitud.dueAt).slice(0, 16) : "",
		});
	}, [detailModal.solicitud]);

	const detailClientKey = detailModal.solicitud?.user?.phone ?? detailModal.solicitud?.telefonoContacto ?? "";

	const { data: conversationData, isLoading: conversationsLoading } = useQuery({
		queryKey: ["agent-solicitud-conversations", detailClientKey],
		queryFn: () => agentAuthApi.conversations({ userKey: detailClientKey, limit: 50 }).then((r) => r.data),
		enabled: Boolean(detailModal.open && detailClientKey && detailTab === "conversaciones"),
		staleTime: 30_000,
	});

	const conversations = conversationData?.data ?? [];

	const { data: messagesData, isLoading: messagesLoading, refetch: refetchMessages } = useQuery({
		queryKey: [
			"agent-solicitud-messages",
			detailModal.solicitud?.id,
			messageSearch,
			messageDirection,
			messageReadStatus,
			messageStartDate,
			messageEndDate,
		],
		queryFn: () =>
			agentAuthApi
				.solicitudMessages(detailModal.solicitud?.id || 0, {
					page: 1,
					limit: 50,
					q: messageSearch.trim() || undefined,
					direccion: messageDirection || undefined,
					start: messageStartDate || undefined,
					end: messageEndDate || undefined,
					lectura: messageReadStatus || undefined,
				})
				.then((r) => r.data),
		enabled: Boolean(detailModal.open && detailModal.solicitud?.id && detailTab === "mensajes"),
		staleTime: 0,
	});

	const messageRows = messagesData?.data ?? [];
	const hasActiveMessageFilters = Boolean(
		messageSearch.trim() || messageDirection || messageReadStatus || messageStartDate || messageEndDate
	);
	const activeMessageFilterCount = [
		Boolean(messageSearch.trim()),
		Boolean(messageDirection),
		Boolean(messageReadStatus),
		Boolean(messageStartDate),
		Boolean(messageEndDate),
	].filter(Boolean).length;

	const updateAgentSolicitud = useMutation({
		mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => agentAuthApi.updateSolicitud(id, data),
		onSuccess: (_response, variables) => {
			qc.invalidateQueries({ queryKey: ["agent-solicitudes-page"] });
			setDetailModal((prev) => {
				if (!prev.solicitud || prev.solicitud.id !== variables.id) return prev;
				return {
					...prev,
					solicitud: {
						...prev.solicitud,
						estado: typeof variables.data.estado === "string" ? variables.data.estado : prev.solicitud.estado,
						prioridad: typeof variables.data.prioridad === "string" || variables.data.prioridad === null
							? (variables.data.prioridad as string | null)
							: prev.solicitud.prioridad,
						categoria: typeof variables.data.categoria === "string" || variables.data.categoria === null
							? (variables.data.categoria as string | null)
							: prev.solicitud.categoria,
						subcategoria: typeof variables.data.subcategoria === "string" || variables.data.subcategoria === null
							? (variables.data.subcategoria as string | null)
							: prev.solicitud.subcategoria,
						dueAt: typeof variables.data.dueAt === "string" || variables.data.dueAt === null
							? (variables.data.dueAt as string | null)
							: prev.solicitud.dueAt,
					},
				};
			});
		},
	});

	const sendMessageMutation = useMutation({
		mutationFn: ({ text }: { text: string }) => agentAuthApi.sendSolicitudMessage(detailModal.solicitud?.id || 0, text),
		onSuccess: () => {
			setMessageInput("");
			refetchMessages();
		},
	});

	function openSolicitudDetail(solicitud: AgentSolicitud) {
		setDetailModal({
			open: true,
			solicitud: {
				...solicitud,
				agente: null,
			},
		});
		setDetailTab("mensajes");
	}

	function applyMessageDatePreset(days: number) {
		const end = new Date();
		const start = new Date();
		start.setDate(end.getDate() - (days - 1));
		setMessageStartDate(start.toISOString().slice(0, 10));
		setMessageEndDate(end.toISOString().slice(0, 10));
	}

	function clearMessageFilters() {
		setMessageSearch("");
		setMessageDirection("");
		setMessageReadStatus("");
		setMessageStartDate("");
		setMessageEndDate("");
	}

	return (
		<div className="min-h-screen bg-slate-50">
			<Header />
			<div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
				<div className="rounded-2xl border bg-white p-5">
					<h1 className="text-xl font-semibold text-slate-900">{status === "assigned" ? t("assignedTitle") : t("completedTitle")}</h1>
					<p className="mt-1 text-sm text-slate-500">{t("agentViewSubtitle")}</p>
					<div className="mt-4 flex gap-2">
						<button
							onClick={() => setStatus("assigned")}
							className={`rounded-lg px-3 py-1.5 text-sm ${status === "assigned" ? "bg-cyan-600 text-white" : "bg-slate-100 text-slate-700"}`}
						>
							{t("assignedTitle")}
						</button>
						<button
							onClick={() => setStatus("completed")}
							className={`rounded-lg px-3 py-1.5 text-sm ${status === "completed" ? "bg-cyan-600 text-white" : "bg-slate-100 text-slate-700"}`}
						>
							{t("completedTitle")}
						</button>
					</div>
					<p className="mt-4 text-sm text-slate-500">{t("resultsCount", { count: total })}</p>
				</div>

				<Card>
					{isLoading && <div className="py-16 text-center text-sm text-slate-400">{t("loading")}</div>}
					{isError && <div className="py-16 text-center text-sm text-rose-600">{locale === "en" ? "Could not load requests." : "No se pudieron cargar las solicitudes."}</div>}
					{!isLoading && !isError && (
						<div className="overflow-x-auto">
							<table className="min-w-full text-sm">
								<thead className="bg-slate-50 text-slate-600">
									<tr>
										<th className="px-4 py-3 text-left font-medium">{t("idLabel")}</th>
										<th className="px-4 py-3 text-left font-medium">{t("tableHeaders.title")}</th>
										<th className="px-4 py-3 text-left font-medium">{t("tableHeaders.contact")}</th>
										<th className="px-4 py-3 text-left font-medium">{t("tableHeaders.category")}</th>
										<th className="px-4 py-3 text-left font-medium">{t("tableHeaders.status")}</th>
										<th className="px-4 py-3 text-left font-medium">{t("tableHeaders.priority")}</th>
										<th className="px-4 py-3 text-left font-medium">{t("tableHeaders.due")}</th>
										<th className="px-4 py-3 text-left font-medium">{t("tableHeaders.updated")}</th>
										<th className="px-4 py-3 text-left font-medium">{t("tableHeaders.actions")}</th>
									</tr>
								</thead>
								<tbody>
									{rows.length === 0 ? (
										<tr className="border-t border-slate-100">
											<td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-400">
												{t("emptyFilter")}
											</td>
										</tr>
									) : (
										rows.map((item) => (
											<tr key={item.id} className="border-t border-slate-100">
												<td className="px-4 py-3 text-slate-700">#{item.id}</td>
												<td className="px-4 py-3 text-slate-700">{item.titulo || item.nombre || t("withoutTitle")}</td>
												<td className="px-4 py-3 text-slate-600">{item.nombre || item.telefonoContacto || "-"}</td>
												<td className="px-4 py-3 text-slate-700">{(isEn ? CATEGORIA_LABELS_EN : CATEGORIA_LABELS)[item.categoria || ""] ?? item.categoria ?? "-"}</td>
												<td className="px-4 py-3 text-slate-700">{(isEn ? ESTADO_LABELS_EN : ESTADO_LABELS)[item.estado || ""] ?? item.estado ?? "-"}</td>
												<td className="px-4 py-3 text-slate-700">{(isEn ? PRIORIDAD_LABELS_EN : PRIORIDAD_LABELS)[item.prioridad || ""] ?? item.prioridad ?? "-"}</td>
												<td className="px-4 py-3 text-slate-500">{item.dueAt ? formatDate(item.dueAt) : "-"}</td>
												<td className="px-4 py-3 text-slate-500">{formatDate(item.updatedAt)}</td>
												<td className="px-4 py-3">
													<div className="flex items-center gap-2">
														{item.estado === "open" && (
															<button
																type="button"
																onClick={() => updateAgentSolicitud.mutate({ id: item.id, data: { estado: "in_progress" } })}
																className="rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700"
															>
																{t("take")}
															</button>
														)}
														{item.estado !== "completed" && item.estado !== "rejected" && (
															<button
																type="button"
																onClick={() => updateAgentSolicitud.mutate({ id: item.id, data: { estado: "completed" } })}
																className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700"
															>
																{t("complete")}
															</button>
														)}
														<button
															type="button"
															onClick={() => openSolicitudDetail(item)}
															className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700"
														>
															{t("viewConversations")}
														</button>
													</div>
												</td>
											</tr>
										))
									)}
								</tbody>
							</table>
						</div>
					)}
				</Card>

				<Link href="/agente/dashboard" className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-cyan-700 active:bg-cyan-800">
					← {locale === "en" ? "Back to dashboard" : "Volver al dashboard"}
				</Link>
			</div>

			<Modal
				open={detailModal.open}
				onClose={() => setDetailModal({ open: false, solicitud: null })}
				title={isEn ? "Request details" : "Detalle de solicitud"}
				className="max-w-4xl"
			>
				{detailModal.solicitud && (
					<>
						<div className="rounded-2xl border border-slate-200 bg-gradient-to-r from-slate-50 via-white to-blue-50 p-4 shadow-sm">
							<div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2">
										<span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
											{isEn ? "Agent view" : "Vista de agente"}
										</span>
										<span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
											{isEn ? "Request" : "Solicitud"} #{detailModal.solicitud.id}
										</span>
									</div>
									<h3 className="mt-3 truncate text-xl font-semibold text-slate-900">
										{detailModal.solicitud.nombre || detailModal.solicitud.titulo || (isEn ? "Unnamed" : "Sin nombre")}
									</h3>
									<p className="mt-1 text-sm text-slate-600">
										{detailModal.solicitud.telefonoContacto || (isEn ? "No phone" : "Sin teléfono")}
										{detailModal.solicitud.createdAt ? ` · ${isEn ? "Created" : "Creada"} ${formatDate(detailModal.solicitud.createdAt)}` : ""}
									</p>
								</div>
								<div className="flex flex-col gap-2 lg:items-end">
									<StatusBadge status={detailModal.solicitud.estado} />
									<p className="text-xs text-slate-500">{isEn ? "No assigned agent" : "Sin agente asignado"}</p>
									<p className="text-xs text-slate-500">
										{detailModal.solicitud.dueAt ? `${isEn ? "Due" : "Vence"} ${formatDate(detailModal.solicitud.dueAt)}` : (isEn ? "No due date" : "Sin vencimiento")}
									</p>
								</div>
							</div>
						</div>

						<Tabs value={detailTab} className="space-y-4">
							<TabsList className="w-full justify-start overflow-x-auto">
								<TabsTrigger value="resumen" onClick={() => setDetailTab("resumen")}>{isEn ? "Summary" : "Resumen"}</TabsTrigger>
								<TabsTrigger value="conversaciones" onClick={() => setDetailTab("conversaciones")}>{isEn ? "Customer conversations" : "Conversaciones del cliente"}</TabsTrigger>
								<TabsTrigger value="mensajes" onClick={() => setDetailTab("mensajes")}>{isEn ? "WhatsApp messages" : "Mensajes WhatsApp"}</TabsTrigger>
							</TabsList>

							<TabsContent value="resumen" className="space-y-4">
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
										<p className="text-xs uppercase tracking-wide text-slate-500">{isEn ? "Customer" : "Cliente"}</p>
										<p className="mt-1 font-medium text-slate-900">{detailModal.solicitud.nombre || (isEn ? "Unnamed" : "Sin nombre")}</p>
										<p className="text-sm text-slate-600">{detailModal.solicitud.telefonoContacto || (isEn ? "No phone" : "Sin teléfono")}</p>
									</div>
									<div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
										<p className="text-xs uppercase tracking-wide text-slate-500">{isEn ? "Status" : "Estado"}</p>
										<div className="mt-1"><StatusBadge status={detailModal.solicitud.estado} /></div>
										<p className="mt-2 text-sm text-slate-600">{isEn ? "Created:" : "Creada:"} {formatDate(detailModal.solicitud.createdAt)}</p>
									</div>
									<div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
										<p className="text-xs uppercase tracking-wide text-slate-500">{isEn ? "Connection" : "Conexión"}</p>
										<p className="mt-1 text-sm text-slate-700">{detailClientKey || (isEn ? "No customer identifier" : "Sin identificador de cliente")}</p>
									</div>
									<div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
										<p className="text-xs uppercase tracking-wide text-slate-500">{isEn ? "Due date" : "Vencimiento"}</p>
										<p className="mt-1 text-sm text-slate-700">{detailModal.solicitud.dueAt ? formatDate(detailModal.solicitud.dueAt) : (isEn ? "No date" : "Sin fecha")}</p>
									</div>
								</div>
								<div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
									<p className="text-sm font-medium text-slate-900">{isEn ? "Manage request" : "Gestionar solicitud"}</p>
									<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
										<div className="space-y-1.5">
											<label className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "Status" : "Estado"}</label>
											<select
												value={detailDraft.estado}
												onChange={(e) => setDetailDraft((prev) => ({ ...prev, estado: e.target.value }))}
												className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
											>
												{ESTADOS.map((estado) => (
													<option key={estado} value={estado}>{(isEn ? ESTADO_LABELS_EN : ESTADO_LABELS)[estado] ?? estado}</option>
												))}
											</select>
										</div>
										<div className="space-y-1.5">
											<label className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "Priority" : "Prioridad"}</label>
											<select
												value={detailDraft.prioridad}
												onChange={(e) => setDetailDraft((prev) => ({ ...prev, prioridad: e.target.value }))}
												className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
											>
												{PRIORIDADES.map((prioridad) => (
													<option key={prioridad || "empty"} value={prioridad}>{(isEn ? PRIORIDAD_LABELS_EN : PRIORIDAD_LABELS)[prioridad] ?? (isEn ? "No priority" : "Sin prioridad")}</option>
												))}
											</select>
										</div>
										<div className="space-y-1.5">
											<label className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "Category" : "Categoria"}</label>
											<select
												value={detailDraft.categoria}
												onChange={(e) => setDetailDraft((prev) => ({ ...prev, categoria: e.target.value }))}
												className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
											>
												{CATEGORIAS.map((categoria) => (
													<option key={categoria || "empty"} value={categoria}>{(isEn ? CATEGORIA_LABELS_EN : CATEGORIA_LABELS)[categoria] ?? (isEn ? "No category" : "Sin categoria")}</option>
												))}
											</select>
										</div>
										<div className="space-y-1.5">
											<label className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "Subcategory" : "Subcategoria"}</label>
											<input
												value={detailDraft.subcategoria}
												onChange={(e) => setDetailDraft((prev) => ({ ...prev, subcategoria: e.target.value }))}
												className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
												placeholder={isEn ? "Subcategory" : "Subcategoria"}
											/>
										</div>
										<div className="space-y-1.5">
											<label className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "Due" : "Vence"}</label>
											<input
												type="datetime-local"
												value={detailDraft.dueAt}
												onChange={(e) => setDetailDraft((prev) => ({ ...prev, dueAt: e.target.value }))}
												className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
											/>
										</div>
									</div>
									<div className="flex justify-end gap-3">
										<Button variant="secondary" onClick={() => setDetailModal({ open: false, solicitud: null })}>
											{isEn ? "Close" : "Cerrar"}
										</Button>
										<Button
											onClick={() => {
												if (!detailModal.solicitud) return;
												updateAgentSolicitud.mutate({
													id: detailModal.solicitud.id,
													data: {
														estado: detailDraft.estado,
														prioridad: detailDraft.prioridad || null,
														categoria: detailDraft.categoria || null,
														subcategoria: detailDraft.subcategoria || null,
														dueAt: detailDraft.dueAt ? new Date(detailDraft.dueAt).toISOString() : null,
													},
												});
											}}
											disabled={updateAgentSolicitud.isPending}
										>
											{updateAgentSolicitud.isPending ? (isEn ? "Saving..." : "Guardando...") : (isEn ? "Save changes" : "Guardar cambios")}
										</Button>
									</div>
								</div>
							</TabsContent>

							<TabsContent value="conversaciones" className="space-y-4">
								{!detailClientKey ? (
									<div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
										{isEn ? "This request does not have a customer phone number to search tenant conversations." : "Esta solicitud no tiene teléfono de cliente para buscar conversaciones del tenant."}
									</div>
								) : conversationsLoading ? (
									<div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
										{isEn ? "Loading customer conversations..." : "Cargando conversaciones del cliente..."}
									</div>
								) : conversations.length === 0 ? (
									<div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
										{isEn ? "There are no recorded conversations for this customer in this tenant." : "No hay conversaciones registradas para este cliente en este tenant."}
									</div>
								) : (
									<div className="max-h-[55vh] space-y-3 overflow-auto pr-1">
										{conversations.map((conversation: AgentConversation) => {
											const isCurrentConversation = detailModal.solicitud?.conversation?.id === conversation.id;
											return (
												<div
													key={conversation.id}
													className={`rounded-xl border p-4 ${isCurrentConversation ? "border-blue-300 bg-blue-50/50" : "border-slate-200 bg-white"}`}
												>
													<div className="flex items-start justify-between gap-3">
														<div>
															<div className="flex flex-wrap items-center gap-2">
																<p className="font-medium text-slate-900">{conversation.flow?.nombre ?? (isEn ? "Unnamed flow" : "Flujo sin nombre")}</p>
																{isCurrentConversation && (
																	<span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
																		{isEn ? "Current conversation" : "Conversación actual"}
																	</span>
																)}
															</div>
															<p className="mt-1 text-sm text-slate-500">ID {conversation.id} · {isEn ? "Status" : "Estado"} {conversation.status}</p>
															<p className="text-sm text-slate-500">
																{isEn ? "Start" : "Inicio"} {formatDate(conversation.startedAt)}
																{conversation.endedAt ? ` · ${isEn ? "End" : "Fin"} ${formatDate(conversation.endedAt)}` : ""}
															</p>
														</div>
														<div className="text-right text-xs text-slate-500">
															<p>{conversation.solicitudes?.length ?? 0} {isEn ? "linked request(s)" : "solicitud(es) vinculada(s)"}</p>
															<p className="max-w-[12rem] truncate">{conversation.userKey}</p>
														</div>
													</div>
													{conversation.solicitudes?.length ? (
														<div className="mt-3 flex flex-wrap gap-2">
															{conversation.solicitudes.map((solicitud) => (
																<span key={solicitud.id} className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600">
																	{isEn ? "Request" : "Solicitud"} #{solicitud.id} · {((isEn ? ESTADO_LABELS_EN : ESTADO_LABELS)[solicitud.estado] ?? solicitud.estado)}
																</span>
															))}
														</div>
													) : null}
												</div>
											);
										})}
									</div>
								)}
							</TabsContent>

							<TabsContent value="mensajes" className="space-y-4">
								<div className="rounded-xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white p-3 sm:p-4">
									<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
										<div>
											<div className="flex items-center gap-2 text-sm font-medium text-slate-800">
												<Filter size={16} className="text-slate-500" />
												{isEn ? "Message filters" : "Filtros de mensajes"}
											</div>
											<p className="mt-1 text-xs text-slate-500">
												{isEn ? "Quickly find messages by text, direction, read status, or date without losing chat space." : "Encontrá rápido mensajes por texto, dirección, lectura o fecha sin perder espacio del chat."}
											</p>
										</div>
										<div className="flex items-center gap-2 self-start">
											{activeMessageFilterCount > 0 ? (
												<span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
													{activeMessageFilterCount} {isEn ? "active" : "activos"}
												</span>
											) : null}
											<Button variant="secondary" size="sm" onClick={clearMessageFilters} disabled={!hasActiveMessageFilters} className="shrink-0">
												{isEn ? "Clear filters" : "Limpiar filtros"}
											</Button>
										</div>
									</div>

									<div className="mt-4 grid gap-3 lg:grid-cols-12">
										<label className="space-y-1.5 lg:col-span-4">
											<span className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "Search text" : "Buscar texto"}</span>
											<div className="relative">
												<Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
												<input
													type="text"
													value={messageSearch}
													onChange={(e) => setMessageSearch(e.target.value)}
													placeholder={isEn ? "Message text" : "Texto del mensaje"}
													className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm placeholder-slate-400 focus:border-blue-500 focus:outline-none"
												/>
											</div>
										</label>

										<label className="space-y-1.5 lg:col-span-2">
											<span className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "Direction" : "Dirección"}</span>
											<select
												value={messageDirection}
												onChange={(e) => setMessageDirection((e.target.value as "" | "entrada" | "salida") || "")}
												className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
											>
													<option value="">{isEn ? "All" : "Todas"}</option>
													<option value="entrada">{isEn ? "Received" : "Recibidos"}</option>
													<option value="salida">{isEn ? "Sent" : "Enviados"}</option>
											</select>
										</label>

										<label className="space-y-1.5 lg:col-span-2">
											<span className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "Read status" : "Lectura"}</span>
											<select
												value={messageReadStatus}
												onChange={(e) => setMessageReadStatus((e.target.value as "" | "leido" | "no_leido") || "")}
												className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
											>
													<option value="">{isEn ? "All" : "Todos"}</option>
													<option value="leido">{isEn ? "Read" : "Leidos"}</option>
													<option value="no_leido">{isEn ? "Unread" : "No leidos"}</option>
											</select>
										</label>

										<label className="space-y-1.5 lg:col-span-2">
											<span className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "From" : "Desde"}</span>
											<input
												type="date"
												value={messageStartDate}
												onChange={(e) => setMessageStartDate(e.target.value)}
												className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
											/>
										</label>

										<label className="space-y-1.5 lg:col-span-2">
											<span className="text-xs font-medium uppercase tracking-wide text-slate-500">{isEn ? "To" : "Hasta"}</span>
											<input
												type="date"
												value={messageEndDate}
												onChange={(e) => setMessageEndDate(e.target.value)}
												className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
											/>
										</label>
									</div>

									<div className="mt-3 flex flex-wrap items-center gap-2">
										<span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{isEn ? "Quick ranges" : "Rangos rápidos"}</span>
										<Button variant="secondary" size="sm" onClick={() => applyMessageDatePreset(1)}>{isEn ? "Today" : "Hoy"}</Button>
										<Button variant="secondary" size="sm" onClick={() => applyMessageDatePreset(7)}>7d</Button>
										<Button variant="secondary" size="sm" onClick={() => applyMessageDatePreset(30)}>30d</Button>
									</div>
								</div>

								{messagesLoading ? (
									<div className="flex items-center justify-center py-8">
										<div className="text-slate-500">{isEn ? "Loading messages..." : "Cargando mensajes..."}</div>
									</div>
								) : messageRows.length === 0 ? (
									<div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
										<MessageCircleMore className="mx-auto mb-2 h-6 w-6 text-slate-400" />
										<p className="text-sm text-slate-600">{isEn ? "No messages yet" : "No hay mensajes aún"}</p>
									</div>
								) : (
									<div className="max-h-96 space-y-3 overflow-y-auto">
										{messageRows.map((msg) => (
											<div
												key={msg.id}
												className={cn(
													"max-w-xs rounded-lg p-3",
													msg.direccion === "salida" ? "ml-auto bg-blue-100 text-blue-900" : "mr-auto bg-slate-100 text-slate-900",
												)}
											>
													<div className="mb-1 text-xs font-medium">{msg.direccion === "salida" ? (isEn ? "Sent" : "Enviado") : (isEn ? "Received" : "Recibido")}</div>
												<p className="break-words text-sm">{getMessageText(msg)}</p>
												<div className="mt-1 text-xs opacity-70">
													{formatDate(msg.createdAt)}
													{msg.leido && msg.direccion === "salida" && " ✓✓"}
												</div>
											</div>
										))}
									</div>
								)}

								<div className="space-y-2 border-t border-slate-200 pt-4">
									<div className="flex gap-2">
										<input
											type="text"
											value={messageInput}
											onChange={(e) => setMessageInput(e.target.value)}
											placeholder={isEn ? "Write a message..." : "Escribe un mensaje..."}
											onKeyDown={(e) => {
												if (e.key === "Enter" && !e.shiftKey && messageInput.trim()) {
													sendMessageMutation.mutate({ text: messageInput });
												}
											}}
											className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm placeholder-slate-500 focus:border-blue-500 focus:outline-none"
											disabled={sendMessageMutation.isPending}
										/>
										<Button
											onClick={() => {
												if (messageInput.trim()) {
													sendMessageMutation.mutate({ text: messageInput });
												}
											}}
											disabled={sendMessageMutation.isPending || !messageInput.trim()}
											size="sm"
										>
											{sendMessageMutation.isPending ? (isEn ? "Sending..." : "Enviando...") : (isEn ? "Send" : "Enviar")}
										</Button>
									</div>
									{sendMessageMutation.isError && <p className="text-xs text-red-600">{isEn ? "Error sending message" : "Error al enviar mensaje"}</p>}
								</div>
							</TabsContent>
						</Tabs>
					</>
				)}
			</Modal>
		</div>
	);
}
