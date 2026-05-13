"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentAuthApi, type AgentContacto } from "@/lib/agentApi";
import { Header } from "@/components/layout/Header";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Building2, Mail, Phone, Search, Star, Tag, UserCircle2 } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

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

export default function AgentContactosPage() {
	const [q, setQ] = useState("");
	const [debouncedQ, setDebouncedQ] = useState("");

	useEffect(() => {
		const timeout = setTimeout(() => setDebouncedQ(q), 300);
		return () => clearTimeout(timeout);
	}, [q]);

	const { data, isLoading, isError } = useQuery({
		queryKey: ["agent-contactos-page", debouncedQ],
		queryFn: () => agentAuthApi.contactos({ q: debouncedQ || undefined, page: 1, limit: 100 }).then((r) => r.data),
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
									<h1 className="text-2xl font-semibold tracking-tight text-slate-900">Contactos</h1>
									<p className="mt-1 text-sm text-slate-500">{data?.total ?? 0} contactos asociados a tus solicitudes</p>
								</div>
							</div>
						</div>

						<div className="relative mt-5 max-w-xl">
							<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
							<Input
								className="pl-10"
								value={q}
								onChange={(e) => setQ(e.target.value)}
								placeholder="Buscar por nombre, telefono, email o empresa"
							/>
						</div>
					</div>

					<div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Contacto</TableHead>
									<TableHead>Canal</TableHead>
									<TableHead>Etiquetas</TableHead>
									<TableHead>Lead Score</TableHead>
									<TableHead>Solicitudes</TableHead>
									<TableHead>Ultimo contacto</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{isLoading ? (
									<TableRow>
										<TableCell colSpan={6} className="py-12 text-center text-sm text-slate-400">
											Cargando contactos...
										</TableCell>
									</TableRow>
								) : isError ? (
									<TableRow>
										<TableCell colSpan={6} className="py-12 text-center text-sm text-rose-600">
											No se pudieron cargar los contactos.
										</TableCell>
									</TableRow>
								) : contacts.length === 0 ? (
									<TableRow>
										<TableCell colSpan={6} className="py-12 text-center text-sm text-slate-400">
											No hay contactos para mostrar.
										</TableCell>
									</TableRow>
								) : (
									contacts.map((contact) => (
										<TableRow key={contact.id} className="transition-colors hover:bg-cyan-50/40">
											<TableCell>
												<div>
													<p className="font-medium text-slate-900">{contact.nombre || contact.phone || "Sin nombre"}</p>
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
												{contact.ultimoContacto ? format(new Date(contact.ultimoContacto), "dd MMM yyyy", { locale: es }) : "-"}
											</TableCell>
										</TableRow>
									)))
								}
							</TableBody>
						</Table>
					</div>

					<Link href="/agente/dashboard" className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-cyan-700 active:bg-cyan-800">
						← Volver al dashboard
					</Link>
				</div>
			</main>
		</div>
	);
}
