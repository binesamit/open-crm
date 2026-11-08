// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';
import { dirOf, firstStrongDir, getLocale, subscribeLocale, type Locale } from '@bines/shared';

/**
 * Typing direction (prod fix "rtltype": "in RTL, typing starts on the right unless what is typed is
 * English"). One rule for every text field and rich editor in the app:
 *
 * - empty, or only neutral characters (digits, spaces, punctuation, emoji) → the UI's base direction
 *   (rtl in Hebrew, ltr in English — from the UI language, never from the text's language);
 * - otherwise → the direction of the first strong letter (Hebrew / Arabic… → rtl, Latin / anything else → ltr).
 *
 * `dir="auto"` alone is not enough: an empty `dir="auto"` element is left-to-right, so the caret sat on the left
 * until the first Hebrew letter arrived.
 */
export type TextDir = 'rtl' | 'ltr';

/** The direction of a text by its first strong letter (shared with the server); null when it has none. */
export { firstStrongDir };

/** The app's base direction for a UI language (default: the current one). */
export const baseDir = (locale: Locale = getLocale()): TextDir => dirOf(locale);

/** A text field's direction: its first strong letter's, else (empty / neutral) the base direction. */
export const fieldDir = (value: unknown, base: TextDir = baseDir()): TextDir =>
  (typeof value === 'string' || typeof value === 'number' ? firstStrongDir(String(value)) : null) ?? base;

/** The base direction; components re-render when the UI language changes. */
export const useTextDir = (): TextDir => useSyncExternalStore(subscribeLocale, baseDir, baseDir);

/** Input types that hold free text (and so follow the typing direction). email / url / password / number… stay ltr. */
const TEXT_TYPES = new Set(['', 'text', 'search']);
export const isTextInputType = (type: string | null | undefined) => TEXT_TYPES.has((type ?? '').toLowerCase());

/** Marks a field whose `dir` this module set (so an author's own `dir="ltr"` is never touched). */
const MARK = 'data-autodir';

/**
 * Whether a field follows the typing direction: a text `<input>` / `<textarea>` whose author gave no fixed
 * direction (no `dir`, or `dir="auto"`), or one already managed here.
 */
export const followsTypingDir = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => {
  if (typeof HTMLInputElement === 'undefined') return false;
  const text =
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && isTextInputType(el.getAttribute('type')));
  if (!text) return false;
  if (el.hasAttribute(MARK)) return true;
  const dir = el.getAttribute('dir');
  return dir === null || dir === '' || dir === 'auto';
};

/** Sets a field's `dir` from its current value (no-op for fields with a fixed direction). */
export const syncFieldDir = (el: Element, base: TextDir = baseDir()) => {
  if (!followsTypingDir(el)) return;
  const dir = fieldDir(el.value, base);
  if (el.getAttribute('dir') !== dir) el.setAttribute('dir', dir);
  if (!el.hasAttribute(MARK)) el.setAttribute(MARK, '');
};

/**
 * Applies the rule to every text field in `root`, without touching each screen: on focus (an existing value),
 * while typing, and after key up / clicks (a field cleared by its own Enter / Escape / clear button). Fields
 * rendered through the shared `Input` get it at render too. Returns the uninstaller.
 */
export const installTypingDir = (root: Document | HTMLElement = document) => {
  const doc = root instanceof Document ? root : root.ownerDocument;
  const onEvent = (e: Event) => {
    if (e.target instanceof Element) syncFieldDir(e.target);
    // A field cleared by the screen's own handler (Enter sends, Esc / an "X" clears) changes after this capture
    // listener: check the focused field again once the event is done.
    setTimeout(() => {
      if (doc.activeElement) syncFieldDir(doc.activeElement);
    }, 0);
  };
  const events = ['focusin', 'input', 'keyup', 'click'] as const;
  for (const name of events) root.addEventListener(name, onEvent, true);
  return () => {
    for (const name of events) root.removeEventListener(name, onEvent, true);
  };
};
