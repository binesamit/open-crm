// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { ItemTemplateNode } from '@bines/shared';
import { addChild, findNode, flatten, indentNode, locate, moveNode, outdentNode, removeNode } from './tree';

/** The template editor's tree edits: pure, by node id, the root stays put. */
const n = (id: string, children: ItemTemplateNode[] = []): ItemTemplateNode => ({
  id,
  name: id,
  cells: {},
  updates: [],
  children,
});
const shape = (r: ItemTemplateNode): unknown => (r.children.length ? { [r.id]: r.children.map(shape) } : r.id);

describe('item template tree edits', () => {
  const root = n('root', [n('a', [n('a1')]), n('b'), n('c')]);

  it('adds, finds and removes at any depth', () => {
    const t = addChild(root, 'a1', n('x'));
    expect(findNode(t, 'x')?.id).toBe('x');
    expect(locate(t, 'x')).toMatchObject({ depth: 3, parent: { id: 'a1' } });
    expect(shape(removeNode(t, 'a'))).toEqual({ root: ['b', 'c'] });
  });

  it('moves among siblings, never past the ends', () => {
    expect(shape(moveNode(root, 'b', -1))).toEqual({ root: ['b', { a: ['a1'] }, 'c'] });
    expect(moveNode(root, 'a', -1)).toEqual(root);
    expect(shape(moveNode(root, 'c', 1))).toEqual(shape(root));
  });

  it('indents under the sibling above and outdents right after the parent', () => {
    const inner = indentNode(root, 'b');
    expect(shape(inner)).toEqual({ root: [{ a: ['a1', 'b'] }, 'c'] });
    expect(indentNode(root, 'a')).toEqual(root); // nothing above it
    expect(shape(outdentNode(inner, 'b'))).toEqual({ root: [{ a: ['a1'] }, 'b', 'c'] });
  });

  it('flattens in order with depths', () => {
    expect(flatten(root).map((x) => `${x.node.id}:${x.depth}`)).toEqual(['root:0', 'a:1', 'a1:2', 'b:1', 'c:1']);
  });
});
