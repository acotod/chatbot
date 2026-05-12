import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck, Trash2, Clock3, Mail, ExternalLink } from "lucide-react";

export const metadata: Metadata = {
  title: "Eliminacion de datos de usuario",
  description: "Instrucciones para solicitar eliminacion de datos de usuario vinculados con Facebook Login.",
};

export default function FacebookDataDeletionInstructionsPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-blue-50 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
          <div className="bg-slate-900 px-6 py-8 sm:px-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium uppercase tracking-wide text-white/90">
              <ShieldCheck className="h-3.5 w-3.5" />
              Facebook Data Deletion
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Eliminacion de datos de usuario
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-200 sm:text-base">
              Esta pagina explica como solicitar la eliminacion de los datos asociados a tu cuenta cuando usaste Facebook Login.
            </p>
          </div>

          <div className="space-y-8 px-6 py-8 sm:px-10">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <Trash2 className="mb-3 h-5 w-5 text-blue-700" />
                <h2 className="text-sm font-semibold text-slate-900">Paso 1</h2>
                <p className="mt-1 text-sm text-slate-600">Abre Facebook y entra a Configuracion y privacidad.</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <ExternalLink className="mb-3 h-5 w-5 text-blue-700" />
                <h2 className="text-sm font-semibold text-slate-900">Paso 2</h2>
                <p className="mt-1 text-sm text-slate-600">Ve a Apps y sitios web, selecciona esta app y elige Eliminar.</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <Clock3 className="mb-3 h-5 w-5 text-blue-700" />
                <h2 className="text-sm font-semibold text-slate-900">Paso 3</h2>
                <p className="mt-1 text-sm text-slate-600">Facebook envia la solicitud y te mostraremos un codigo de confirmacion.</p>
              </div>
            </div>

            <section className="rounded-2xl border border-blue-100 bg-blue-50 p-5">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-blue-900">Que datos eliminamos</h3>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-700">
                <li>Desvinculacion del identificador de Facebook de la cuenta administrativa.</li>
                <li>Revocacion de sesiones y tokens asociados.</li>
                <li>Anonimizacion de datos de perfil usados para autenticacion por Facebook.</li>
              </ul>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Estado de la solicitud</h3>
              <p className="mt-2 text-sm text-slate-600">
                Una vez recibida la solicitud, Facebook recibira una URL de confirmacion con un codigo unico.
              </p>
              <p className="mt-3 text-sm text-slate-700">
                Puedes revisar un ejemplo de pagina de estado aqui:{" "}
                <Link
                  href="/auth/facebook/data-deletion/status/example-code"
                  className="font-medium text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900"
                >
                  ver estado de eliminacion
                </Link>
                .
              </p>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Contacto</h3>
              <p className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                <Mail className="h-4 w-4 text-slate-500" />
                Si necesitas ayuda adicional, escribe a soporte del tenant o al administrador del sistema.
              </p>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
