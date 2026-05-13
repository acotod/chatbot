"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentAuthApi } from "@/lib/agentApi";

export default function AgentSolicitudesPage() {
	const [status, setStatus] = useState<"assigned" | "completed">("assigned");

	const { data, isLoading, isError } = useQuery({
		queryKey: ["agent-solicitudes-page", status],
		queryFn: () => agentAuthApi.solicitudes({ status, page: 1, limit: 50 }).then((r) => r.data),
	});

	const rows = data?.data ?? [];

	return (
		<div className="min-h-screen bg-slate-50 p-4 sm:p-6">
			<div className="mx-auto max-w-5xl space-y-4">
				<div className="rounded-2xl border bg-white p-5">
					<h1 className="text-xl font-semibold text-slate-900">Solicitudes asignadas</h1>
					<p className="mt-1 text-sm text-slate-500">Vista del agente sobre sus solicitudes.</p>
					<div className="mt-4 flex gap-2">
						<button
							onClick={() => setStatus("assigned")}
							className={`rounded-lg px-3 py-1.5 text-sm ${status === "assigned" ? "bg-cyan-600 text-white" : "bg-slate-100 text-slate-700"}`}
						>
							Asignadas
						</button>
						<button
							onClick={() => setStatus("completed")}
							className={`rounded-lg px-3 py-1.5 text-sm ${status === "completed" ? "bg-cyan-600 text-white" : "bg-slate-100 text-slate-700"}`}
						>
							Finalizadas
						</button>
					</div>
					<p className="mt-4 text-sm text-slate-500">{rows.length} resultados</p>
				</div>

				<div className="rounded-2xl border bg-white p-5">
					{isLoading && <p className="text-sm text-slate-500">Cargando solicitudes...</p>}
					{isError && <p className="text-sm text-rose-600">No se pudieron cargar las solicitudes.</p>}
					{!isLoading && !isError && rows.length === 0 && (
						<p className="text-sm text-slate-500">No hay solicitudes para este filtro.</p>
					)}
					{!isLoading && !isError && rows.length > 0 && (
						<ul className="divide-y divide-slate-100">
							{rows.map((item) => (
								<li key={item.id} className="py-3">
									<p className="text-sm font-medium text-slate-800">{item.titulo || item.nombre || `Solicitud #${item.id}`}</p>
									<p className="mt-1 text-xs text-slate-500">Estado: {item.estado || "-"}</p>
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
