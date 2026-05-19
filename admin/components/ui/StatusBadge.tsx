"use client";

import { cn } from "@/lib/utils";
import { useCurrentLocale } from "@/lib/i18n/client";

interface BadgeProps {
  status: string;
  className?: string;
}

const STATUS_STYLES: Record<string, string> = {
  pendiente: "bg-[#F6C244]/16 text-[#F6D57D] border border-[#F6C244]/22",
  atendida: "bg-[#00BFAE]/16 text-[#39E6D2] border border-[#39E6D2]/22",
  urgente: "bg-red-500/15 text-red-300 border border-red-400/28",
  cancelada: "bg-[#0D2B3E]/72 text-[#97B6C3] border border-[#39E6D2]/14",
  confirmado: "bg-[#00BFAE]/16 text-[#39E6D2] border border-[#39E6D2]/22",
  activo: "bg-[#00BFAE]/18 text-[#39E6D2] border border-[#39E6D2]/24",
  inactivo: "bg-[#0D2B3E]/72 text-[#97B6C3] border border-[#39E6D2]/14",
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
  const style = STATUS_STYLES[status] ?? "bg-[#0D2B3E]/72 text-[#97B6C3] border border-[#39E6D2]/14";
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
