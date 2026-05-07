export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Portal de Solicitudes</h1>
          <p className="text-sm text-slate-500 mt-1">Seguimiento de estado y comunicación con soporte</p>
        </div>
        {children}
      </div>
    </div>
  );
}
