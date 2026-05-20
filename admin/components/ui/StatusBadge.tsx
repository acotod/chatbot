"use client";

import { cn } from "@/lib/utils";
import { useCurrentLocale } from "@/lib/i18n/client";

interface BadgeProps {
  status: string;
  className?: string;
}

const STATUS_STYLES: Record<string, string> = {
  pendiente: "bg-amber-50 text-amber-700 border border-amber-200",
  atendida: "bg-[#EEF9F7] text-[#0D2B3E] border border-[#BFEDE7]",
  urgente: "bg-red-50 text-red-700 border border-red-200",
  cancelada: "bg-[#F4F7F9] text-[#5B6670] border border-[#D9E5EB]",
  confirmado: "bg-[#EEF9F7] text-[#0D2B3E] border border-[#BFEDE7]",
  activo: "bg-[#EEF9F7] text-[#0D2B3E] border border-[#BFEDE7]",
  inactivo: "bg-[#F4F7F9] text-[#5B6670] border border-[#D9E5EB]",
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
  const style = STATUS_STYLES[status] ?? "bg-[#F4F7F9] text-[#5B6670] border border-[#D9E5EB]";
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
