/**
 * CustomEdge - Custom edge component with labels for branch conditions
 *
 * Displays connection lines with optional labels (branch names, conditions).
 */

import React from 'react';
import {
  EdgeProps,
  getSmoothStepPath,
  Edge,
  EdgeLabelRenderer,
} from 'reactflow';
import { FlowEdgeData } from '@/lib/flowTypes';

export type CustomEdgeProps = EdgeProps<Edge<FlowEdgeData>>;

const CustomEdge = React.memo(
  ({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style = {},
    data,
  }: CustomEdgeProps) => {
    const [edgePath, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });

    const label = data?.label || data?.branch || '';
    const isHighlighted = data?.branch === 'true' || data?.branch === 'false';
    const strokeColor = isHighlighted ? '#d97706' : '#94a3b8';

    return (
      <>
        <path
          id={id}
          d={edgePath}
          style={{
            ...style,
            stroke: strokeColor,
            strokeWidth: 2,
            fill: 'none',
          }}
          className="react-flow__edge-path"
        />

        {/* Animated arrow marker */}
        <defs>
          <marker
            id={`arrow-${id}`}
            markerWidth="20"
            markerHeight="20"
            markerUnits="strokeWidth"
            orient="auto"
            refX="10"
            refY="5"
          >
            <path d="M0,0 L0,10 L10,5 z" fill={strokeColor} />
          </marker>
        </defs>

        {/* Edge label with branch name */}
        {label && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                fontSize: 12,
                fontWeight: 600,
                pointerEvents: 'all',
                backgroundColor: 'white',
                padding: '2px 6px',
                borderRadius: '4px',
                border: `1px solid ${strokeColor}`,
                color: strokeColor,
                zIndex: 10,
              }}
            >
              {label}
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  }
);

CustomEdge.displayName = 'CustomEdge';

export default CustomEdge;
