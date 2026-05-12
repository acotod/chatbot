import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, ArrowLeft } from "lucide-react";

type StatusPageProps = {
  params: Promise<{ code: string }>;
};

export const metadata: Metadata = {
  title: "Estado de eliminacion de datos",
  description: "Confirmacion de solicitud de eliminacion de datos de usuario.",
};

export default async function FacebookDataDeletionStatusPage({ params }: StatusPageProps) {
  const resolvedParams = await params;
  const code = resolvedParams.code || "unknown";

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-xl sm:p-10">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
            <CheckCircle2 className="h-8 w-8 text-green-700" />
          </div>

          <h1 className="mt-5 text-center text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Solicitud recibida
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-center text-sm text-slate-600 sm:text-base">
            Hemos recibido tu solicitud de eliminacion de datos asociada a Facebook Login.
          </p>

          <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Confirmation Code</p>
            <p className="mt-2 break-all rounded-lg bg-white px-3 py-2 font-mono text-sm text-slate-800 ring-1 ring-slate-200">
              {code}
            </p>
          </div>

          <p className="mt-6 text-sm text-slate-600">
            Conserva este codigo como referencia. Si necesitas asistencia adicional, contacta al soporte del sistema.
          </p>

          <div className="mt-8">
            <Link
              href="/facebook/data-deletion"
              className="inline-flex items-center gap-2 text-sm font-medium text-blue-700 hover:text-blue-900"
            >
              <ArrowLeft className="h-4 w-4" />
              Ver instrucciones de eliminacion
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
