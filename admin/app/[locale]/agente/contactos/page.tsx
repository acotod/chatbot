"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentAuthApi, type AgentContacto, type AgentContactoDetail } from "@/lib/agentApi";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/badge";
import { useCurrentLocale, useTranslations } from "@/lib/i18n/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Building2, Mail, Phone, Search, Star, Tag, UserCircle2 } from "lucide-react";
import { format } from "date-fns";
import { enUS, es } from "date-fns/locale";

function LeadScoreBadge({ score }: { score: number | null }) {
	if (score == null) return null;
	const color = score >= 70 ? "bg-green-500" : score >= 40 ? "bg-yellow-500" : "bg-gray-400";
	return (
		<span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-white ${color}`}>
			<Star className="h-3 w-3" />
			{score}
		</span>
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

function getMessagePreview(contenido: unknown): string {
	const pickText = (value: unknown): string | null => {
		if (typeof value === "string") return value.trim() || null;
		if (!value || typeof value !== "object") return null;
		const obj = value as Record<string, unknown>;
		return pickText(obj.text) ?? pickText(obj.body) ?? pickText(obj.message) ?? pickText(obj.caption) ?? null;
	};
	const parsed = pickText(contenido);
	if (parsed) return parsed;
	try { return JSON.stringify(contenido); } catch { return ""; }
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

export default function AgentContactosPage() {
	const t = useTranslations("contactos");
	const locale = useCurrentLocale();
	const dateFnsLocale = locale === "en" ? enUS : es;
	const [q, setQ] = useState("");
	const [debouncedQ, setDebouncedQ] = useState("");
	const [selectedId, setSelectedId] = useState<number | null>(null);

	useEffect(() => {
		const timeout = setTimeout(() => setDebouncedQ(q), 300);
		return () => clearTimeout(timeout);
	}, [q]);

	const { data, isLoading, isError } = useQuery({
		queryKey: ["agent-contactos-page", debouncedQ],
		queryFn: () => agentAuthApi.contactos({ q: debouncedQ || undefined, page: 1, limit: 100 }).then((r) => r.data),
	});

	const { data: detail, isLoading: loadingDetail } = useQuery({
		queryKey: ["agent-contacto-detail", selectedId],
		queryFn: () => agentAuthApi.contactoDetail(selectedId!).then((r) => r.data as AgentContactoDetail),
		enabled: selectedId != null,
	});

	const contacts: AgentContacto[] = data?.data ?? [];

	return (
		<div className="min-h-screen bg-slate-50">
			<Header />
			<main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
				<div className="space-y-6">
					<div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
						<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
							<div className="flex items-center gap-3">
								<UserCircle2 className="h-7 w-7 text-cyan-600" />
								<div>
									<h1 className="text-2xl font-semibold tracking-tight text-slate-900">{t("pageTitle")}</h1>
									<p className="mt-1 text-sm text-slate-500">{t("agentContacts", { count: data?.total ?? 0 })}</p>
								</div>
							</div>
						</div>

						<div className="relative mt-5 max-w-xl">
							<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
							<Input
								className="pl-10"
								value={q}
								onChange={(e) => setQ(e.target.value)}
								placeholder={t("searchPlaceholder")}
							/>
						</div>
					</div>

					<div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("contact")}</TableHead>
									<TableHead>{t("channel")}</TableHead>
									<TableHead>{t("tags")}</TableHead>
									<TableHead>{t("leadScore")}</TableHead>
									<TableHead>{t("requests")}</TableHead>
									<TableHead>{t("lastContact")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{isLoading ? (
									<TableRow>
										<TableCell colSpan={6} className="py-12 text-center text-sm text-slate-400">
											{locale === "en" ? "Loading contacts..." : "Cargando contactos..."}
										</TableCell>
									</TableRow>
								) : isError ? (
									<TableRow>
										<TableCell colSpan={6} className="py-12 text-center text-sm text-rose-600">
											{locale === "en" ? "Could not load contacts." : "No se pudieron cargar los contactos."}
										</TableCell>
									</TableRow>
								) : contacts.length === 0 ? (
									<TableRow>
										<TableCell colSpan={6} className="py-12 text-center text-sm text-slate-400">
											{t("empty")}
										</TableCell>
									</TableRow>
								) : (
									contacts.map((contact) => (
										<TableRow
											key={contact.id}
											className="cursor-pointer transition-colors hover:bg-cyan-50/40"
											onClick={() => setSelectedId(contact.id)}
										>
											<TableCell>
												<div>
													<p className="font-medium text-slate-900">{contact.nombre || contact.phone || (locale === "en" ? "No name" : "Sin nombre")}</p>
													<div className="mt-0.5 flex flex-wrap items-center gap-3">
														{contact.phone && (
															<span className="flex items-center gap-1 text-xs text-slate-500">
																<Phone className="h-3 w-3" />
																{contact.phone}
															</span>
														)}
														{contact.email && (
															<span className="flex items-center gap-1 text-xs text-slate-500">
																<Mail className="h-3 w-3" />
																{contact.email}
															</span>
														)}
													</div>
													{contact.empresa && (
														<p className="mt-0.5 flex items-center gap-1 text-xs text-slate-400">
															<Building2 className="h-3 w-3" />
															{contact.empresa}
														</p>
													)}
												</div>
											</TableCell>
											<TableCell>
												<Badge variant="outline" className="text-xs capitalize">
													{contact.canalOrigen ?? "-"}
												</Badge>
											</TableCell>
											<TableCell>
												<div className="flex flex-wrap gap-1">
													{(contact.etiquetas ?? []).slice(0, 3).map((tag) => (
														<Badge key={tag} variant="secondary" className="gap-1 text-xs">
															<Tag className="h-2.5 w-2.5" />
															{tag}
														</Badge>
													))}
												</div>
											</TableCell>
											<TableCell>
												<LeadScoreBadge score={contact.leadScore} />
											</TableCell>
											<TableCell className="text-sm text-slate-600">
												{contact._count?.solicitudes ?? 0}
											</TableCell>
											<TableCell className="text-xs text-slate-500">
												{contact.ultimoContacto ? format(new Date(contact.ultimoContacto), "dd MMM yyyy", { locale: dateFnsLocale }) : "-"}
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>

					<Link href="/agente/dashboard" className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-cyan-700 active:bg-cyan-800">
						← {locale === "en" ? "Back to dashboard" : "Volver al dashboard"}
					</Link>
				</div>
			</main>

			{/* Vista 360 Dialog */}
			<Dialog open={selectedId != null} onOpenChange={(o) => !o && setSelectedId(null)}>
				<DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<UserCircle2 className="h-5 w-5 text-cyan-600" />
							{t("contact360")} — {detail?.nombre ?? detail?.phone ?? t("contact")}
						</DialogTitle>
					</DialogHeader>
					{loadingDetail ? (
						<p className="py-8 text-center text-gray-400">{locale === "en" ? "Loading..." : "Cargando..."}</p>
					) : detail ? (
						<Tabs defaultValue="perfil">
							<TabsList className="w-full">
								<TabsTrigger value="perfil">{t("profile")}</TabsTrigger>
								<TabsTrigger value="solicitudes">{t("requests")} ({detail.solicitudes?.length ?? 0})</TabsTrigger>
								<TabsTrigger value="deals">Deals ({detail.deals?.length ?? 0})</TabsTrigger>
								<TabsTrigger value="tareas">{t("tasks")} ({detail.tasks?.length ?? 0})</TabsTrigger>
								<TabsTrigger value="mensajes">{t("recentMessages")}</TabsTrigger>
							</TabsList>

							<TabsContent value="perfil" className="mt-4 space-y-4">
								<div className="grid grid-cols-2 gap-4">
									<Field label={t("fields.name")} value={detail.nombre} />
									<Field label={t("fields.phone")} value={detail.phone} />
									<Field label={t("fields.email")} value={detail.email} />
									<Field label={t("fields.company")} value={detail.empresa} />
									<Field label={t("fields.role")} value={detail.cargo} />
									<Field label={t("fields.sourceChannel")} value={detail.canalOrigen} />
									<Field label={t("fields.leadScore")} value={detail.leadScore?.toString()} />
									<Field
										label={t("fields.lastContact")}
										value={detail.ultimoContacto ? format(new Date(detail.ultimoContacto), "dd/MM/yyyy HH:mm") : null}
									/>
								</div>
								{(detail.etiquetas ?? []).length > 0 && (
									<div>
										<p className="mb-1.5 text-xs font-medium text-gray-500">{t("tags")}</p>
										<div className="flex flex-wrap gap-1">
											{detail.etiquetas.map((tag) => (
												<Badge key={tag} variant="secondary">{tag}</Badge>
											))}
										</div>
									</div>
								)}
								{detail.notas && (
									<div>
										<p className="mb-1 text-xs font-medium text-gray-500">{t("fields.notes")}</p>
										<p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700">{detail.notas}</p>
									</div>
								)}
							</TabsContent>

							<TabsContent value="solicitudes" className="mt-4">
								{(detail.solicitudes?.length ?? 0) === 0 ? (
									<p className="py-8 text-center text-gray-400">{t("withoutRequests")}</p>
								) : (
									<div className="space-y-2">
										{detail.solicitudes?.map((s) => (
											<div key={s.id} className="flex items-center justify-between rounded-lg border p-3">
												<div>
													<p className="text-sm font-medium">Solicitud #{s.id}</p>
													<p className="text-xs text-gray-500">{s.agente?.nombre ?? t("withoutAgent")}</p>
												</div>
												<div className="text-right">
													<Badge variant="outline">{s.estado}</Badge>
													<p className="mt-1 text-xs text-gray-400">{format(new Date(s.createdAt), "dd/MM/yyyy")}</p>
												</div>
											</div>
										))}
									</div>
								)}
							</TabsContent>

							<TabsContent value="deals" className="mt-4">
								{(detail.deals?.length ?? 0) === 0 ? (
									<p className="py-8 text-center text-gray-400">{t("withoutDeals")}</p>
								) : (
									<div className="space-y-2">
										{detail.deals?.map((d) => (
											<div key={d.id} className="flex items-center justify-between rounded-lg border p-3">
												<div>
													<p className="text-sm font-medium">{d.titulo}</p>
													<p className="text-xs text-gray-500">{d.agente?.nombre ?? t("withoutAgent")}</p>
												</div>
												<div className="text-right">
													<Badge className={`text-xs ${ETAPA_COLORS[d.etapa] ?? ""}`}>{d.etapa}</Badge>
													{d.valor && <p className="mt-1 text-xs font-semibold">${Number(d.valor).toLocaleString()}</p>}
												</div>
											</div>
										))}
									</div>
								)}
							</TabsContent>

							<TabsContent value="tareas" className="mt-4">
								{(detail.tasks?.length ?? 0) === 0 ? (
									<p className="py-8 text-center text-gray-400">{t("withoutTasks")}</p>
								) : (
									<div className="space-y-2">
										{detail.tasks?.map((taskItem) => (
											<div key={taskItem.id} className="flex items-center justify-between rounded-lg border p-3">
												<div>
													<p className="text-sm font-medium">{taskItem.titulo}</p>
													<p className="text-xs capitalize text-gray-500">{taskItem.tipo}</p>
												</div>
												<div className="text-right">
													<Badge variant={taskItem.estado === "completada" ? "default" : "outline"}>{taskItem.estado}</Badge>
													{taskItem.venceEn && (
														<p className="mt-1 text-xs text-gray-400">
															{t("due")}: {format(new Date(taskItem.venceEn), "dd/MM/yyyy")}
														</p>
													)}
												</div>
											</div>
										))}
									</div>
								)}
							</TabsContent>

							<TabsContent value="mensajes" className="mt-4">
								{(detail.mensajes?.length ?? 0) === 0 ? (
									<p className="py-8 text-center text-gray-400">{t("withoutRecentMessages")}</p>
								) : (
									<div className="space-y-2">
										{detail.mensajes?.map((m) => (
											<div
												key={m.id}
												className={`rounded-lg p-3 text-sm ${m.tipo === "entrada" || m.tipo === "inbound" ? "bg-gray-50" : "ml-8 bg-cyan-50"}`}
											>
												<p className="break-words whitespace-pre-wrap text-gray-700">
													{getMessagePreview(m.contenido) || t("withoutTextMessage")}
												</p>
												<p className="mt-1 text-xs text-gray-400">{format(new Date(m.createdAt), "dd/MM HH:mm")}</p>
											</div>
										))}
									</div>
								)}
							</TabsContent>
						</Tabs>
					) : null}
				</DialogContent>
			</Dialog>
		</div>
	);
}
