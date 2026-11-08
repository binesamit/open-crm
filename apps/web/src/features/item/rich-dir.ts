// SPDX-License-Identifier: AGPL-3.0-only
import { Extension } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { baseDir, firstStrongDir, type TextDir } from '@bines/ui';

/**
 * Prod fix "rtltype" (product owner: "in RTL typing must start on the right unless what is typed is English; in updates it
 * starts on the left until you type Hebrew"). The editors used `dir="auto"` on every block, and an empty
 * `dir="auto"` block is left-to-right — the caret and the placeholder sat on the left.
 *
 * `TypingDirection`, for every rich editor (updates, replies, doc comments, docs):
 * - saved: each text block's `dir` attribute is its first strong letter's ("ltr" / "rtl"), or "auto" when it has
 *   none (empty / digits only). Computed from the content alone, so co-editors in different UI languages agree
 *   and never fight over it;
 * - shown: a block with no strong letter takes the UI's base direction (rtl in Hebrew, ltr in English), so an
 *   empty line has its caret on the right in Hebrew. Older docs saved with "auto" everywhere show right too.
 * List items are left to `ListDirection` (an empty item follows the item before it). The editable area itself
 * gets the base direction from the editor's `attributes` (`editorRootDir`): the core `textDirection` plugin would
 * put `dir="auto"` there.
 */
const ITEMS = new Set(['listItem', 'taskItem']);

/** The `dir` a text block is saved with. */
export const savedDir = (block: PMNode): TextDir | 'auto' => firstStrongDir(block.textContent) ?? 'auto';

/** The steps that save every changed text block's direction (null when nothing changes). */
export const fixBlockDirs = (tr: Transaction): Transaction | null => {
  let changed = false;
  tr.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (!('dir' in node.attrs)) return false;
    const want = savedDir(node);
    if (node.attrs.dir !== want) {
      tr.setNodeAttribute(pos, 'dir', want);
      changed = true;
    }
    return false;
  });
  return changed ? tr : null;
};

/** How every text block outside a list is shown: its own direction, else the base one. */
export const blockDirDecorations = (doc: PMNode, base: TextDir) => {
  const decos: Decoration[] = [];
  const visit = (node: PMNode, pos: number) => {
    if (ITEMS.has(node.type.name)) return;
    if (node.isTextblock) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { dir: firstStrongDir(node.textContent) ?? base }));
      return;
    }
    if (node.isAtom) return;
    node.forEach((child, offset) => visit(child, pos + 1 + offset));
  };
  doc.forEach((child, offset) => visit(child, offset));
  return DecorationSet.create(doc, decos);
};

const KEY = new PluginKey<DecorationSet>('typingDirection');
/** y-prosemirror's sync plugin key: a co-editor's change already carries their (identical) directions. */
const Y_SYNC = 'y-sync$';

export const TypingDirection = Extension.create<{ base: () => TextDir }>({
  name: 'typingDirection',
  addOptions() {
    return { base: () => baseDir() };
  },
  addProseMirrorPlugins() {
    const base = this.options.base;
    return [
      new Plugin<DecorationSet>({
        key: KEY,
        state: {
          init: (_, state) => blockDirDecorations(state.doc, base()),
          apply: (tr, old) => (tr.docChanged ? blockDirDecorations(tr.doc, base()) : old),
        },
        props: {
          decorations: (state) => KEY.getState(state),
        },
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((tr) => tr.docChanged && !tr.getMeta(Y_SYNC))) return null;
          return fixBlockDirs(state.tr);
        },
      }),
    ];
  },
});

/** The editable area's `dir` (pass in `editorProps.attributes`, which win over the core `textDirection`'s "auto"). */
export const editorRootDir = (): TextDir => baseDir();
