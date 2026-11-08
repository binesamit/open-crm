// SPDX-License-Identifier: MIT
import { NodeApiError, NodeOperationError, type INode } from 'n8n-workflow';

/**
 * An error as n8n shows it: an API error (the transport's NodeApiError) or a node error passes as it is; anything else
 * (a network failure, a bug) becomes a NodeOperationError of this node, so n8n can attach it to the node and item.
 */
export const nodeError = (node: INode, e: unknown, itemIndex?: number): NodeApiError | NodeOperationError =>
  e instanceof NodeApiError || e instanceof NodeOperationError
    ? e
    : new NodeOperationError(node, e instanceof Error ? e : String(e), itemIndex === undefined ? {} : { itemIndex });
