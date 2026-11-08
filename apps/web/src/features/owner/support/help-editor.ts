// SPDX-License-Identifier: AGPL-3.0-only
import { mergeAttributes, Node, type AnyExtension } from '@tiptap/react';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { helpAssetPath } from '@bines/shared';

/**
 * The knowledge center's article editor (kb-import): the shared rich editor plus what only articles may hold — an
 * image (`{src: <help image id>, alt, width?}`, the server keeps it only when the id is a stored help image) and
 * tables (an imported article's GFM tables survive an edit). Updates, replies and doc comments never load these.
 */
export const HelpImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes: () => ({
    src: { default: null, rendered: false },
    alt: { default: '', rendered: false },
    width: { default: null, rendered: false },
  }),
  parseHTML: () => [
    {
      tag: 'figure[data-type="help-image"]',
      getAttrs: (el) => {
        const img = (el as HTMLElement).querySelector('img');
        return {
          src: (el as HTMLElement).dataset.src ?? null,
          alt: img?.getAttribute('alt') ?? '',
          width: Number(img?.getAttribute('width')) || null,
        };
      },
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'figure',
    mergeAttributes(HTMLAttributes, {
      class: 'rich-image',
      'data-type': 'help-image',
      'data-src': node.attrs.src ?? '',
      'data-testid': 'help-image',
    }),
    [
      'img',
      {
        src: node.attrs.src ? helpAssetPath(String(node.attrs.src)) : '',
        alt: String(node.attrs.alt ?? ''),
        ...(node.attrs.width ? { width: String(node.attrs.width) } : {}),
        draggable: 'false',
      },
    ],
  ],
});

export const helpEditorExtensions = (): AnyExtension[] => [
  HelpImage,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
];

/** Image files of a paste / drop / pick (anything else is ignored). */
export const imageFiles = (files: File[]) => files.filter((f) => /^image\/(png|jpe?g|webp|gif)$/i.test(f.type));
