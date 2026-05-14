"use client";

import { cn } from "@/lib/utils";
import { useCurrentLocale } from "@/lib/i18n/client";

interface BadgeProps {
  status: string;
  className?: string;
}

const STATUS_STYLES: Record<string, string> = {
  pendiente: "bg-amber-100 text-amber-700 border border-amber-200",
  atendida: "bg-green-100 text-green-700 border border-green-200",
  urgente: "bg-red-100 text-red-700 border border-red-200",
  cancelada: "bg-slate-100 text-slate-600 border border-slate-200",
  confirmado: "bg-green-100 text-green-700 border border-green-200",
  activo: "bg-emerald-100 text-emerald-700 border border-emerald-200",
  inactivo: "bg-slate-100 text-slate-500 border border-slate-200",
};

const STATUS_LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  atendida: "Atendida",
  urgente: "Urgente",
  cancelada: "Cancelada",
  confirmado: "Confirmado",
  activo: "Activo",
  inactivo: "Inactivo",
};

const STATUS_LABELS_EN: Record<string, string> = {
  pendiente: "Pending",
  atendida: "Handled",
  urgente: "Urgent",
  cancelada: "Cancelled",
  confirmado: "Confirmed",
  activo: "Active",
  inactivo: "Inactive",
  open: "Open",
  in_progress: "In progress",
  pending_info: "Pending info",
  completed: "Completed",
  rejected: "Rejected",
  asignado: "Assigned",
  en_progreso: "In progress",
  completado: "Completed",
  cancelado: "Cancelled",
};

export function StatusBadge({ status, className }: BadgeProps) {
  const locale = useCurrentLocale();
  const style = STATUS_STYLES[status] ?? "bg-slate-100 text-slate-600 border border-slate-200";
  const label = (locale === "en" ? STATUS_LABELS_EN[status] : STATUS_LABELS[status]) ?? status;

  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium",
        style,
        className
      )}
    >
      {label}
    </span>
  );
}
