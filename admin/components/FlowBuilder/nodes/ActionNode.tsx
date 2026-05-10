/**
 * ActionNode - Execute custom action or integration
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import { NodeData } from '@/lib/flowTypes';
import { BaseNode } from './BaseNode';

export type ActionNodeProps = NodeProps<NodeData>;

const ActionNode = React.memo((props: ActionNodeProps) => {
  return <BaseNode {...props} />;
});

ActionNode.displayName = 'ActionNode';

export default ActionNode;
