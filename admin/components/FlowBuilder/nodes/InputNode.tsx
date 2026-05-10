/**
 * InputNode - User input collection node
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import { NodeData } from '@/lib/flowTypes';
import { BaseNode } from './BaseNode';

export type InputNodeProps = NodeProps<NodeData>;

const InputNode = React.memo((props: InputNodeProps) => {
  return <BaseNode {...props} />;
});

InputNode.displayName = 'InputNode';

export default InputNode;
