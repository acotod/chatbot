"use client";

import { cn } from "@/lib/utils";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type MouseEvent,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
}

export function Tabs({ defaultValue, value: controlledValue, onValueChange, children, ...props }: TabsProps) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? controlledValue ?? "");
  const value = controlledValue ?? internalValue;
  const setValue = (nextValue: string) => {
    if (controlledValue === undefined) {
      setInternalValue(nextValue);
    }
    onValueChange?.(nextValue);
  };
  const ctx = useMemo(() => ({ value, setValue }), [value]);
  return (
    <TabsContext.Provider value={ctx}>
      <div {...props}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("inline-flex items-center gap-1 rounded-xl bg-slate-100 p-1", className)}
      {...props}
    />
  );
}

interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({ value, className, ...props }: TabsTriggerProps) {
  const ctx = useContext(TabsContext);
  const active = ctx?.value === value;
  const { onClick: callerOnClick, ...buttonProps } = props;
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    ctx?.setValue(value);
    callerOnClick?.(event);
  };
  return (
    <button
      type="button"
      {...buttonProps}
      className={cn(
        "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
        className
      )}
      onClick={handleClick}
    />
  );
}

interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({ value, ...props }: TabsContentProps) {
  const ctx = useContext(TabsContext);
  if (ctx?.value !== value) return null;
  return <div {...props} />;
}
