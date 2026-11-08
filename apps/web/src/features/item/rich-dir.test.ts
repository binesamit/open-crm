// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { extensions as core, getSchema } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { Decoration } from '@tiptap/pm/view';
import { baseDir, fieldDir, firstStrongDir } from '@bines/ui';
import { blockDirDecorations, fixBlockDirs, savedDir } from './rich-dir';

// The editors' schema: `textDirection: 'auto'` adds a `dir` attribute to every node.
const schema = getSchema([StarterKit, TaskList, TaskItem, core.TextDirection.configure({ direction: 'auto' })]);
const p = (text: string, dir = 'auto') => schema.nodes.paragraph!.create({ dir }, text ? schema.text(text) : undefined);
const doc = (...blocks: PMNode[]) => schema.nodes.doc!.create({ dir: 'auto' }, blocks);

/** The saved `dir` of every top-level block after the plugin's fix. */
const fixed = (d: PMNode) => {
  const tr = fixBlockDirs(EditorState.create({ schema, doc: d }).tr);
  const out = tr ? tr.doc : d;
  const dirs: unknown[] = [];
  out.forEach((b) => dirs.push(b.attrs.dir));
  return { changed: !!tr, dirs };
};

const shownDirs = (d: PMNode, base: 'rtl' | 'ltr') =>
  blockDirDecorations(d, base)
    .find()
    .map((deco) => (deco as Decoration & { type: { attrs: Record<string, string> } }).type.attrs.dir);

describe('firstStrongDir / fieldDir (rtltype)', () => {
  it('takes the first strong letter, skipping digits, spaces, punctuation and emoji', () => {
    expect(firstStrongDir('hello')).toBe('ltr');
    expect(firstStrongDir('שלום')).toBe('rtl');
    expect(firstStrongDir('  123, 🙂 - hello שלום')).toBe('ltr');
    expect(firstStrongDir('42 שלום hello')).toBe('rtl');
    expect(firstStrongDir('مرحبا')).toBe('rtl');
    expect(firstStrongDir('Привет')).toBe('ltr');
    expect(firstStrongDir('')).toBeNull();
    expect(firstStrongDir('123 ...')).toBeNull();
  });

  it('a field is the base direction when empty or neutral, else its first strong letter', () => {
    expect(fieldDir('', 'rtl')).toBe('rtl');
    expect(fieldDir('', 'ltr')).toBe('ltr');
    expect(fieldDir('2026', 'rtl')).toBe('rtl');
    expect(fieldDir(undefined, 'rtl')).toBe('rtl');
    expect(fieldDir('hello', 'rtl')).toBe('ltr');
    expect(fieldDir('שלום', 'ltr')).toBe('rtl');
    expect(fieldDir(12, 'ltr')).toBe('ltr');
  });

  it('the base direction follows the UI language, not the text', () => {
    expect(baseDir('he')).toBe('rtl');
    expect(baseDir('en')).toBe('ltr');
  });
});

describe('TypingDirection plugin (rtltype)', () => {
  it('saves each text block with its own direction, "auto" when it has no strong letter', () => {
    const r = fixed(doc(p(''), p('hello'), p('שלום'), p('123'), p('hello', 'rtl')));
    expect(r.changed).toBe(true);
    expect(r.dirs).toEqual(['auto', 'ltr', 'rtl', 'auto', 'ltr']);
    expect(savedDir(p('  - שלום'))).toBe('rtl');
  });

  it('a block split from an English line (attrs copied) goes back to "auto" while empty', () => {
    expect(fixed(doc(p('hello', 'ltr'), p('', 'ltr'))).dirs).toEqual(['ltr', 'auto']);
  });

  it('changes nothing when every block is already right (no endless appendTransaction)', () => {
    expect(fixed(doc(p('', 'auto'), p('hello', 'ltr'), p('שלום', 'rtl'))).changed).toBe(false);
  });

  it('shows empty / neutral blocks (and older docs saved as "auto") in the base direction', () => {
    const d = doc(p(''), p('hello'), p('שלום'), p('42'));
    expect(shownDirs(d, 'rtl')).toEqual(['rtl', 'ltr', 'rtl', 'rtl']);
    expect(shownDirs(d, 'ltr')).toEqual(['ltr', 'ltr', 'rtl', 'ltr']);
  });

  it('leaves list items to ListDirection', () => {
    const item = schema.nodes.listItem!.create({ dir: 'auto' }, [p('')]);
    const list = schema.nodes.bulletList!.create({ dir: 'auto' }, [item]);
    expect(shownDirs(doc(list, p('')), 'rtl')).toEqual(['rtl']);
  });

  it('headings and quotes follow the same rule', () => {
    const h = schema.nodes.heading!.create({ level: 2, dir: 'auto' }, schema.text('Title'));
    const q = schema.nodes.blockquote!.create({ dir: 'auto' }, [p('')]);
    expect(shownDirs(doc(h, q), 'rtl')).toEqual(['ltr', 'rtl']);
    expect(fixed(doc(h, q)).dirs[0]).toBe('ltr');
  });
});
