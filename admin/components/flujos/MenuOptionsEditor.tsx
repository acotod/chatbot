"use client";

import { Plus, Trash2 } from "lucide-react";

export interface MenuOptionItem {
  id: string;
  title: string;
  next?: string;
}

interface NextNodeOption {
  value: string;
  label: string;
}

interface MenuOptionsEditorProps {
  options: MenuOptionItem[];
  onAddOption: () => void;
  onRemoveOption: (index: number) => void;
  onChangeOption: (index: number, key: "id" | "title" | "next", value: string) => void;
  nextNodeOptions?: NextNodeOption[];
  showNextSelector?: boolean;
  title?: string;
  emptyText?: string;
  addLabel?: string;
  idPlaceholder?: string;
  titlePlaceholder?: string;
  nextPlaceholder?: string;
  compact?: boolean;
}

export default function MenuOptionsEditor({
  options,
  onAddOption,
  onRemoveOption,
  onChangeOption,
  nextNodeOptions = [],
  showNextSelector = true,
  title = "Opciones",
  emptyText = "Sin opciones",
  addLabel = "Agregar opción",
  idPlaceholder = "id",
  titlePlaceholder = "Título",
  nextPlaceholder = "— ninguno —",
  compact = false,
}: MenuOptionsEditorProps) {
  const rowCls = compact
    ? "flex gap-2 items-center"
    : "rounded-lg border border-gray-200 p-3 space-y-2 bg-gray-50";

  const idInputCls = compact
    ? "w-24 rounded-lg border border-slate-200 px-2 py-1 text-xs font-mono focus:outline-none"
    : "w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400";

  const titleInputCls = compact
    ? "flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs focus:outline-none"
    : "w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400";

  const nextInputCls = compact
    ? "w-36 rounded-lg border border-slate-200 px-2 py-1 text-xs focus:outline-none"
    : "w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className={compact ? "text-xs font-medium text-slate-600" : "text-xs font-semibold text-gray-500 uppercase tracking-wide"}>{title}</label>
        <button
          type="button"
          onClick={onAddOption}
          className={compact
            ? "flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800"
            : "flex items-center gap-1 text-xs font-semibold text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1.5 hover:bg-blue-50"
          }
        >
          <Plus className="w-3 h-3" /> {addLabel}
        </button>
      </div>

      {options.length === 0 && (
        <p className={compact ? "text-xs text-slate-400 italic" : "text-xs text-gray-400"}>{emptyText}</p>
      )}

      <div className="space-y-2">
        {options.map((opt, index) => (
          <div key={`${opt.id || "opt"}-${index}`} className={rowCls}>
            {!compact && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Opción {index + 1}</p>
                <button type="button" onClick={() => onRemoveOption(index)} className="text-red-400 hover:text-red-600">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <input
              value={opt.id ?? ""}
              onChange={(e) => onChangeOption(index, "id", e.target.value)}
              placeholder={idPlaceholder}
              className={idInputCls}
            />

            <input
              value={opt.title ?? ""}
              onChange={(e) => onChangeOption(index, "title", e.target.value)}
              placeholder={titlePlaceholder}
              className={titleInputCls}
            />

            {showNextSelector && (
              <select
                value={opt.next ?? ""}
                onChange={(e) => onChangeOption(index, "next", e.target.value)}
                className={nextInputCls}
              >
                <option value="">{nextPlaceholder}</option>
                {nextNodeOptions.map((candidate) => (
                  <option key={candidate.value} value={candidate.value}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            )}

            {compact && (
              <button
                type="button"
                onClick={() => onRemoveOption(index)}
                className="text-red-400 hover:text-red-600 shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}