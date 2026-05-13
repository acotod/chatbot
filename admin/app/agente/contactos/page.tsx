"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentAuthApi } from "@/lib/agentApi";

export default function AgentContactosPage() {
	const [q, setQ] = useState("");

	const { data, isLoading, isError } = useQuery({
		queryKey: ["agent-contactos-page", q],
		queryFn: () => agentAuthApi.contactos({ q: q || undefined, page: 1, limit: 100 }).then((r) => r.data),
	});

	const contacts = data?.data ?? [];

	return (
		<div className="min-h-screen bg-slate-50 p-4 sm:p-6">
			<div className="mx-auto max-w-5xl space-y-4">
				<div className="rounded-2xl border bg-white p-5">
					<h1 className="text-xl font-semibold text-slate-900">Contactos</h1>
					<p className="mt-1 text-sm text-slate-500">Contactos asociados a conversaciones del agente.</p>
					<input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Buscar por nombre, telefono o email"
						className="mt-4 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
					/>
				</div>

				<div className="rounded-2xl border bg-white p-5">
					{isLoading && <p className="text-sm text-slate-500">Cargando contactos...</p>}
					{isError && <p className="text-sm text-rose-600">No se pudieron cargar los contactos.</p>}
					{!isLoading && !isError && contacts.length === 0 && (
						<p className="text-sm text-slate-500">No hay contactos para mostrar.</p>
					)}
					{!isLoading && !isError && contacts.length > 0 && (
						<ul className="divide-y divide-slate-100">
							{contacts.map((contact) => (
								<li key={contact.id} className="py-3">
									<p className="text-sm font-medium text-slate-800">{contact.nombre || "Sin nombre"}</p>
									<p className="mt-1 text-xs text-slate-500">{contact.phone || "Sin telefono"} {contact.email ? `| ${contact.email}` : ""}</p>
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
