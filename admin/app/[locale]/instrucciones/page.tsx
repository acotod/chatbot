import type { Metadata } from "next";
import { ShieldCheck, Trash2, Clock3, Mail, ExternalLink } from "lucide-react";

export const metadata: Metadata = {
  title: "Instrucciones de Prueba - Facebook Login",
  description: "Instrucciones detalladas para Meta App Review sobre la integración de Facebook Login",
};

export default function TestingInstructionsPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-blue-50 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
          {/* Header */}
          <div className="bg-gradient-to-r from-purple-600 to-purple-800 px-6 py-12 sm:px-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium uppercase tracking-wide text-white/90">
              <ShieldCheck className="h-3.5 w-3.5" />
              Meta App Review
            </div>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Instrucciones de Prueba
            </h1>
            <p className="mt-2 max-w-2xl text-base text-purple-100 sm:text-lg">
              Integración de Facebook Login para Panel Administrativo
            </p>
          </div>

          {/* Content */}
          <div className="space-y-8 px-6 py-8 sm:px-10">
            {/* Resumen */}
            <div>
              <h2 className="mb-4 text-2xl font-bold text-purple-700">📋 Resumen General</h2>
              <div className="rounded-lg border-l-4 border-purple-500 bg-purple-50 p-5">
                <p className="text-slate-700">
                  Esta aplicación integra <strong>Facebook Login</strong> como puerta de acceso para administradores que conectan y gestionan activos de WhatsApp Business dentro de Zentra Bot. La app solicita <strong>email</strong>, <strong>public_profile</strong> y <strong>whatsapp_business_management</strong> para identificar al administrador y comprobar por API que tiene acceso a los negocios de WhatsApp que luego administra desde la plataforma.
                </p>
              </div>
            </div>

            {/* Permisos */}
            <div>
              <h2 className="mb-4 text-2xl font-bold text-purple-700">✅ Permisos Solicitados</h2>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b-2 border-purple-200 bg-purple-50">
                      <th className="px-4 py-3 text-left font-semibold text-purple-700">Permiso</th>
                      <th className="px-4 py-3 text-left font-semibold text-purple-700">Propósito</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-slate-200">
                      <td className="px-4 py-3 font-mono text-sm font-medium">email</td>
                      <td className="px-4 py-3 text-slate-700">
                        Obtener la dirección de correo para validar si existe una cuenta administrativa vinculada
                      </td>
                    </tr>
                    <tr className="border-b border-slate-200">
                      <td className="px-4 py-3 font-mono text-sm font-medium">public_profile</td>
                      <td className="px-4 py-3 text-slate-700">
                        Obtener nombre e identificador de Facebook para auditoría y registros de inicio de sesión
                      </td>
                    </tr>
                    <tr className="border-b border-slate-200">
                      <td className="px-4 py-3 font-mono text-sm font-medium">whatsapp_business_management</td>
                      <td className="px-4 py-3 text-slate-700">
                        Leer por Graph API los negocios del usuario con <code className="text-xs font-mono">GET /me/businesses</code> y verificar que la cuenta puede administrar activos de WhatsApp Business antes de habilitar la sesión del panel
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="mt-4 rounded-lg border-l-4 border-blue-500 bg-blue-50 p-4 text-sm text-blue-900">
                <strong>ℹ️ Nota:</strong> No se solicitan permisos para publicar contenido. El permiso adicional de WhatsApp se usa solo para validar acceso a activos empresariales requeridos por la integración.
              </div>
            </div>

            {/* Pasos */}
            <div>
              <h2 className="mb-4 text-2xl font-bold text-purple-700">🧪 Pasos para Probar</h2>
              <div className="space-y-4">
                {[
                  {
                    title: "Acceder a la pantalla de inicio de sesión",
                    description: "Abre el navegador e ingresa a la URL del panel administrativo. Busca el botón \"Continuar con Facebook\"."
                  },
                  {
                    title: "Hacer clic en \"Continuar con Facebook\"",
                    description: "Se abrirá el diálogo de autorización de Facebook con email, public_profile y whatsapp_business_management."
                  },
                  {
                    title: "Autorizar con una cuenta de prueba",
                    description: "Inicia sesión con una cuenta de Facebook que tenga email disponible y ya esté vinculada a una cuenta administrativa."
                  },
                  {
                    title: "Validación obligatoria por API",
                    description: "Después de autorizar, el backend llama a Graph API para leer permisos concedidos y consultar GET /me/businesses con el mismo token."
                  },
                  {
                    title: "Verificar el resultado",
                    description: "Si la cuenta está vinculada y la llamada a /me/businesses funciona, la app iniciará sesión correctamente y mostrará el panel."
                  }
                ].map((step, idx) => (
                  <div key={idx} className="flex gap-4">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-600 to-purple-800 text-sm font-bold text-white">
                      {idx + 1}
                    </div>
                    <div className="flex-1 pt-1">
                      <h3 className="font-semibold text-slate-900">{step.title}</h3>
                      <p className="mt-1 text-slate-700">{step.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Resultados */}
            <div>
              <h2 className="mb-4 text-2xl font-bold text-purple-700">✨ Resultados Esperados</h2>
              
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-green-700">✅ Caso 1: Cuenta vinculada correctamente</h3>
                  <div className="mt-2 rounded-lg border-l-4 border-green-500 bg-green-50 p-4 text-sm text-green-900">
                    <ul className="space-y-1">
                      <li>• El usuario es redirigido al panel administrativo después de autorizar</li>
                      <li>• Se asignan tokens JWT válidos para la sesión</li>
                      <li>• El email de Facebook coincide con el de la cuenta administrativa</li>
                      <li>• La API confirma que `whatsapp_business_management` fue concedido</li>
                      <li>• La llamada `GET /me/businesses` devuelve negocios accesibles por el usuario</li>
                      <li>• Se registra la acción en auditoría con el método "facebook"</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-orange-700">⚠️ Caso 2: Email no vinculado</h3>
                  <div className="mt-2 rounded-lg border-l-4 border-orange-500 bg-orange-50 p-4 text-sm text-orange-900">
                    <ul className="space-y-1">
                      <li>• La app rechaza el acceso con HTTP 403</li>
                      <li>• Se muestra: "No admin account is linked to this Facebook email"</li>
                      <li>• Se registra un intento fallido en auditoría</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-orange-700">⚠️ Caso 3: Falta permiso de WhatsApp</h3>
                  <div className="mt-2 rounded-lg border-l-4 border-orange-500 bg-orange-50 p-4 text-sm text-orange-900">
                    <ul className="space-y-1">
                      <li>• Si la cuenta no concede <code className="text-xs font-mono">whatsapp_business_management</code></li>
                      <li>• La app rechaza con HTTP 403</li>
                      <li>• Se muestra: "Missing whatsapp_business_management permission"</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-orange-700">⚠️ Caso 4: Cuenta sin email</h3>
                  <div className="mt-2 rounded-lg border-l-4 border-orange-500 bg-orange-50 p-4 text-sm text-orange-900">
                    <ul className="space-y-1">
                      <li>• Si la cuenta no tiene email disponible</li>
                      <li>• La app rechaza con HTTP 400</li>
                      <li>• Se muestra: "Facebook account has no email available"</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* Flujo Técnico */}
            <div>
              <h2 className="mb-4 text-2xl font-bold text-purple-700">⚙️ Flujo Técnico</h2>
              
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-slate-900">1. Frontend: Obtención del Token</h3>
                  <div className="mt-2 rounded-lg border-l-4 border-slate-300 bg-slate-50 p-4 text-sm text-slate-700">
                    La app carga el SDK de Facebook desde <code className="text-xs font-mono">https://connect.facebook.net/es_LA/sdk.js</code>, verifica el estado con <code className="text-xs font-mono">FB.getLoginStatus()</code> y luego llama a <code className="text-xs font-mono">FB.login()</code> solicitando <code className="text-xs font-mono">email,public_profile,whatsapp_business_management</code> con <code className="text-xs font-mono">auth_type=rerequest</code> para forzar la concesión del permiso requerido.
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-slate-900">2. Backend: Validación</h3>
                  <div className="mt-2 rounded-lg border-l-4 border-slate-300 bg-slate-50 p-4 text-sm text-slate-700">
                    <p className="mb-2"><strong>Endpoint:</strong> <code className="text-xs font-mono">POST /auth/facebook</code></p>
                    <ul className="space-y-1">
                      <li>• Recibe el <code className="text-xs font-mono">accessToken</code> en el body</li>
                      <li>• Valida el token en <code className="text-xs font-mono">graph.facebook.com/v25.0/debug_token</code></li>
                      <li>• Consulta <code className="text-xs font-mono">graph.facebook.com/v25.0/me/permissions</code> para verificar permisos concedidos</li>
                      <li>• Ejecuta <code className="text-xs font-mono">graph.facebook.com/v25.0/me/businesses</code> con el mismo token</li>
                      <li>• Verifica que el <code className="text-xs font-mono">app_id</code> coincida con la configuración</li>
                      <li>• Obtiene el perfil e identifica al administrador</li>
                      <li>• Solo si existe, emite JWT y sesión</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-slate-900">3. Auditoría</h3>
                  <div className="mt-2 rounded-lg border-l-4 border-slate-300 bg-slate-50 p-4 text-sm text-slate-700">
                    <p className="mb-2">Cada login exitoso se registra con:</p>
                    <ul className="space-y-1">
                      <li>• <code className="text-xs font-mono">accion: "LOGIN"</code></li>
                      <li>• <code className="text-xs font-mono">metadata: {'{'} via: "facebook", facebookId: "...", facebookPermissions: [...], facebookBusinessIds: [...] {'}'}</code></li>
                      <li>• IP del cliente y User-Agent</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* Conformidad */}
            <div>
              <h2 className="mb-4 text-2xl font-bold text-purple-700">🛡️ Conformidad con Políticas de Meta</h2>
              
              <div className="rounded-lg border-l-4 border-green-500 bg-green-50 p-4 mb-4">
                <p className="font-semibold text-green-900">✓ La app cumple con:</p>
              </div>

              <div className="grid gap-2 text-sm text-slate-700">
                <div>✅ <strong>Transparencia:</strong> Solo solicita permisos necesarios para login y validación de activos de WhatsApp (email, public_profile, whatsapp_business_management)</div>
                <div>✅ <strong>Seguridad:</strong> Token validado en backend; app secret no expuesto en frontend</div>
                <div>✅ <strong>Datos del usuario:</strong> Solo se guardan email e identificador para autenticación</div>
                <div>✅ <strong>Callback de eliminación:</strong> Implementado en <code className="text-xs font-mono">/auth/facebook/data-deletion</code></div>
                <div>✅ <strong>Uso del permiso:</strong> La app demuestra el uso de <code className="text-xs font-mono">whatsapp_business_management</code> con la llamada obligatoria <code className="text-xs font-mono">GET /me/businesses</code></div>
                <div>✅ <strong>No automatización social:</strong> No publica, comenta, reacciona ni modifica contenido</div>
                <div>✅ <strong>No exfiltración:</strong> No descarga listas de amigos ni datos privados</div>
              </div>
            </div>

            {/* Callback */}
            <div>
              <h2 className="mb-4 text-2xl font-bold text-purple-700">🗑️ Callback de Eliminación de Datos</h2>
              
              <div className="rounded-lg border-l-4 border-slate-300 bg-slate-50 p-4 text-sm text-slate-700">
                <p className="mb-2"><strong>URL pública:</strong> <code className="text-xs font-mono">https://[tu-dominio]/auth/facebook/data-deletion</code></p>
                <p>Cuando un usuario elimina la app desde Facebook, Meta envía una solicitud firmada. El backend:</p>
                <ul className="mt-2 space-y-1">
                  <li>• Verifica la firma con el app secret</li>
                  <li>• Extrae el Facebook ID</li>
                  <li>• Anonimiza datos vinculados</li>
                  <li>• Retorna un código de confirmación único a Meta</li>
                </ul>
              </div>
            </div>

            {/* FAQ */}
            <div>
              <h2 className="mb-4 text-2xl font-bold text-purple-700">❓ Preguntas Frecuentes</h2>
              
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-slate-900">¿La app accede a las páginas de Facebook del usuario?</h3>
                  <p className="mt-1 text-slate-700"><strong>No.</strong> La app no administra páginas ni publica contenido. Solo solicita <code className="text-xs font-mono">email</code>, <code className="text-xs font-mono">public_profile</code> y <code className="text-xs font-mono">whatsapp_business_management</code> para validar acceso a activos empresariales de WhatsApp.</p>
                </div>

                <div>
                  <h3 className="font-semibold text-slate-900">¿Se publican datos en las redes del usuario?</h3>
                  <p className="mt-1 text-slate-700"><strong>No.</strong> La app es de solo lectura. No publica, comenta ni modifica contenido.</p>
                </div>

                <div>
                  <h3 className="font-semibold text-slate-900">¿Cómo usará la app whatsapp_business_management?</h3>
                  <p className="mt-1 text-slate-700"><strong>Para validar y administrar activos de WhatsApp Business.</strong> Durante el login el backend consulta <code className="text-xs font-mono">/me/permissions</code> y <code className="text-xs font-mono">/me/businesses</code> con el token del usuario. Esa validación confirma qué negocios puede administrar el usuario antes de permitirle conectar o gestionar cuentas de WhatsApp Business desde Zentra Bot.</p>
                </div>

                <div>
                  <h3 className="font-semibold text-slate-900">¿Cómo se eliminan los datos?</h3>
                  <p className="mt-1 text-slate-700">Meta envía una solicitud POST a <code className="text-xs font-mono">/auth/facebook/data-deletion</code>. El backend anonimiza los datos y retorna un código de confirmación.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-slate-200 bg-slate-50 px-6 py-8 sm:px-10">
            <p className="text-center text-sm text-slate-600">
              <strong>Última actualización:</strong> Mayo 2026
            </p>
            <p className="mt-2 text-center text-xs text-slate-500">
              © Zentra Bot - Instrucciones de Prueba Meta App Review
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
