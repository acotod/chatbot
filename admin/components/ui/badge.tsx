import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

type BadgeVariant = "default" | "secondary" | "outline";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const VARIANTS: Record<BadgeVariant, string> = {
  default: "bg-slate-900 text-white",
  secondary: "bg-slate-100 text-slate-700",
  outline: "border border-slate-300 text-slate-700 bg-white",
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        VARIANTS[variant],
        className
      )}
      {...props}
    />
  );
}
