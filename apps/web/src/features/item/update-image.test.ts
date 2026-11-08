// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/react';
import { renderRichDoc, updateImageOptions, type RichNode } from '@bines/shared';
import { richFormatExtensions, richStarterKit } from './rich-extensions';
import { imageFileIdsInText, insertUpdateImage, removeUpdateImage, UpdateImage } from './update-image';

/** a pasted / uploaded image sits in the update's text where it was put. */
let editor: Editor | null = null;
const mk = (html: string) => {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      richStarterKit(false),
      ...richFormatExtensions('…'),
      UpdateImage.configure({ srcOf: (ref) => `blob:${ref}` }),
    ],
    content: html,
  });
  return editor;
};
afterEach(() => {
  editor?.destroy();
  editor = null;
});
const F1 = '01HFAKE0000000000000000041';
const F2 = '01HFAKE0000000000000000042';

describe('an image in the update text', () => {
  it('goes in at the caret, a second one after the first, and renders as the server does', () => {
    const e = mk('<p>לפני</p><p>אחרי</p>');
    const end = e.state.doc.child(0).nodeSize; // between the two lines
    const next = insertUpdateImage(e, end, { id: F1, name: 'a.png' });
    insertUpdateImage(e, next, { id: F2, name: 'b.png' });
    const doc = e.getJSON();
    expect(doc.content!.map((n) => n.type)).toEqual(['paragraph', 'image', 'image', 'paragraph']);
    expect(doc.content![1]!.attrs).toEqual({ src: `asset:${F1}`, alt: 'a.png' });
    expect(e.view.dom.querySelector('img')!.getAttribute('src')).toBe(`blob:asset:${F1}`);
    const { html } = renderRichDoc(doc as RichNode, updateImageOptions);
    expect(html).toMatch(new RegExp(`<p>לפני</p><figure class="rich-image"><img [^>]*data-image-ref="asset:${F1}"`));
  });

  it('a position past the end (the text shrank meanwhile) lands at the end', () => {
    const e = mk('<p>x</p>');
    insertUpdateImage(e, 999, { id: F1, name: 'a.png' });
    // (the editor keeps an empty line after it to go on typing)
    expect(e.getJSON().content!.map((n) => n.type)).toEqual(['paragraph', 'image', 'paragraph']);
  });

  it('comes out of the text when its file is taken off', () => {
    const e = mk('<p>x</p>');
    insertUpdateImage(e, 3, { id: F1, name: 'a.png' });
    insertUpdateImage(e, 3, { id: F2, name: 'b.png' });
    removeUpdateImage(e, F1);
    const images = e.getJSON().content!.filter((n) => n.type === 'image');
    expect(images.map((n) => n.attrs!.src)).toEqual([`asset:${F2}`]);
  });

  it('lists the files whose image is in the text, in order (round 2: one deleted from the text leaves the update)', () => {
    const e = mk('<p>x</p>');
    expect(imageFileIdsInText(e)).toBe('');
    insertUpdateImage(e, 3, { id: F1, name: 'a.png' });
    insertUpdateImage(e, 3, { id: F2, name: 'b.png' });
    expect(imageFileIdsInText(e)).toBe(`${F2},${F1}`);
    removeUpdateImage(e, F2);
    expect(imageFileIdsInText(e)).toBe(F1);
  });
});
