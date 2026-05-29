/**
 * ContextMenu - Right-click menu for node operations
 *
 * Provides options: Edit, Delete, Duplicate, View JSON
 */

'use client';

import React, { useMemo } from 'react';
import { Trash2, Copy, FileJson, Edit2 } from 'lucide-react';

export interface ContextMenuProps {
  x: number;
  y: number;
  nodeId: string;
  onEdit: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onDuplicate: (nodeId: string) => void;
  onViewJson: (nodeId: string) => void;
  onClose: () => void;
}

/**
 * ContextMenu component - appears on right-click
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  nodeId,
  onEdit,
  onDelete,
  onDuplicate,
  onViewJson,
  onClose,
}) => {
  const menuPosition = useMemo(() => {
    if (typeof window === 'undefined') {
      return { left: x, top: y };
    }

    const menuWidth = 212;
    const menuHeight = 176;
    const margin = 12;

    return {
      left: Math.min(x, window.innerWidth - menuWidth - margin),
      top: Math.min(y, window.innerHeight - menuHeight - margin),
    };
  }, [x, y]);

  return (
    <>
      {/* Invisible overlay to close menu on click anywhere else */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Menu container */}
      <div
        className="fixed z-50 min-w-[200px] bg-white rounded-xl shadow-xl border border-slate-200 py-1.5"
        style={{ left: `${menuPosition.left}px`, top: `${menuPosition.top}px` }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-100 mb-1">
          Acciones del nodo
        </div>

        {/* Edit option */}
        <button
          onClick={() => {
            onEdit(nodeId);
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 hover:text-[#0D2B3E] flex items-center gap-2 transition-colors"
        >
          <Edit2 size={16} />
          <span>Editar</span>
        </button>

        {/* Duplicate option */}
        <button
          onClick={() => {
            onDuplicate(nodeId);
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 hover:text-[#0D2B3E] flex items-center gap-2 transition-colors"
        >
          <Copy size={16} />
          <span>Duplicar</span>
        </button>

        {/* View JSON option */}
        <button
          onClick={() => {
            onViewJson(nodeId);
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 hover:text-[#0D2B3E] flex items-center gap-2 transition-colors border-b border-slate-100"
        >
          <FileJson size={16} />
          <span>Ver JSON</span>
        </button>

        {/* Delete option */}
        <button
          onClick={() => {
            onDelete(nodeId);
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors"
        >
          <Trash2 size={16} />
          <span>Eliminar</span>
        </button>
      </div>
    </>
  );
};

export default ContextMenu;
