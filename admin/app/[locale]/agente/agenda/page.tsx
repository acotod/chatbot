"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { agentAuthApi } from "@/lib/agentApi";
import { Header } from "@/components/layout/Header";
import { useCurrentLocale, useTranslations } from "@/lib/i18n/client";

function toGoogleCalendarEmbedUrl(calendarLink: string | null | undefined): string | null {
	if (!calendarLink) return null;

	try {
		const parsed = new URL(calendarLink);
		const isGoogleCalendar = /(^|\.)calendar\.google\.com$/i.test(parsed.hostname);
		if (!isGoogleCalendar) return null;

		if (parsed.pathname.includes("/calendar/embed")) {
			return parsed.toString();
		}

		const src = parsed.searchParams.get("src") || parsed.searchParams.get("cid");
		if (!src) return null;

		const embed = new URL("https://calendar.google.com/calendar/embed");
		embed.searchParams.set("src", src);
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (timezone) embed.searchParams.set("ctz", timezone);
		return embed.toString();
	} catch {
		return null;
	}
}

export default function AgentAgendaPage() {
	const t = useTranslations("agenda");
	const locale = useCurrentLocale();
	const dateLocale = locale === "en" ? "en-US" : "es-ES";
	const isEn = locale === "en";
	const { data, isLoading, isError } = useQuery({
		queryKey: ["agent-agenda-page"],
		queryFn: () => agentAuthApi.agenda().then((r) => r.data),
	});
	const { data: me } = useQuery({
		queryKey: ["agent-me-agenda-page"],
		queryFn: () => agentAuthApi.me().then((r) => r.data),
	});

	const events = data?.data ?? [];
	const googleCalendarUrl = me?.calendarLink ?? null;
	const googleEmbedUrl = toGoogleCalendarEmbedUrl(googleCalendarUrl);

	return (
		<div className="min-h-screen bg-slate-50">
			<Header />
			<div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
				<div className="rounded-2xl border bg-white p-5">
					<h1 className="text-xl font-semibold text-slate-900">
						{googleEmbedUrl ? "Google Calendar" : t("myAgendaTitle")}
					</h1>
					<p className="mt-1 text-sm text-slate-500">
						{googleEmbedUrl
							? (isEn
								? "This view is synced with your Google Calendar."
								: "Esta vista esta sincronizada con tu Google Calendar.")
							: t("myAgendaSubtitle")}
					</p>
					<p className="mt-4 text-sm text-slate-500">{t("eventsCount", { count: events.length })}</p>
				</div>

				<div className="rounded-2xl border bg-white p-5">
					{googleEmbedUrl ? (
						<div className="space-y-4">
							<iframe
								title="Google Calendar"
								src={googleEmbedUrl}
								className="h-[680px] w-full rounded-xl border border-slate-200"
								loading="lazy"
							/>
							{googleCalendarUrl && (
								<a
									href={googleCalendarUrl}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-2 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-100"
								>
									{isEn ? "Open in Google Calendar" : "Abrir en Google Calendar"}
								</a>
							)}
							<div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="text-sm font-semibold text-slate-900">{isEn ? "System bookings" : "Reservas del sistema"}</p>
										<p className="text-xs text-slate-500">{isEn ? "Reservations created in Zentra Bot still appear here even if Google Calendar is connected." : "Las reservas creadas en Zentra Bot siguen apareciendo aqui aunque Google Calendar este conectado."}</p>
									</div>
									<p className="text-xs text-slate-500">{t("eventsCount", { count: events.length })}</p>
								</div>
								{events.length === 0 ? (
									<p className="mt-4 text-sm text-slate-500">{t("noAssignedEvents")}</p>
								) : (
									<ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
										{events.map((event) => (
											<li key={event.id} className="px-4 py-3">
												<div className="flex items-start justify-between gap-3">
													<div>
														<p className="text-sm font-medium text-slate-800">{event.titulo}</p>
														<p className="mt-1 text-xs text-slate-500">
															{new Date(event.startAt).toLocaleString(dateLocale)} - {new Date(event.endAt).toLocaleString(dateLocale)}
														</p>
													</div>
													<span className="rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 bg-slate-100">
														{event.source === "appointment" ? (isEn ? "Reservation" : "Reserva") : (isEn ? "Event" : "Evento")}
													</span>
												</div>
											</li>
										))}
									</ul>
								)}
						</div>
						</div>
					) : (
						<>
							{isLoading && <p className="text-sm text-slate-500">{t("loadingAgenda")}</p>}
							{isError && <p className="text-sm text-rose-600">{isEn ? "Could not load agenda." : "No se pudo cargar la agenda."}</p>}
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
						</>
					)}
				</div>

				<Link href="/agente/dashboard" className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-cyan-700 active:bg-cyan-800">
					← {isEn ? "Back to dashboard" : "Volver al dashboard"}
				</Link>
			</div>
		</div>
	);
}
