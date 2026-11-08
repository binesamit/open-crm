// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import type { RichNode } from '@bines/shared';
import { listDecorations } from './rich-lists';
import { firstStrongDir, setTaskChecked, taskCount } from './rich-text-logic';

const p = (text: string): RichNode => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
const task = (text: string, checked = false, nested?: RichNode): RichNode => ({
  type: 'taskItem',
  attrs: { checked },
  content: [p(text), ...(nested ? [nested] : [])],
});
const li = (text: string, nested?: RichNode): RichNode => ({
  type: 'listItem',
  content: [p(text), ...(nested ? [nested] : [])],
});

describe('firstStrongDir (Fix: #1)', () => {
  it('takes the first letter, skipping digits, spaces and punctuation', () => {
    expect(firstStrongDir('שלום')).toBe('rtl');
    expect(firstStrongDir('Hello שלום')).toBe('ltr');
    expect(firstStrongDir('12. — שלום world')).toBe('rtl');
    expect(firstStrongDir('مرحبا')).toBe('rtl');
    expect(firstStrongDir('  123 !?')).toBeNull();
    expect(firstStrongDir('')).toBeNull();
  });
});

describe('setTaskChecked (Fix: #5)', () => {
  const doc: RichNode = {
    type: 'doc',
    content: [
      p('intro'),
      { type: 'taskList', content: [task('a'), task('b', true, { type: 'taskList', content: [task('b1')] })] },
      { type: 'taskList', content: [task('c')] },
    ],
  };
  it('ticks the n-th box in document order (the rendered order), nested ones included', () => {
    expect(taskCount(doc)).toBe(4);
    const next = setTaskChecked(doc, 2, true)!;
    const nested = next.content![1]!.content![1]!.content![1]!.content![0]!;
    expect(nested.attrs).toEqual({ checked: true });
    expect(setTaskChecked(doc, 1, false)!.content![1]!.content![1]!.attrs).toEqual({ checked: false });
    expect(setTaskChecked(doc, 3, true)!.content![2]!.content![0]!.attrs).toEqual({ checked: true });
  });
  it('never changes the input; an index past the end is null', () => {
    const before = JSON.stringify(doc);
    setTaskChecked(doc, 0, true);
    expect(JSON.stringify(doc)).toBe(before);
    expect(setTaskChecked(doc, 9, true)).toBeNull();
  });
});

describe('list directions in the editor (Fix: #1)', () => {
  const schema = getSchema([StarterKit, TaskList, TaskItem.configure({ nested: true })]);
  const dirs = (json: RichNode, fallback: 'rtl' | 'ltr' = 'rtl') => {
    const doc = schema.nodeFromJSON(json);
    const set = listDecorations(doc, fallback);
    const out: string[] = [];
    doc.descendants((node, pos) => {
      const d = set
        .find(pos, pos + node.nodeSize, () => true)
        .find((x) => x.from === pos && x.to === pos + node.nodeSize);
      if (d)
        out.push(
          `${node.type.name}:${(d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['data-dir']}`,
        );
    });
    return out;
  };
  it('a Hebrew list is rtl, an English one ltr; an empty item follows the one before it', () => {
    expect(dirs({ type: 'doc', content: [{ type: 'bulletList', content: [li('שלום'), li('')] }] }, 'ltr')).toEqual([
      'bulletList:rtl',
      'listItem:rtl',
      'paragraph:rtl',
      'listItem:rtl',
      'paragraph:rtl',
    ]);
    expect(dirs({ type: 'doc', content: [{ type: 'orderedList', content: [li('one')] }] })).toEqual([
      'orderedList:ltr',
      'listItem:ltr',
      'paragraph:ltr',
    ]);
  });
  it('an empty list takes the page direction; a nested empty list takes its parent item’s', () => {
    expect(dirs({ type: 'doc', content: [{ type: 'taskList', content: [task('')] }] })).toEqual([
      'taskList:rtl',
      'taskItem:rtl',
      'paragraph:rtl',
    ]);
    const nested = dirs({
      type: 'doc',
      content: [{ type: 'bulletList', content: [li('English', { type: 'bulletList', content: [li('')] })] }],
    });
    expect(nested).toContain('bulletList:ltr');
    expect(nested.filter((x) => x.endsWith(':rtl'))).toEqual([]);
  });
});
