/**
 * EndNode - Termination point of flow
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import { NodeData } from '@/lib/flowTypes';
import { BaseNode } from './BaseNode';

export type EndNodeProps = NodeProps<NodeData>;

const EndNode = React.memo((props: EndNodeProps) => {
  return <BaseNode {...props} />;
});

EndNode.displayName = 'EndNode';

export default EndNode;
