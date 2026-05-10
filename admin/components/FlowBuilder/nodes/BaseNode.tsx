/**
 * Base custom node component for ReactFlow
 *
 * Provides common styling and behavior for all node types.
 */

import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { NodeData } from '@/lib/flowTypes';
import { NODE_META } from '@/lib/flowTypes';

export interface BaseNodeProps extends NodeProps<NodeData> {}

/**
 * BaseNode - Common node rendering component
 *
 * All node types inherit from this for consistent styling.
 */
export const BaseNode = React.memo(
  React.forwardRef<HTMLDivElement, BaseNodeProps>(
    ({ data, selected, isConnectable, id }, ref) => {
      const typeKey = data.type as any;
      const meta = NODE_META[typeKey] || { color: '#888', bg: '#f0f0f0', label: data.type };

      // Truncate label for display
      const displayLabel = data.label ? (data.label.length > 25 ? `${data.label.substring(0, 22)}...` : data.label) : data.id;

      return (
        <div
          ref={ref}
          className={`px-3 py-2 rounded-lg border-2 transition-all ${
            selected ? 'ring-2 ring-blue-400 border-blue-500' : 'border-gray-300'
          }`}
          style={{
            backgroundColor: meta.bg,
            borderColor: meta.color,
            minWidth: '140px',
            textAlign: 'center',
            fontSize: '12px',
            fontWeight: '500',
          }}
        >
          <div className="text-xs font-bold" style={{ color: meta.color }}>
            {meta.label}
          </div>
          <div className="text-xs text-gray-700 mt-1 font-medium">{displayLabel}</div>

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
