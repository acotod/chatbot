/**
 * StartNode - Entry point node for flows
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import { NodeData } from '@/lib/flowTypes';
import { BaseNode } from './BaseNode';

export type StartNodeProps = NodeProps<NodeData>;

const StartNode = React.memo((props: StartNodeProps) => {
  return <BaseNode {...props} />;
});

StartNode.displayName = 'StartNode';

export default StartNode;
