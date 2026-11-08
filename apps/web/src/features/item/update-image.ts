// SPDX-License-Identifier: AGPL-3.0-only
import { mergeAttributes, Node, type Editor } from '@tiptap/react';
import { EMAIL_IMAGE_REF } from '@bines/shared';

/**
 * Prod (product owner: "a pasted or uploaded image should sit where it was put, so the text around it explains it")
 * an image of the update inside its text — `{src: "asset:<file id>", alt}`, the same node an incoming email's body
 * images use. The file stays one of the update's files (listed under it as before — no second copy in
 * storage); the server renders the node as a placeholder the app fills through the update's own access check.
 * `srcOf` gives the editor the address to show: a just-pasted image's local preview, an edited update's own file.
 */
export const updateImageRef = (fileId: string) => `asset:${fileId}`;

export const UpdateImage = Node.create<{ srcOf: (ref: string) => string }>({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions: () => ({ srcOf: () => '' }),
  addAttributes: () => ({
    src: { default: null, rendered: false },
    alt: { default: '', rendered: false },
  }),
  parseHTML: () => [
    {
      tag: 'figure[data-type="update-image"]',
      getAttrs: (el) => {
        const src = (el as HTMLElement).dataset.src ?? '';
        return EMAIL_IMAGE_REF.test(src) ? { src, alt: (el as HTMLElement).querySelector('img')?.alt ?? '' } : false;
      },
    },
  ],
  renderHTML({ node, HTMLAttributes }) {
    const ref = String(node.attrs.src ?? '');
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        class: 'rich-image',
        'data-type': 'update-image',
        'data-src': ref,
        'data-testid': 'composer-inline-image',
      }),
      ['img', { src: this.options.srcOf(ref), alt: String(node.attrs.alt ?? ''), draggable: 'false' }],
    ];
  },
});

/**
 * Puts an attached image into the text at `pos` (clamped to the document — it may have changed meanwhile). Returns
 * the position right after it, where the next image of the same paste goes (they keep their order).
 */
export const insertUpdateImage = (editor: Editor, pos: number, file: { id: string; name: string }) => {
  if (editor.isDestroyed) return pos;
  const before = editor.state.doc.content.size;
  const at = Math.max(0, Math.min(pos, before));
  editor
    .chain()
    .insertContentAt(at, { type: 'image', attrs: { src: updateImageRef(file.id), alt: file.name } })
    .run();
  return at + (editor.state.doc.content.size - before);
};

/**
 * The files whose image is in the text now, comma-joined in order (a string, so an editor-state selector can compare
 * it). Prod round 2: an image taken out of the text leaves the update.
 */
export const imageFileIdsInText = (editor: Editor) => {
  const ids: string[] = [];
  editor.state.doc.descendants((n) => {
    const src = n.type.name === 'image' ? String(n.attrs.src ?? '') : '';
    if (src.startsWith('asset:')) ids.push(src.slice('asset:'.length));
  });
  return ids.join(',');
};

/** Takes an image out of the text again (its file was taken off the update). */
export const removeUpdateImage = (editor: Editor, fileId: string) => {
  if (editor.isDestroyed) return;
  const ref = updateImageRef(fileId);
  const { tr } = editor.state;
  const hits: { pos: number; size: number }[] = [];
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === 'image' && n.attrs.src === ref) hits.push({ pos, size: n.nodeSize });
  });
  if (!hits.length) return;
  for (const h of hits.reverse()) tr.delete(h.pos, h.pos + h.size);
  editor.view.dispatch(tr);
};
