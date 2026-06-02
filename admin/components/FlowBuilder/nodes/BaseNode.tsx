/**
 * Base custom node component for ReactFlow
 *
 * Provides common styling and behavior for all node types.
 */

import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { NodeData } from '@/lib/flowTypes';
import { NODE_META } from '@/lib/flowTypes';

export type BaseNodeProps = NodeProps<NodeData>;

/**
 * BaseNode - Common node rendering component
 *
 * All node types inherit from this for consistent styling.
 */
export const BaseNode = React.memo(
  React.forwardRef<HTMLDivElement, BaseNodeProps>(
    ({ data, selected, isConnectable }, ref) => {
      const typeKey = data.type as keyof typeof NODE_META;
      const meta = NODE_META[typeKey] || { color: '#888', bg: '#f0f0f0', label: data.type };
      const hierarchy = data.hierarchy;
      const validation = data.validation;
      const hasError = validation?.severity === 'error';
      const hasWarning = validation?.severity === 'warning';
      const issueCount = validation?.messages?.length ?? 0;

      // Truncate label for display
      const displayLabel = data.label ? (data.label.length > 25 ? `${data.label.substring(0, 22)}...` : data.label) : data.id;

      const baseBorderClass = hasError
        ? 'border-red-500'
        : hasWarning
        ? 'border-amber-500'
        : 'border-gray-300';
      const selectedClass = hasError
        ? 'ring-2 ring-red-300 border-red-600'
        : hasWarning
        ? 'ring-2 ring-amber-300 border-amber-600'
        : 'ring-2 ring-blue-400 border-blue-500';

      return (
        <div
          ref={ref}
          className={`px-3 py-2 rounded-lg border-2 transition-all ${
            selected ? selectedClass : baseBorderClass
          }`}
          title={validation?.messages?.join('\n')}
          style={{
            backgroundColor: meta.bg,
            minWidth: '140px',
            textAlign: 'center',
            fontSize: '12px',
            fontWeight: '500',
            boxShadow: hierarchy?.isParent ? `0 0 0 1px ${meta.color}33 inset` : undefined,
          }}
        >
          <div className="flex items-center justify-center gap-1 text-xs font-bold" style={{ color: meta.color }}>
            <span>{meta.label}</span>
            {hierarchy?.isParent ? (
              <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold">
                {hierarchy.childCount} hijo{hierarchy.childCount === 1 ? '' : 's'}
              </span>
            ) : null}
            {hierarchy?.isChild ? (
              <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold">
                Nivel {hierarchy.depth}
              </span>
            ) : null}
          </div>
          <div className="text-xs text-gray-700 mt-1 font-medium">{displayLabel}</div>
          {data.parentId ? (
            <div className="mt-1 text-[10px] text-gray-500">
              Padre: {data.parentId}
            </div>
          ) : null}
          {validation && issueCount > 0 ? (
            <div className={`mt-1 text-[10px] font-semibold ${hasError ? 'text-red-700' : 'text-amber-700'}`}>
              {hasError ? 'Errores' : 'Warnings'}: {issueCount}
            </div>
          ) : null}

          {/* Input handle (for connections from previous nodes) */}
          <Handle
            type="target"
            position={Position.Top}
            isConnectable={isConnectable}
            className="w-3 h-3 bg-blue-500"
          />

          {/* Output handle (for connections to next nodes) */}
          <Handle
            type="source"
            position={Position.Bottom}
            isConnectable={isConnectable}
            className="w-3 h-3 bg-green-500"
          />
        </div>
      );
    }
  )
);

BaseNode.displayName = 'BaseNode';
