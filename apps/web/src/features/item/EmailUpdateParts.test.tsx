// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRichDoc, updateImageOptions } from '@bines/shared';
import { emailImageSrc, EmailFilesLine, inlineImageIds } from './EmailUpdateParts';
import { UpdateBody } from './UpdateBody';

/**
 * an incoming email's images are placeholders in the stored HTML; the app fills them from its own
 * address (a body image through its file, an image from the web through the server), and the files line says what
 * became of the message's files.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});
const show = (el: ReactElement) => {
  root = createRoot(host);
  act(() => root!.render(el));
};

const ASSET = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const html = renderRichDoc(
  {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Weekly' }] },
      { type: 'image', attrs: { src: `asset:${ASSET}`, alt: 'Hero' } },
      { type: 'image', attrs: { src: 'remote:0', alt: 'Banner' } },
      // Not an email image: never shown.
      { type: 'image', attrs: { src: 'https://tracker.test/p.gif' } },
    ],
  },
  updateImageOptions,
).html;

describe('email images in an update', () => {
  it('the stored HTML holds only placeholders; the app fills them from its own address', () => {
    expect(html).not.toContain('tracker.test');
    expect(html.match(/<img/g)).toHaveLength(2);
    const onImage = vi.fn();
    show(<UpdateBody html={html} imageSrc={emailImageSrc('A1', 'U1')} onImage={onImage} />);
    const imgs = [...host.querySelectorAll<HTMLImageElement>('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      `/api/v1/updates/U1/email-images/asset%3A${ASSET}?account_id=A1`,
      '/api/v1/updates/U1/email-images/remote%3A0?account_id=A1',
    ]);
    act(() => imgs[0]!.click());
    expect(onImage).toHaveBeenCalledWith(`asset:${ASSET}`);
    // One that does not load leaves no broken frame.
    act(() => {
      imgs[1]!.dispatchEvent(new Event('error'));
    });
    expect(imgs[1]!.closest('figure')!.hasAttribute('hidden')).toBe(true);
  });

  it('without an image source (not an email) the placeholders stay empty', () => {
    show(<UpdateBody html={html} />);
    expect(host.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/gif/);
  });

  it('knows which files are shown in the text', () => {
    expect([...inlineImageIds(html)]).toEqual([ASSET]);
  });

  it('the files line: attached, and what was not with the reasons', () => {
    show(
      <EmailFilesLine
        files={{
          attached: 2,
          skipped: [
            { name: 'sig.png', reason: 'small_image' },
            { name: 'run.exe', reason: 'type' },
          ],
        }}
      />,
    );
    const line = host.querySelector('[data-testid="update-email-files"]')!;
    expect(line.textContent).toContain('2');
    expect(line.textContent).toMatch(/2 \(/);
    expect(line.querySelector('[data-tip]')!.getAttribute('data-tip')).toBe('sig.png, run.exe');
  });
});
