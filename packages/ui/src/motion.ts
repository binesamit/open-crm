// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef, type RefObject } from 'react';

/**
 * r16motion — exit animations for dialogs, menus, popovers and toasts (product decision: "subtle things only").
 *
 * The element itself unmounts at once, exactly as before (state, focus, tests and the layer stack never see a
 * "closing" phase). On its way out a frozen copy (a "ghost") is laid over the same spot and fades away in 120–160ms:
 * inert, aria-hidden, no pointer events, stripped of ids / test ids / roles, removed right after. Only when the
 * interface's animations are `full` (`<html data-motion>`, see the app's appearance settings) — reduced and off
 * close instantly.
 */
export type MotionLevel = 'full' | 'reduced' | 'off';

/** The animations in effect: `<html data-motion>`, else the device's reduced-motion setting. */
export const motionMode = (root: HTMLElement = document.documentElement): MotionLevel => {
  const v = root.getAttribute('data-motion');
  if (v === 'full' || v === 'reduced' || v === 'off') return v;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'reduced'
    : 'full';
};

/**
 * How to scroll something into view (WCAG 2.3.3): smooth only while animations are `full` — reduced
 * and off jump straight there.
 */
export const scrollBehavior = (): ScrollBehavior => (motionMode() === 'full' ? 'smooth' : 'auto');

/** Entrance class → exit class of the ghost (styles.css). Anything else does not get an exit. */
const EXITS = new Map([
  ['anim-scrim', 'exit-scrim'],
  ['anim-dialog', 'exit-dialog'],
  ['anim-pop', 'exit-pop'],
  ['anim-toast', 'exit-toast'],
]);
/** The longest exit (160ms) and a margin: the ghost is gone after this whatever happens. */
const GHOST_MS = 220;
/** Mounted and gone again within this time (a re-render, StrictMode): no exit. */
const MIN_AGE_MS = 40;

const STRIP = ['id', 'data-testid', 'role', 'name', 'aria-modal', 'aria-live', 'data-modal-root', 'autofocus'];

/** Lays the frozen copy of `node` (still in the page) over its spot and lets it fade out. */
export const playExit = (node: HTMLElement) => {
  if (!node.isConnected || motionMode() !== 'full') return;
  const all = [node, ...Array.from(node.querySelectorAll<HTMLElement>('*'))];
  if (!all.some((el) => Array.from(el.classList).some((c) => EXITS.has(c)))) return;
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ghost = node.cloneNode(true) as HTMLElement;
  const copies = [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>('*'))];
  // Scroll offsets are not cloned: remember them (same order in both trees) and put them back once inserted.
  const scrolled = all.flatMap((el, i) => (el.scrollTop || el.scrollLeft ? [[i, el.scrollTop, el.scrollLeft]] : []));
  for (const el of copies) {
    for (const attr of STRIP) el.removeAttribute(attr);
    for (const c of Array.from(el.classList)) {
      const exit = EXITS.get(c);
      if (exit) el.classList.replace(c, exit);
    }
    // An embedded page or media would load again.
    if (el instanceof HTMLIFrameElement || el instanceof HTMLMediaElement) {
      el.removeAttribute('src');
      el.removeAttribute('srcdoc');
    }
  }
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  ghost.setAttribute('data-motion-ghost', '');
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    pointerEvents: 'none',
    visibility: 'visible',
  });
  document.body.appendChild(ghost);
  for (const [i, top, left] of scrolled) {
    const el = copies[i!];
    if (el) {
      el.scrollTop = top!;
      el.scrollLeft = left!;
    }
  }
  setTimeout(() => ghost.remove(), GHOST_MS);
};

/**
 * A ref for the root of a dialog / menu / popover / toast that plays its exit when it unmounts (a stable callback:
 * React calls it with null only then — while the element is still in the page). Pass the component's own ref
 * object to keep it filled.
 */
export const useExitRef = <T extends HTMLElement>(own?: RefObject<T | null>) => {
  const ownRef = useRef(own);
  ownRef.current = own;
  const mounted = useRef<{ node: T; at: number } | null>(null);
  return useCallback((node: T | null) => {
    if (ownRef.current) (ownRef.current as { current: T | null }).current = node;
    if (node) {
      mounted.current = { node, at: performance.now() };
      return;
    }
    const prev = mounted.current;
    mounted.current = null;
    if (prev && performance.now() - prev.at > MIN_AGE_MS) playExit(prev.node);
  }, []);
};
