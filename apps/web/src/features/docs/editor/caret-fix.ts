// SPDX-License-Identifier: AGPL-3.0-only
import { Extension } from '@tiptap/react';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Another person's caret at the end of a line is a widget, and ProseMirror follows it with its "hack" nodes (a
 * separator image and a trailing <br>). A click at the end of that line or Ctrl+End puts the browser's caret after
 * them, a DOM position ProseMirror does not read — its own selection stays where it was, and what you type lands
 * there (the start of the doc). Here such a caret is taken as "the end of that block".
 */
const isTail = (n: Node) =>
  n.nodeName === 'BR' ||
  (n instanceof HTMLElement &&
    (n.classList.contains('ProseMirror-separator') || n.classList.contains('ProseMirror-widget')));

const syncTailCaret = (view: EditorView) => {
  const sel = view.dom.ownerDocument.getSelection();
  const at = sel?.anchorNode;
  if (!sel || !sel.isCollapsed || !at || at.nodeType !== Node.ELEMENT_NODE || !view.dom.contains(at)) return;
  const kids = Array.from(at.childNodes);
  const offset = sel.anchorOffset;
  // Only a caret past content, among the widget and the hack nodes that follow it.
  if (offset === 0 || !kids.slice(offset - 1).every(isTail) || kids.every(isTail)) return;
  let start: number;
  try {
    start = view.posAtDOM(at, 0);
  } catch {
    return;
  }
  const $start = view.state.doc.resolve(start);
  if (!$start.parent.isTextblock) return;
  const end = $start.end();
  if (view.state.selection.empty && view.state.selection.from === end) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
};

export const TailCaretFix = Extension.create({
  name: 'tailCaretFix',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('tailCaretFix'),
        props: {
          handleDOMEvents: {
            mouseup: (view) => {
              setTimeout(() => syncTailCaret(view), 0);
              return false;
            },
            keyup: (view, event) => {
              if (['End', 'Home', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key))
                syncTailCaret(view);
              return false;
            },
          },
          handleKeyDown: (view) => {
            // A key pressed before the keyup / mouseup above ran (fast typing right after the click).
            syncTailCaret(view);
            return false;
          },
        },
      }),
    ];
  },
});
