// SPDX-License-Identifier: AGPL-3.0-only
import { Extension } from '@tiptap/react';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { DOC_ID_BLOCKS } from '@bines/shared';
import { presencePrefs, subscribePresencePrefs } from '../presence-prefs';

/**
 * Live presence in docs: each person announces (awareness) the block their caret is in and whether they
 * are typing now; everyone else sees that block lit in the person's caret colour. The carets themselves (and what
 * is typed, live) come from the collaboration extensions; this adds "where" at a glance.
 */

/** The awareness fields this plugin writes. */
export type PresenceState = { block?: string | null; typing?: boolean };

/** Typing stops counting after this long without a change. */
export const TYPING_IDLE_MS = 2500;

type Awareness = {
  clientID: number;
  getStates: () => Map<number, Record<string, unknown>>;
  getLocalState: () => Record<string, unknown> | null;
  setLocalStateField: (field: string, value: unknown) => void;
  on: (event: 'change', cb: () => void) => void;
  off: (event: 'change', cb: () => void) => void;
};

const ID_BLOCKS = new Set<string>(DOC_ID_BLOCKS);
const key = new PluginKey<DecorationSet>('docPresence');

/** The innermost block with an id around the selection head (the line someone stands on). */
export const blockAt = (state: EditorState): string | null => {
  const $head = state.selection.$head;
  for (let d = $head.depth; d > 0; d--) {
    const node = $head.node(d);
    if (ID_BLOCKS.has(node.type.name) && typeof node.attrs.id === 'string') return node.attrs.id;
  }
  // A selected block (an image, an embed) is not an ancestor of the head.
  const picked = (state.selection as { node?: PMNode }).node;
  return picked && ID_BLOCKS.has(picked.type.name) && typeof picked.attrs.id === 'string' ? picked.attrs.id : null;
};

/** The others' blocks: block id → the people in it (one colour shows; the names go to the tooltip). */
export const peerBlocks = (awareness: Pick<Awareness, 'clientID' | 'getStates'>) => {
  const out = new Map<string, { color: string; names: string[]; typing: boolean }>();
  const seen = new Set<string>();
  for (const [clientId, s] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;
    const user = s.user as { name?: string; color?: string; id?: string } | undefined;
    const block = typeof s.block === 'string' ? s.block : null;
    if (!user?.name || !block) continue;
    // Two tabs of one person in one block: once.
    const who = `${user.id ?? user.name}:${block}`;
    if (seen.has(who)) continue;
    seen.add(who);
    const at = out.get(block);
    if (at) {
      at.names.push(user.name);
      at.typing ||= s.typing === true;
    } else out.set(block, { color: user.color ?? 'currentColor', names: [user.name], typing: s.typing === true });
  }
  return out;
};

const decorate = (doc: PMNode, awareness: Awareness) => {
  if (!presencePrefs().showOthers) return DecorationSet.empty;
  const blocks = peerBlocks(awareness);
  if (!blocks.size) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    const at = typeof node.attrs.id === 'string' ? blocks.get(node.attrs.id) : undefined;
    if (at && ID_BLOCKS.has(node.type.name)) {
      decos.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: at.typing ? 'doc-peer-block doc-peer-typing' : 'doc-peer-block',
          style: `--peer: ${at.color}`,
          'data-peer': at.names.join(', '),
        }),
      );
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
};

export const DocPresence = Extension.create<{ awareness: Awareness | null }>({
  name: 'docPresence',
  addOptions: () => ({ awareness: null }),
  addProseMirrorPlugins() {
    const awareness = this.options.awareness;
    if (!awareness) return [];
    let onLocalEdit: () => void = () => undefined;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorate(state.doc, awareness),
          apply: (tr, old) => (tr.getMeta(key) || tr.docChanged ? decorate(tr.doc, awareness) : old),
        },
        props: { decorations: (state) => key.getState(state) },
        // My own edits only: a remote change (or the Yjs binding's own) is not me typing.
        appendTransaction: (trs) => {
          if (trs.some((tr) => tr.docChanged && !isChangeOrigin(tr) && !tr.getMeta(key))) onLocalEdit();
          return null;
        },
        view: (view) => {
          let typingTimer: ReturnType<typeof setTimeout> | undefined;
          const announce = (state: EditorState) => {
            const block = presencePrefs().shareMine && view.hasFocus() ? blockAt(state) : null;
            if ((awareness.getLocalState()?.block ?? null) !== block) awareness.setLocalStateField('block', block);
          };
          const typing = (on: boolean) => {
            if ((awareness.getLocalState()?.typing === true) !== on) awareness.setLocalStateField('typing', on);
          };
          // Only when the others' blocks change (a caret moving inside a block re-draws nothing). Asynchronous: a
          // refresh may not be dispatched from inside another dispatch.
          let shown = '';
          let queued = false;
          const refresh = () => {
            if (queued) return;
            queued = true;
            queueMicrotask(() => {
              queued = false;
              if (view.isDestroyed) return;
              const next = presencePrefs().showOthers ? JSON.stringify([...peerBlocks(awareness)]) : '';
              if (next === shown) return;
              shown = next;
              view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false));
            });
          };
          onLocalEdit = () => {
            if (!presencePrefs().shareMine || !view.hasFocus()) return;
            typing(true);
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => typing(false), TYPING_IDLE_MS);
          };
          const onPrefs = () => {
            announce(view.state);
            if (!presencePrefs().shareMine) typing(false);
            refresh();
          };
          const onBlur = () => {
            announce(view.state);
            typing(false);
          };
          const onFocus = () => announce(view.state);
          awareness.on('change', refresh);
          const offPrefs = subscribePresencePrefs(onPrefs);
          view.dom.addEventListener('blur', onBlur);
          view.dom.addEventListener('focus', onFocus);
          return {
            update: (v, prev) => {
              if (!v.state.selection.eq(prev.selection) || v.state.doc !== prev.doc) announce(v.state);
            },
            destroy: () => {
              clearTimeout(typingTimer);
              onLocalEdit = () => undefined;
              awareness.off('change', refresh);
              offPrefs();
              view.dom.removeEventListener('blur', onBlur);
              view.dom.removeEventListener('focus', onFocus);
            },
          };
        },
      }),
    ];
  },
});
