// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * The on-screen keyboard on a phone: the browser never says it is open, so it is read from what it
 * does. iOS (and Android without `interactive-widget=resizes-content`) shrinks the visual viewport under a layout of
 * the same height; Android with it (index.html) shrinks the window itself. Only the shrinking counts — a focused field
 * alone does not (autofocus brings no keyboard; a tap inside an extension's frame focuses the frame).
 */

/** Below this many CSS pixels a change of height is a browser bar coming and going, not a keyboard. */
export const KEYBOARD_MIN_PX = 120;

/**
 * Is the keyboard open? `viewport`: the visual viewport's height; `layout`: the window's (innerHeight); `tallest`:
 * the tallest window seen at this width (a resizing keyboard shrinks the window itself).
 */
export const keyboardOpen = (s: { viewport: number; layout: number; tallest: number }): boolean =>
  s.layout - s.viewport > KEYBOARD_MIN_PX || s.tallest - s.layout > KEYBOARD_MIN_PX;

/**
 * How tall a frame that starts `top` px from the top of the window may be so that its bottom stays above the keyboard
 * — or null when the keyboard leaves it alone.
 */
export const heightAboveKeyboard = (s: { viewport: number; offsetTop: number; layout: number; top: number }) =>
  s.layout - s.viewport > KEYBOARD_MIN_PX ? Math.max(0, Math.round(s.offsetTop + s.viewport - s.top)) : null;

let tallest = { width: 0, height: 0 };
const read = () => {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth !== tallest.width) tallest = { width: window.innerWidth, height: 0 };
  tallest.height = Math.max(tallest.height, window.innerHeight);
  const vv = window.visualViewport;
  return keyboardOpen({
    viewport: vv?.height ?? window.innerHeight,
    layout: window.innerHeight,
    tallest: tallest.height,
  });
};
const subscribe = (onChange: () => void) => {
  const vv = window.visualViewport;
  vv?.addEventListener('resize', onChange);
  window.addEventListener('resize', onChange);
  // The focus moves before the keyboard animates in or out: read again then, and once it has settled.
  const later = () => {
    onChange();
    window.setTimeout(onChange, 300);
  };
  document.addEventListener('focusin', later);
  document.addEventListener('focusout', later);
  return () => {
    vv?.removeEventListener('resize', onChange);
    window.removeEventListener('resize', onChange);
    document.removeEventListener('focusin', later);
    document.removeEventListener('focusout', later);
  };
};

/** True while the on-screen keyboard is (very likely) open. Every screen; false on the server. */
export const useKeyboardOpen = () => useSyncExternalStore(subscribe, read, () => false);

/**
 * iOS: the height an element (`ref`) may have so its bottom stays above the keyboard (the visual viewport, which the
 * keyboard shrinks while `h-dvh` stays), or null when there is no keyboard.
 */
export const useHeightAboveKeyboard = (ref: { current: HTMLElement | null }) => {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const el = ref.current;
      setHeight(
        el
          ? heightAboveKeyboard({
              viewport: vv.height,
              offsetTop: vv.offsetTop,
              layout: window.innerHeight,
              // Both in the layout viewport's terms: its visible bottom is offsetTop + height.
              top: el.getBoundingClientRect().top,
            })
          : null,
      );
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [ref]);
  return height;
};
