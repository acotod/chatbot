/**
 * ContextMenu - Right-click menu for node operations
 *
 * Provides options: Edit, Delete, Duplicate, View JSON
 */

'use client';

import React, { useState } from 'react';
import { Trash2, Copy, FileJson, Edit2, X } from 'lucide-react';

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
        className="fixed z-50 bg-white rounded-lg shadow-lg border border-gray-200 py-1"
        style={{ left: `${x}px`, top: `${y}px` }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Edit option */}
        <button
          onClick={() => {
            onEdit(nodeId);
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 flex items-center gap-2 transition-colors"
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
          className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-green-50 hover:text-green-700 flex items-center gap-2 transition-colors"
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
          className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-purple-50 hover:text-purple-700 flex items-center gap-2 transition-colors border-b border-gray-100"
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
