import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { CreditCard, Zap, Shield } from "lucide-react";

const PLANS = [
  {
    name: "Starter",
    price: "$29",
    period: "/mes",
    features: ["1 tenant", "1,000 msgs/mes", "1 agente", "Soporte básico"],
    current: false,
  },
  {
    name: "Pro",
    price: "$79",
    period: "/mes",
    features: [
      "5 tenants",
      "10,000 msgs/mes",
      "10 agentes",
      "Analytics",
      "Soporte prioritario",
    ],
    current: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    features: [
      "Tenants ilimitados",
      "Mensajes ilimitados",
      "Agentes ilimitados",
      "SLA 99.9%",
      "Soporte dedicado",
    ],
    current: false,
  },
];

export default function FacturacionPage() {
  return (
    <div className="space-y-6 max-w-4xl">
      {/* Current plan */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CreditCard className="w-5 h-5 text-blue-600" />
            <h2 className="font-semibold text-slate-900">Plan actual</h2>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-2xl font-bold text-slate-900">
                Pro{" "}
                <span className="text-base font-normal text-slate-500">
                  $79/mes
                </span>
              </p>
              <p className="text-sm text-slate-500 mt-1">
                Próxima facturación: 1 de junio, 2026
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-100 text-green-700 text-sm font-medium">
              <Zap size={14} />
              Activo
            </span>
          </div>

          {/* Usage bars */}
          <div className="mt-6 space-y-4">
            {[
              { label: "Mensajes este mes", used: 4200, total: 10000 },
              { label: "Agentes activos", used: 3, total: 10 },
              { label: "Tenants", used: 2, total: 5 },
            ].map((item) => (
              <div key={item.label}>
                <div className="flex items-center justify-between text-sm mb-1.5">
                  <span className="text-slate-600">{item.label}</span>
                  <span className="text-slate-500 font-medium">
                    {item.used.toLocaleString()} /{" "}
                    {item.total.toLocaleString()}
                  </span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 rounded-full transition-all"
                    style={{ width: `${(item.used / item.total) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Plans */}
      <div>
        <h2 className="font-semibold text-slate-900 mb-4">Planes disponibles</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map((plan) => (
            <Card
              key={plan.name}
              className={
                plan.current ? "ring-2 ring-blue-500 ring-offset-2" : ""
              }
            >
              <CardContent className="pt-5">
                {plan.current && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium mb-3">
                    <Shield size={11} />
                    Plan actual
                  </span>
                )}
                <h3 className="font-bold text-slate-900 text-lg">{plan.name}</h3>
                <p className="text-2xl font-bold text-slate-900 mt-1">
                  {plan.price}
                  <span className="text-sm font-normal text-slate-500">
                    {plan.period}
                  </span>
                </p>
                <ul className="mt-4 space-y-2">
                  {plan.features.map((f) => (
                    <li
                      key={f}
                      className="flex items-center gap-2 text-sm text-slate-600"
                    >
                      <span className="w-4 h-4 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold shrink-0">
                        ✓
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
                {!plan.current && (
                  <button className="mt-5 w-full py-2 rounded-xl border border-blue-600 text-blue-600 text-sm font-medium hover:bg-blue-50 transition">
                    {plan.name === "Enterprise"
                      ? "Contactar ventas"
                      : "Cambiar plan"}
                  </button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
