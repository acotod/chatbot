/**
 * ConditionNode - Branching logic based on conditions
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import { NodeData } from '@/lib/flowTypes';
import { BaseNode } from './BaseNode';

export type ConditionNodeProps = NodeProps<NodeData>;

const ConditionNode = React.memo((props: ConditionNodeProps) => {
  return <BaseNode {...props} />;
});

ConditionNode.displayName = 'ConditionNode';

export default ConditionNode;
