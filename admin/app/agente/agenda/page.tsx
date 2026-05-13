"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { agentAuthApi } from "@/lib/agentApi";

export default function AgentAgendaPage() {
	const { data, isLoading, isError } = useQuery({
		queryKey: ["agent-agenda-page"],
		queryFn: () => agentAuthApi.agenda().then((r) => r.data),
	});

	const events = data?.data ?? [];

	return (
		<div className="min-h-screen bg-slate-50 p-4 sm:p-6">
			<div className="mx-auto max-w-5xl space-y-4">
				<div className="rounded-2xl border bg-white p-5">
					<h1 className="text-xl font-semibold text-slate-900">Mi agenda</h1>
					<p className="mt-1 text-sm text-slate-500">Eventos asignados al agente (proximos 30 dias).</p>
					<p className="mt-4 text-sm text-slate-500">{events.length} eventos</p>
				</div>

				<div className="rounded-2xl border bg-white p-5">
					{isLoading && <p className="text-sm text-slate-500">Cargando agenda...</p>}
					{isError && <p className="text-sm text-rose-600">No se pudo cargar la agenda.</p>}
					{!isLoading && !isError && events.length === 0 && (
						<p className="text-sm text-slate-500">No hay eventos programados.</p>
					)}
					{!isLoading && !isError && events.length > 0 && (
						<ul className="divide-y divide-slate-100">
							{events.map((event) => (
								<li key={event.id} className="py-3">
									<p className="text-sm font-medium text-slate-800">{event.titulo}</p>
									<p className="mt-1 text-xs text-slate-500">
										{new Date(event.startAt).toLocaleString("es-ES")} - {new Date(event.endAt).toLocaleString("es-ES")}
									</p>
								</li>
							))}
						</ul>
					)}
				</div>

				<Link href="/agente/dashboard" className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-cyan-700 active:bg-cyan-800">
					← Volver al dashboard
				</Link>
			</div>
		</div>
	);
}
