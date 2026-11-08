// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { peersOf } from './collab';
import { blockAt, peerBlocks } from './editor/presence';

/** live presence in docs — who is here, in which block, typing or not. */
const state = (entries: [number, Record<string, unknown>][]) => new Map(entries);

describe('peersOf', () => {
  it('leaves me out and merges one person’s tabs (typing in any counts, the typing tab’s block wins)', () => {
    const peers = peersOf(
      state([
        [1, { user: { name: 'Me', id: 'u0' } }],
        [2, { user: { name: 'Dana', id: 'u1', color: '#f00' }, block: 'b1' }],
        [3, { user: { name: 'Dana', id: 'u1', color: '#f00' }, block: 'b2', typing: true }],
        [4, { user: { name: 'Avi', id: 'u2' } }],
        [5, {}],
      ]).entries(),
      1,
    );
    expect(peers).toHaveLength(2);
    expect(peers[0]).toMatchObject({ name: 'Dana', userId: 'u1', block: 'b2', typing: true, color: '#f00' });
    expect(peers[1]).toMatchObject({ name: 'Avi', userId: 'u2', block: null, typing: false });
  });
  it('an older client without a user id stays a row of its own', () => {
    const peers = peersOf(state([[2, { user: { name: 'A' } }], [3, { user: { name: 'A' } }]]).entries(), 1);
    expect(peers).toHaveLength(2);
  });
});

describe('peerBlocks', () => {
  it('maps the others’ blocks to their colour and names, me and one person’s second tab left out', () => {
    const blocks = peerBlocks({
      clientID: 1,
      getStates: () =>
        state([
          [1, { user: { name: 'Me', id: 'u0', color: '#000' }, block: 'b1' }],
          [2, { user: { name: 'Dana', id: 'u1', color: '#f00' }, block: 'b1' }],
          [3, { user: { name: 'Dana', id: 'u1', color: '#f00' }, block: 'b1', typing: true }],
          [4, { user: { name: 'Avi', id: 'u2', color: '#0f0' }, block: 'b1' }],
          [5, { user: { name: 'Noa', id: 'u3', color: '#00f' }, block: null }],
        ]),
    });
    expect([...blocks.keys()]).toEqual(['b1']);
    expect(blocks.get('b1')).toEqual({ color: '#f00', names: ['Dana', 'Avi'], typing: false });
  });
});

describe('blockAt', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*', attrs: { id: { default: null } } },
      listItem: { content: 'paragraph+', attrs: { id: { default: null } } },
      bulletList: { group: 'block', content: 'listItem+' },
      text: {},
    },
  });
  it('the innermost block with an id around the caret', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', { id: 'p1' }, [schema.text('one')]),
      schema.node('bulletList', null, [
        schema.node('listItem', { id: 'li1' }, [schema.node('paragraph', { id: 'p2' }, [schema.text('two')])]),
      ]),
    ]);
    const at = (pos: number) =>
      blockAt(EditorState.create({ doc, selection: TextSelection.create(doc, pos) }));
    expect(at(2)).toBe('p1');
    expect(at(9)).toBe('p2');
  });
  it('a block without an id: the nearest one around it that has one', () => {
    const doc = schema.node('doc', null, [
      schema.node('bulletList', null, [
        schema.node('listItem', { id: 'li1' }, [schema.node('paragraph', null, [schema.text('x')])]),
      ]),
    ]);
    expect(blockAt(EditorState.create({ doc, selection: TextSelection.create(doc, 3) }))).toBe('li1');
  });
});
