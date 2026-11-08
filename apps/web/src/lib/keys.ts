// SPDX-License-Identifier: AGPL-3.0-only
/** Whether a key press belongs to a field being typed in (text inputs, the rich editor), not to app shortcuts. */
export const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes((el as HTMLInputElement).type);
};

/**
 * Ctrl/⌘ + a letter, on any keyboard layout: with a Hebrew layout `e.key` is the Hebrew letter (Ctrl+F gives
 * "כ"), so the physical key (`e.code`) decides too. Shift and Alt must match `shift` / be up.
 */
export const isModLetter = (e: KeyboardEvent, letter: string, shift = false) =>
  (e.ctrlKey || e.metaKey) &&
  !e.altKey &&
  e.shiftKey === shift &&
  (e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`);

/** Ctrl/⌘+F — on a board page this is the board's own search, never the browser's find bar. */
export const isFindKey = (e: KeyboardEvent) => isModLetter(e, 'f');
