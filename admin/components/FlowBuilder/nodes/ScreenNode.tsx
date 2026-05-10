/**
 * ScreenNode - Display message or screen content
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import { NodeData } from '@/lib/flowTypes';
import { BaseNode } from './BaseNode';

export type ScreenNodeProps = NodeProps<NodeData>;

const ScreenNode = React.memo((props: ScreenNodeProps) => {
  return <BaseNode {...props} />;
});

ScreenNode.displayName = 'ScreenNode';

export default ScreenNode;
