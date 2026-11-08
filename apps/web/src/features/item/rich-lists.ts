// SPDX-License-Identifier: AGPL-3.0-only
import { Extension } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { type Dir, firstStrongDir } from './rich-text-logic';

/**
 * Fix: (product owner: "numbering, bullets and check lists are only on the left"): lists in docs and updates.
 *
 * Every block has `dir="auto"` (the editor's text direction), but a list and its items have no text of their own —
 * only their paragraphs do — so the browser resolved them as left-to-right and drew the numbers, bullets and check
 * boxes on the left even in Hebrew. `ListDirection` gives every list, item and the item's own lines a direction
 * from the item's first strong letter (an empty item follows the item before it, then its parent, then the page),
 * as `data-dir` → CSS `direction`, so a Hebrew list has its markers on the right and an English one on the left.
 *
 * `ListIndent`: Tab / Shift+Tab nest and un-nest list and check-list items, as in Word; inside a list Tab never
 * leaves the editor (an item that cannot nest further just stays).
 */
const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);
const ITEMS = new Set(['listItem', 'taskItem']);

const pageDir = (): Dir => (typeof document !== 'undefined' && document.documentElement.dir === 'ltr' ? 'ltr' : 'rtl');

/** The text of an item's own first line (not its nested lists). */
const ownText = (item: PMNode) => {
  const first = item.firstChild;
  return first?.isTextblock ? first.textContent : '';
};

export const listDecorations = (doc: PMNode, fallback: Dir) => {
  const decos: Decoration[] = [];
  const visitList = (list: PMNode, pos: number, inherited: Dir) => {
    let prev: Dir | null = null;
    let listDir: Dir | null = null;
    list.forEach((item, offset) => {
      const itemPos = pos + 1 + offset;
      if (!ITEMS.has(item.type.name)) return;
      const dir = firstStrongDir(ownText(item)) ?? prev ?? inherited;
      prev = dir;
      listDir ??= dir;
      decos.push(Decoration.node(itemPos, itemPos + item.nodeSize, { 'data-dir': dir }));
      item.forEach((child, childOffset) => {
        const childPos = itemPos + 1 + childOffset;
        if (child.isTextblock) decos.push(Decoration.node(childPos, childPos + child.nodeSize, { 'data-dir': dir }));
        else visitBlock(child, childPos, dir);
      });
    });
    decos.push(Decoration.node(pos, pos + list.nodeSize, { 'data-dir': listDir ?? inherited }));
  };
  const visitBlock = (node: PMNode, pos: number, inherited: Dir) => {
    if (LISTS.has(node.type.name)) return visitList(node, pos, inherited);
    if (node.isTextblock || node.isAtom) return;
    node.forEach((child, offset) => visitBlock(child, pos + 1 + offset, inherited));
  };
  doc.forEach((child, offset) => visitBlock(child, offset, fallback));
  return DecorationSet.create(doc, decos);
};

const DIR_KEY = new PluginKey<DecorationSet>('listDirection');

export const ListDirection = Extension.create({
  name: 'listDirection',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: DIR_KEY,
        state: {
          init: (_, state) => listDecorations(state.doc, pageDir()),
          apply: (tr, old) => (tr.docChanged ? listDecorations(tr.doc, pageDir()) : old),
        },
        props: { decorations: (state) => DIR_KEY.getState(state) },
      }),
    ];
  },
});

export const ListIndent = Extension.create({
  name: 'listIndent',
  // After the list items' own Tab (which nests when it can) and after the suggestion lists (Tab picks there).
  priority: 50,
  addKeyboardShortcuts() {
    const inItem = () => this.editor.isActive('taskItem') || this.editor.isActive('listItem');
    const run = (lift: boolean) => {
      if (!inItem()) return false;
      const type = this.editor.isActive('taskItem') ? 'taskItem' : 'listItem';
      if (lift) this.editor.commands.liftListItem(type);
      else this.editor.commands.sinkListItem(type);
      return true; // in a list, Tab stays in the editor
    };
    return { Tab: () => run(false), 'Shift-Tab': () => run(true) };
  },
});

/**
 * The same directions for rendered HTML (an update in the thread, the inbox, a doc comment): every list and item
 * gets `dir` from its own first line.
 */
export const applyListDirs = (root: HTMLElement) => {
  const fallback = (getComputedStyle(root).direction === 'ltr' ? 'ltr' : 'rtl') as Dir;
  const visit = (list: Element, inherited: Dir) => {
    let prev: Dir | null = null;
    let listDir: Dir | null = null;
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI') continue;
      // The item's own line: its text without nested lists.
      let own = '';
      for (const n of Array.from(li.childNodes)) {
        if (n instanceof Element && (n.tagName === 'UL' || n.tagName === 'OL')) continue;
        if (n instanceof Element && n.tagName === 'DIV') {
          for (const m of Array.from(n.childNodes))
            if (!(m instanceof Element && (m.tagName === 'UL' || m.tagName === 'OL'))) own += m.textContent ?? '';
          continue;
        }
        own += n.textContent ?? '';
      }
      const dir: Dir = firstStrongDir(own) ?? prev ?? inherited;
      prev = dir;
      listDir ??= dir;
      li.setAttribute('dir', dir);
      li.querySelectorAll(':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol').forEach((sub) =>
        visit(sub, dir),
      );
    }
    list.setAttribute('dir', listDir ?? inherited);
  };
  root.querySelectorAll('ul, ol').forEach((list) => {
    if (list.parentElement?.closest('ul, ol') && root.contains(list.parentElement.closest('ul, ol'))) return;
    visit(list, fallback);
  });
};
