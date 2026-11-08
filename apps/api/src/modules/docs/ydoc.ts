// SPDX-License-Identifier: AGPL-3.0-only
import * as Y from 'yjs';
import { DOC_FRAGMENT, docAssetIds, docPlainText, type RichNode } from '@bines/shared';

/**
 * A doc's Yjs state ⇄ ProseMirror JSON, in the encoding y-prosemirror / Tiptap's Collaboration use (an element per
 * node named after its type with the node's attrs, an XmlText per run of text whose formatting attributes are the
 * marks). Written here over plain `yjs` so the API does not need ProseMirror itself.
 */

type Delta = { insert?: unknown; attributes?: Record<string, unknown> }[];

/** y-prosemirror keys overlapping marks of one type as `type--hash`. */
const markType = (key: string) => key.split('--')[0]!;

const serialize = (item: Y.XmlElement | Y.XmlText | Y.XmlHook): RichNode[] => {
  if (item instanceof Y.XmlText) {
    return (item.toDelta() as Delta)
      .filter((d) => typeof d.insert === 'string' && d.insert.length)
      .map((d) => {
        const node: RichNode = { type: 'text', text: d.insert as string };
        if (d.attributes && Object.keys(d.attributes).length) {
          node.marks = Object.entries(d.attributes).map(([key, attrs]) => {
            const a = attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : {};
            return Object.keys(a).length ? { type: markType(key), attrs: a } : { type: markType(key) };
          });
        }
        return node;
      });
  }
  if (item instanceof Y.XmlElement) {
    const node: RichNode = { type: item.nodeName };
    const attrs = item.getAttributes() as Record<string, unknown>;
    if (Object.keys(attrs).length) node.attrs = attrs;
    const children = item.toArray().flatMap((c) => serialize(c as Y.XmlElement | Y.XmlText));
    if (children.length) node.content = children;
    return [node];
  }
  return [];
};

/** The doc's ProseMirror JSON (`{ type: 'doc', content }`). */
export const ydocToJson = (ydoc: Y.Doc, field = DOC_FRAGMENT): RichNode => ({
  type: 'doc',
  content: ydoc
    .getXmlFragment(field)
    .toArray()
    .flatMap((c) => serialize(c as Y.XmlElement | Y.XmlText)),
});

const marksToAttributes = (marks: RichNode['marks']) =>
  Object.fromEntries((marks ?? []).map((m) => [m.type, m.attrs ?? {}]));

/** Fills `parent` with `nodes`: each run of text nodes becomes one XmlText, its marks the formatting. */
const fill = (parent: Y.XmlFragment | Y.XmlElement, nodes: RichNode[]) => {
  type Group = { node: RichNode } | { runs: { text: string; attrs: Record<string, unknown> }[] };
  const groups: Group[] = [];
  for (const n of nodes) {
    if (n.type !== 'text') {
      groups.push({ node: n });
      continue;
    }
    const run = { text: n.text ?? '', attrs: marksToAttributes(n.marks) };
    const last = groups[groups.length - 1];
    if (last && 'runs' in last) last.runs.push(run);
    else groups.push({ runs: [run] });
  }
  // Attach first: Yjs types are filled once they are part of the doc.
  const children = groups.map((g) => ('node' in g ? new Y.XmlElement(g.node.type) : new Y.XmlText()));
  parent.insert(parent.length, children);
  groups.forEach((g, i) => {
    const child = children[i]!;
    if ('node' in g) {
      const el = child as Y.XmlElement;
      for (const [k, v] of Object.entries(g.node.attrs ?? {}))
        if (v !== null && v !== undefined) el.setAttribute(k, v as string);
      if (g.node.content?.length) fill(el, g.node.content);
      return;
    }
    let at = 0;
    for (const run of g.runs) {
      if (!run.text) continue;
      (child as Y.XmlText).insert(at, run.text, run.attrs);
      at += run.text.length;
    }
  });
};

/** A new Y.Doc holding `json` (a doc made from content: duplicate of an old row, an import, a template). */
export const jsonToYdoc = (json: RichNode, field = DOC_FRAGMENT): Y.Doc => {
  const ydoc = new Y.Doc();
  ydoc.transact(() => fill(ydoc.getXmlFragment(field), json.content ?? []));
  return ydoc;
};

/** What a save stores next to the state. */
export const deriveDoc = (ydoc: Y.Doc) => {
  const content = ydocToJson(ydoc);
  return { content, text: docPlainText(content), assetIds: docAssetIds(content) };
};

export const encodeState = (ydoc: Y.Doc) => Y.encodeStateAsUpdate(ydoc);

/** A Y.Doc from a stored state (empty when there is none). */
export const decodeState = (state: Uint8Array | null | undefined): Y.Doc => {
  const ydoc = new Y.Doc();
  if (state?.length) Y.applyUpdate(ydoc, state);
  return ydoc;
};
