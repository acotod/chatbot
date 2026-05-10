/**
 * WebhookNode - External API integration node
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import { NodeData } from '@/lib/flowTypes';
import { BaseNode } from './BaseNode';

export type WebhookNodeProps = NodeProps<NodeData>;

const WebhookNode = React.memo((props: WebhookNodeProps) => {
  return <BaseNode {...props} />;
});

WebhookNode.displayName = 'WebhookNode';

export default WebhookNode;
