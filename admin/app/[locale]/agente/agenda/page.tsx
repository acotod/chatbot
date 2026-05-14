"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { agentAuthApi } from "@/lib/agentApi";
import { Header } from "@/components/layout/Header";
import { useCurrentLocale, useTranslations } from "@/lib/i18n/client";

export default function AgentAgendaPage() {
	const t = useTranslations("agenda");
	const locale = useCurrentLocale();
	const dateLocale = locale === "en" ? "en-US" : "es-ES";
	const { data, isLoading, isError } = useQuery({
		queryKey: ["agent-agenda-page"],
		queryFn: () => agentAuthApi.agenda().then((r) => r.data),
	});

	const events = data?.data ?? [];

	return (
		<div className="min-h-screen bg-slate-50">
			<Header />
			<div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
				<div className="rounded-2xl border bg-white p-5">
					<h1 className="text-xl font-semibold text-slate-900">{t("myAgendaTitle")}</h1>
					<p className="mt-1 text-sm text-slate-500">{t("myAgendaSubtitle")}</p>
					<p className="mt-4 text-sm text-slate-500">{t("eventsCount", { count: events.length })}</p>
				</div>

				<div className="rounded-2xl border bg-white p-5">
					{isLoading && <p className="text-sm text-slate-500">{t("loadingAgenda")}</p>}
					{isError && <p className="text-sm text-rose-600">{locale === "en" ? "Could not load agenda." : "No se pudo cargar la agenda."}</p>}
					{!isLoading && !isError && events.length === 0 && (
						<p className="text-sm text-slate-500">{t("noAssignedEvents")}</p>
					)}
					{!isLoading && !isError && events.length > 0 && (
						<ul className="divide-y divide-slate-100">
							{events.map((event) => (
								<li key={event.id} className="py-3">
									<p className="text-sm font-medium text-slate-800">{event.titulo}</p>
									<p className="mt-1 text-xs text-slate-500">
										{new Date(event.startAt).toLocaleString(dateLocale)} - {new Date(event.endAt).toLocaleString(dateLocale)}
									</p>
								</li>
							))}
						</ul>
					)}
				</div>

				<Link href="/agente/dashboard" className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-cyan-700 active:bg-cyan-800">
					← {locale === "en" ? "Back to dashboard" : "Volver al dashboard"}
				</Link>
			</div>
		</div>
	);
}
