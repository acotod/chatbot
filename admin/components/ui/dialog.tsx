"use client";

import { cn } from "@/lib/utils";
import {
  createContext,
  useContext,
  useEffect,
  type HTMLAttributes,
  type ReactNode,
} from "react";

interface DialogContextValue {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

interface DialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  return (
    <DialogContext.Provider value={{ open, onOpenChange }}>
      {children}
    </DialogContext.Provider>
  );
}

interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {}

export function DialogContent({ className, children, ...props }: DialogContentProps) {
  const ctx = useContext(DialogContext);
  if (!ctx?.open) return null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") ctx.onOpenChange?.(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ctx]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => ctx.onOpenChange?.(false)}
      />
      <div
        className={cn(
          "relative w-full rounded-2xl bg-white p-6 shadow-xl",
          className
        )}
        onClick={(event) => event.stopPropagation()}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-lg font-semibold text-slate-900", className)} {...props} />;
}
