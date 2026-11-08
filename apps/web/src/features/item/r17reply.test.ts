// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/react';
import Mention from '@tiptap/extension-mention';
import { createUpdateSchema, MAX_RICH_TEXT } from '@bines/shared';
import { richFormatExtensions, richStarterKit } from './rich-extensions';
import { sendBlockReason } from './composer-send';

/**
 * Prod "adding a reply to an update — broke": paste → editor document → what the composer sends, with the
 * exact text from the bug report (a few Hebrew lines, console errors, a ~10 KB GlitchTip event JSON) and longer logs.
 */
const PASTED = readFileSync(`${process.cwd()}/../../e2e/fixtures/r17-failed-update.txt`, 'utf8');
/** A 50 KB log — what a pasted error dump easily is. */
const LOG_50K = Array.from({ length: 5 }, () => PASTED).join('\n');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Rich HTML from a JSON viewer: keys bold, strings as code, numbers / literals italic — a node per token. */
const highlighted = (text: string) =>
  `<div>${text
    .split(/\r?\n/)
    .map((l) =>
      l.replace(/("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d[\d.e+-]*|true|false|null)|([^"\d]+)/g, (m, str, colon, lit, rest) => {
        if (str) return colon ? `<b>${esc(str)}</b>${esc(colon)}` : `<code>${esc(str)}</code>`;
        if (lit) return `<i>${esc(lit)}</i>`;
        return esc(rest ?? m);
      }),
    )
    .join('<br>')}</div>`;

let editor: Editor | null = null;
/** The app's update editor (same extensions as useRichEditor). */
const mk = () => {
  editor = new Editor({
    element: document.createElement('div'),
    textDirection: 'auto',
    extensions: [richStarterKit(false), ...richFormatExtensions('…'), Mention],
  });
  return editor;
};
afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** What the composer would send for a reply, and whether the API's schema takes it. */
const payloadOf = (doc: JSONContent) => createUpdateSchema.safeParse({ doc, file_ids: [] });

describe('r17reply: paste → doc → payload', () => {
  it.each([
    ['plain text', (e: Editor) => e.view.pasteText(PASTED)],
    ['HTML <pre>', (e: Editor) => e.view.pasteHTML(`<pre>${esc(PASTED)}</pre>`)],
    ['highlighted HTML', (e: Editor) => e.view.pasteHTML(highlighted(PASTED))],
    [
      'plain text into a code block',
      (e: Editor) => {
        e.commands.setCodeBlock();
        e.view.pasteText(PASTED);
      },
    ],
  ])('the exact pasted text (%s) is sent', (_name, paste) => {
    const e = mk();
    paste(e);
    const doc = e.getJSON();
    expect(e.getText()).toContain('0123456789abcdef0123456789abcdef');
    expect(sendBlockReason(doc)).toBeNull();
    expect(payloadOf(doc).success).toBe(true);
  });

  // Failed before r17reply: 20,000 characters per text node / 200 KB of editor JSON / 5,000 nodes.
  it.each([
    ['plain text', (e: Editor) => e.view.pasteText(LOG_50K)],
    ['highlighted HTML', (e: Editor) => e.view.pasteHTML(highlighted(LOG_50K))],
    [
      'plain text into a code block',
      (e: Editor) => {
        e.commands.setCodeBlock();
        e.view.pasteText(LOG_50K);
      },
    ],
  ])(
    'a 50 KB log (%s) is sent',
    (_name, paste) => {
      const e = mk();
      paste(e);
      const doc = e.getJSON();
      // (HTML collapses the indentation, so a little less text arrives.)
      expect(e.getText().length).toBeGreaterThan(35_000);
      expect(sendBlockReason(doc)).toBeNull();
      const r = payloadOf(doc);
      expect(r.success, r.success ? '' : JSON.stringify(r.error.issues).slice(0, 300)).toBe(true);
      // Pasting 50 KB into the editor in jsdom is CPU work: seconds when the machine is busy (5 s default timed out).
    },
    20_000,
  );

  it('past the limit, the composer says so (with the limit) instead of sending', () => {
    const e = mk();
    e.commands.setCodeBlock();
    e.view.pasteText('x'.repeat(MAX_RICH_TEXT + 1));
    // i18n keys are merged by the lead; until then t() returns the key.
    expect(sendBlockReason(e.getJSON())).toMatch(/update_too_long|100,000/);
  });
});
